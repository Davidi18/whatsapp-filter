/**
 * Connection event handlers
 * Handles: CONNECTION_UPDATE, QRCODE_UPDATED, LOGOUT_INSTANCE, REMOVE_INSTANCE, APPLICATION_STARTUP
 */

const alertService = require('../services/alerts');
const connectionService = require('../services/connection');
const statsService = require('../services/stats');
const logger = require('../utils/logger');

/**
 * Handle CONNECTION_UPDATE - Connection status change
 */
async function handleUpdate(payload, context) {
  statsService.increment('CONNECTION_UPDATE', 'total');

  // Evolution API can send state in different fields
  const state = payload.state || payload.status || payload.connection;
  const previousState = connectionService.getStatus();

  // Update connection state
  const result = connectionService.updateStatus(state, {
    reason: payload.reason,
    phoneNumber: payload.phoneNumber || payload.owner
  });

  statsService.logEvent({
    event: 'CONNECTION_UPDATE',
    action: 'processed',
    details: {
      previousState,
      newState: result.newStatus,
      changed: result.changed
    }
  });

  // Only send alerts if state actually changed
  if (!result.changed) {
    return { action: 'processed', state: result.newStatus, changed: false };
  }

  // Determine if we need to alert
  const { STATES } = connectionService;

  if (result.newStatus === STATES.CONNECTED) {
    if (previousState !== STATES.CONNECTED) {
      // Reconnected!
      await alertService.send({
        level: alertService.ALERT_LEVELS.INFO,
        event: 'connection_connected',
        title: 'WhatsApp Connected',
        message: 'WhatsApp connection restored.',
        details: {
          previousState,
          newState: result.newStatus
        },
        actions: [
          { label: 'View Dashboard', url: '/' }
        ]
      });
    }
  } else if (result.newStatus === STATES.DISCONNECTED) {
    // Disconnected - critical alert
    await alertService.send({
      level: alertService.ALERT_LEVELS.CRITICAL,
      event: 'connection_disconnected',
      title: 'WhatsApp Disconnected!',
      message: 'WhatsApp connection lost. May require QR code scan.',
      details: {
        previousState,
        newState: result.newStatus,
        reason: payload.reason || 'unknown'
      },
      actions: [
        { label: 'View Dashboard', url: '/' },
        { label: 'View QR Code', url: '/api/qrcode' }
      ]
    });
  } else if (result.newStatus === STATES.CONNECTING) {
    await alertService.send({
      level: alertService.ALERT_LEVELS.WARNING,
      event: 'connection_connecting',
      title: 'WhatsApp Reconnecting',
      message: 'Attempting to reconnect to WhatsApp...',
      details: {
        previousState,
        newState: result.newStatus
      }
    });
  }

  return { action: 'processed', state: result.newStatus, changed: true };
}

/**
 * Handle QRCODE_UPDATED - New QR code generated
 */
async function handleQRCode(payload, context) {
  statsService.increment('QRCODE_UPDATED', 'total');

  // Extract QR code - Evolution API can send in different formats
  const qrCode = payload.qrcode || payload.base64 || payload.code;

  // Store QR code
  connectionService.setQRCode(qrCode);

  statsService.logEvent({
    event: 'QRCODE_UPDATED',
    action: 'qr_stored'
  });

  // Critical alert - need to scan!
  await alertService.send({
    level: alertService.ALERT_LEVELS.CRITICAL,
    event: 'qrcode_needed',
    title: 'QR Code Scan Required!',
    message: 'A new QR code was generated. Please scan to reconnect WhatsApp.',
    details: {
      qrCodeAvailable: true
    },
    actions: [
      { label: 'View QR Code', url: '/api/qrcode' },
      { label: 'View Dashboard', url: '/' }
    ]
  });

  return { action: 'qr_stored' };
}

/**
 * Handle LOGOUT_INSTANCE - Logged out from WhatsApp
 */
async function handleLogout(payload, context) {
  statsService.increment('LOGOUT_INSTANCE', 'total');

  connectionService.updateStatus('logged_out', {
    reason: 'logged_out'
  });

  statsService.logEvent({
    event: 'LOGOUT_INSTANCE',
    action: 'alert_sent'
  });

  await alertService.send({
    level: alertService.ALERT_LEVELS.CRITICAL,
    event: 'logout',
    title: 'WhatsApp Logged Out!',
    message: 'The WhatsApp session was logged out. Re-authentication required.',
    details: {
      instance: payload.instance || process.env.INSTANCE_NAME
    },
    actions: [
      { label: 'View Dashboard', url: '/' },
      { label: 'View QR Code', url: '/api/qrcode' }
    ]
  });

  return { action: 'alert_sent' };
}

/**
 * Handle REMOVE_INSTANCE - Instance deleted
 */
async function handleRemove(payload, context) {
  statsService.increment('REMOVE_INSTANCE', 'total');

  statsService.logEvent({
    event: 'REMOVE_INSTANCE',
    action: 'alert_sent'
  });

  await alertService.send({
    level: alertService.ALERT_LEVELS.CRITICAL,
    event: 'instance_removed',
    title: 'Instance Removed!',
    message: 'The WhatsApp instance was removed from Evolution API.',
    details: {
      instance: payload.instance || process.env.INSTANCE_NAME
    }
  });

  return { action: 'alert_sent' };
}

/**
 * Handle APPLICATION_STARTUP - App started
 */
async function handleStartup(payload, context) {
  statsService.increment('APPLICATION_STARTUP', 'total');

  logger.info('Evolution API started', { payload });

  statsService.logEvent({
    event: 'APPLICATION_STARTUP',
    action: 'logged'
  });

  return { action: 'logged' };
}

module.exports = {
  handleUpdate,
  handleQRCode,
  handleLogout,
  handleRemove,
  handleStartup
};
