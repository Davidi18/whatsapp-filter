/**
 * Baileys Events Handler
 * Bridges Baileys events to the existing event router
 */

const eventRouter = require('./index');
const baileysService = require('../services/baileys');
const connectionService = require('../services/connection');
const alertService = require('../services/alerts');
const logger = require('../utils/logger');

/**
 * Initialize Baileys event handlers
 */
function initialize() {
  if (!baileysService.isEnabled()) {
    logger.info('Baileys mode is disabled');
    return false;
  }

  logger.info('Initializing Baileys event handlers');

  // WhatsApp routinely closes the socket (session refresh ~every 50min,
  // restartRequired, stream errors) and Baileys silently reconnects within
  // seconds. Only alert "Connected" when the user actually saw an outage:
  // the first connection after startup, or after a disconnect alert was sent.
  let sentFirstConnectedAlert = false;
  let outageAlertSent = false;

  // Handle incoming messages from Baileys
  baileysService.onMessage(async (payload) => {
    try {
      const event = payload.event || 'MESSAGES_UPSERT';

      logger.debug('Baileys message received', {
        event,
        remoteJid: payload.data?.key?.remoteJid,
        fromMe: payload.data?.key?.fromMe
      });

      // Route through existing event router
      await eventRouter.routeEvent(event, payload, {
        source: 'baileys',
        instance: 'baileys-direct'
      });
    } catch (error) {
      logger.error('Failed to process Baileys message', { error: error.message });
    }
  });

  // Handle connection changes
  baileysService.onConnectionChange(async (update) => {
    logger.info('Baileys connection change', update);

    // Map Baileys status to connection service format
    const statusMap = {
      'connected': 'connected',
      'connecting': 'connecting',
      'disconnected': 'disconnected',
      'waiting_qr': 'connecting',
      'error': 'disconnected'
    };

    const mappedStatus = statusMap[update.status] || 'unknown';

    // Update connection service
    connectionService.updateStatus(mappedStatus, {
      phoneNumber: update.phoneNumber || null,
      reason: update.reason || 'baileys'
    });

    // Store QR code if available
    if (update.qrCode) {
      connectionService.setQRCode({
        base64: update.qrCode,
        instance: 'baileys-direct'
      });
    }

    // Send alerts for important status changes
    if (update.status === 'disconnected' && !update.willReconnect) {
      outageAlertSent = true;
      await alertService.send({
        level: alertService.ALERT_LEVELS.CRITICAL,
        event: 'baileys_disconnected',
        title: 'WhatsApp Disconnected',
        message: `Baileys connection lost: ${update.reason || 'Unknown reason'}`,
        details: {
          reason: update.reason,
          willReconnect: update.willReconnect
        }
      });
    } else if (update.repairJustDetected) {
      // WhatsApp is refusing the handshake itself (405/403). Retrying can't fix
      // an invalid device link - the user has to pair again.
      outageAlertSent = true;
      const staleVersionNote = update.staleVersionSuspected
        ? ' The WA protocol version could not be looked up, so the outdated one bundled with Baileys was used - WhatsApp answers 405 for old versions. Allow outbound access to web.whatsapp.com, upgrade @whiskeysockets/baileys, or set BAILEYS_WA_VERSION.'
        : ' Most likely the device link is no longer valid - open the UI, log out and pair again. It can also be WhatsApp rate-limiting this server IP.';
      await alertService.send({
        level: alertService.ALERT_LEVELS.CRITICAL,
        event: 'baileys_requires_repair',
        title: 'WhatsApp Refusing Connection',
        message: `WhatsApp rejected the connection ${update.consecutiveRejections} times in a row (code ${update.statusCode}).${staleVersionNote} Retries continue in the background at a slow interval.`,
        details: {
          statusCode: update.statusCode,
          consecutiveRejections: update.consecutiveRejections,
          staleVersionSuspected: !!update.staleVersionSuspected,
          nextAttemptInMinutes: Math.round((update.nextAttemptInMs || 0) / 60000)
        }
      });
    } else if (update.enteredSlowRetry) {
      // Fast reconnect attempts exhausted - connection is down and only
      // retrying every few minutes now. The user should know about this.
      outageAlertSent = true;
      await alertService.send({
        level: alertService.ALERT_LEVELS.CRITICAL,
        event: 'baileys_reconnect_failing',
        title: 'WhatsApp Reconnection Failing',
        message: `Lost the WhatsApp connection and fast reconnect attempts failed (reason: ${update.reason || 'unknown'}${update.statusCode ? `, code ${update.statusCode}` : ''}). Now retrying every few minutes - check the server and QR status.`,
        details: {
          reason: update.reason,
          statusCode: update.statusCode || null,
          status: 'slow_retry',
          nextAttemptInMinutes: update.nextAttemptInMs
            ? Math.round(update.nextAttemptInMs / 60000)
            : null
        }
      });
    } else if (update.status === 'connected') {
      // Auto-allow the connected phone number
      if (update.phoneNumber) {
        eventRouter.setConnectedPhone(update.phoneNumber);
      }

      // Routine reconnects (session refresh, transient drops) should be
      // silent - the user was never told anything was wrong.
      if (!sentFirstConnectedAlert || outageAlertSent) {
        sentFirstConnectedAlert = true;
        outageAlertSent = false;
        await alertService.send({
          level: alertService.ALERT_LEVELS.INFO,
          event: 'baileys_connected',
          title: 'WhatsApp Connected',
          message: `Connected to WhatsApp as ${update.phoneNumber || 'unknown'}`,
          details: {
            phoneNumber: update.phoneNumber
          }
        });
      } else {
        logger.info('Baileys reconnected (routine, no alert)', {
          phoneNumber: update.phoneNumber
        });
      }
    }
  });

  return true;
}

/**
 * Start Baileys connection
 */
async function start() {
  if (!baileysService.isEnabled()) {
    return false;
  }

  try {
    logger.info('Starting Baileys connection...');
    const connected = await baileysService.connect();
    return connected;
  } catch (error) {
    logger.error('Failed to start Baileys', { error: error.message });
    return false;
  }
}

/**
 * Stop the Baileys connection (shutdown path).
 * Must NOT log out: a logout on SIGTERM unlinks the device on WhatsApp's side,
 * so the creds left on disk are dead and the next boot gets refused (405).
 */
async function stop() {
  try {
    await baileysService.disconnect();
    logger.info('Baileys disconnected');
  } catch (error) {
    logger.error('Failed to stop Baileys', { error: error.message });
  }
}

module.exports = {
  initialize,
  start,
  stop
};
