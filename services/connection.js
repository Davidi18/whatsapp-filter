/**
 * Connection state management service
 */

const logger = require('../utils/logger');

const HISTORY_LIMIT = 20;

// Connection states
const STATES = {
  UNKNOWN: 'unknown',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  LOGGED_OUT: 'logged_out'
};

// Map Evolution API states to our states
const STATE_MAP = {
  'open': STATES.CONNECTED,
  'connected': STATES.CONNECTED,
  'connecting': STATES.CONNECTING,
  'close': STATES.DISCONNECTED,
  'disconnected': STATES.DISCONNECTED,
  'logged_out': STATES.LOGGED_OUT,
  'logout': STATES.LOGGED_OUT
};

let connectionState = {
  status: STATES.UNKNOWN,
  statusSince: new Date().toISOString(),
  instance: process.env.INSTANCE_NAME || 'main',
  phoneNumber: null,

  qrCode: {
    available: false,
    base64: null,
    generatedAt: null
  },

  history: []
};

/**
 * Get current connection status
 */
function getStatus() {
  return connectionState.status;
}

/**
 * Get full connection state
 */
function getState() {
  return {
    status: connectionState.status,
    statusSince: connectionState.statusSince,
    instance: connectionState.instance,
    phoneNumber: connectionState.phoneNumber,
    history: connectionState.history.slice(0, 10)
  };
}

/**
 * Update connection status
 */
function updateStatus(state, payload = {}) {
  const previousStatus = connectionState.status;
  const newStatus = STATE_MAP[state] || state;

  // Only update if status actually changed
  if (newStatus !== previousStatus) {
    const timestamp = new Date().toISOString();

    // Add to history
    connectionState.history.unshift({
      status: newStatus,
      timestamp,
      previousStatus,
      reason: payload.reason || null
    });

    // Trim history
    if (connectionState.history.length > HISTORY_LIMIT) {
      connectionState.history = connectionState.history.slice(0, HISTORY_LIMIT);
    }

    connectionState.status = newStatus;
    connectionState.statusSince = timestamp;

    logger.info('Connection status changed', {
      from: previousStatus,
      to: newStatus,
      reason: payload.reason
    });
  }

  // Update phone number if provided
  if (payload.phoneNumber) {
    connectionState.phoneNumber = payload.phoneNumber;
  }

  // Clear QR code when connected
  if (newStatus === STATES.CONNECTED) {
    connectionState.qrCode = {
      available: false,
      base64: null,
      generatedAt: null
    };
  }

  return {
    previousStatus,
    newStatus,
    changed: previousStatus !== newStatus
  };
}

/**
 * Set QR code
 */
function setQRCode(qrCode) {
  if (!qrCode) return;

  connectionState.qrCode = {
    available: true,
    base64: qrCode.base64 || qrCode,
    generatedAt: new Date().toISOString()
  };

  logger.info('QR code updated');
}

/**
 * Get QR code
 */
function getQRCode() {
  if (!connectionState.qrCode.available) {
    return {
      available: false,
      message: connectionState.status === STATES.CONNECTED
        ? 'No QR code needed - already connected'
        : 'No QR code available'
    };
  }

  return {
    available: true,
    base64: connectionState.qrCode.base64,
    generatedAt: connectionState.qrCode.generatedAt
  };
}

/**
 * Check if currently connected
 */
function isConnected() {
  return connectionState.status === STATES.CONNECTED;
}

/**
 * Get connection history
 */
function getHistory() {
  return connectionState.history;
}

/**
 * Reset connection state
 */
function reset() {
  connectionState = {
    status: STATES.UNKNOWN,
    statusSince: new Date().toISOString(),
    instance: process.env.INSTANCE_NAME || 'main',
    phoneNumber: null,
    qrCode: {
      available: false,
      base64: null,
      generatedAt: null
    },
    history: []
  };
}

module.exports = {
  STATES,
  getStatus,
  getState,
  updateStatus,
  setQRCode,
  getQRCode,
  isConnected,
  getHistory,
  reset
};
