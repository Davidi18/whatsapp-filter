/**
 * Event router - routes events to appropriate handlers
 */

const messageHandler = require('./messages');
const connectionHandler = require('./connection');
const groupHandler = require('./groups');
const genericHandler = require('./generic');
const logger = require('../utils/logger');

// Map events to handlers
const EVENT_HANDLERS = {
  // Messages
  'MESSAGES_UPSERT': messageHandler.handleUpsert,
  'MESSAGES_UPDATE': messageHandler.handleUpdate,
  'MESSAGES_DELETE': messageHandler.handleDelete,
  'MESSAGES_SET': messageHandler.handleSet,
  'SEND_MESSAGE': messageHandler.handleSend,

  // Connection
  'CONNECTION_UPDATE': connectionHandler.handleUpdate,
  'QRCODE_UPDATED': connectionHandler.handleQRCode,
  'LOGOUT_INSTANCE': connectionHandler.handleLogout,
  'REMOVE_INSTANCE': connectionHandler.handleRemove,
  'APPLICATION_STARTUP': connectionHandler.handleStartup,

  // Groups
  'GROUPS_UPSERT': groupHandler.handleUpsert,
  'GROUP_UPDATE': groupHandler.handleUpdate,
  'GROUP_PARTICIPANTS_UPDATE': groupHandler.handleParticipants
};

/**
 * Route an event to the appropriate handler
 */
async function routeEvent(event, payload, req = {}) {
  const context = {
    event,
    timestamp: new Date().toISOString(),
    ip: req.ip || 'unknown'
  };

  const handler = EVENT_HANDLERS[event] || genericHandler.handle;

  try {
    const result = await handler(payload, context);
    return {
      success: true,
      event,
      ...result
    };
  } catch (error) {
    logger.error('Event handler error', { event, error: error.message });
    return {
      success: false,
      event,
      error: error.message
    };
  }
}

/**
 * Try to detect event type from payload
 */
function detectEventType(payload) {
  // Check for common payload patterns
  if (payload.key && payload.message) {
    return 'MESSAGES_UPSERT';
  }
  if (payload.update && payload.key) {
    return 'MESSAGES_UPDATE';
  }
  if (payload.state || payload.connection) {
    return 'CONNECTION_UPDATE';
  }
  if (payload.qrcode || payload.base64) {
    return 'QRCODE_UPDATED';
  }
  if (payload.subject && payload.id?.includes('@g.us')) {
    return 'GROUPS_UPSERT';
  }
  if (payload.participants && payload.action) {
    return 'GROUP_PARTICIPANTS_UPDATE';
  }

  return null;
}

/**
 * Set config for message handler
 */
function setConfig(config) {
  messageHandler.setConfig(config);
}

/**
 * Set connected phone number (auto-allowed)
 */
function setConnectedPhone(phone) {
  messageHandler.setConnectedPhone(phone);
}

/**
 * Get list of supported events
 */
function getSupportedEvents() {
  return Object.keys(EVENT_HANDLERS);
}

module.exports = {
  routeEvent,
  detectEventType,
  setConfig,
  setConnectedPhone,
  getSupportedEvents,
  EVENT_HANDLERS
};
