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
    } else if (update.status === 'connected') {
      // Auto-allow the connected phone number
      if (update.phoneNumber) {
        eventRouter.setConnectedPhone(update.phoneNumber);
      }
      await alertService.send({
        level: alertService.ALERT_LEVELS.INFO,
        event: 'baileys_connected',
        title: 'WhatsApp Connected',
        message: `Connected to WhatsApp as ${update.phoneNumber || 'unknown'}`,
        details: {
          phoneNumber: update.phoneNumber
        }
      });
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
 * Stop Baileys connection
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
