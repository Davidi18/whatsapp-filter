/**
 * Message event handlers
 * Handles: MESSAGES_UPSERT, MESSAGES_UPDATE, MESSAGES_DELETE, MESSAGES_SET, SEND_MESSAGE
 */

const webhookService = require('../services/webhook');
const statsService = require('../services/stats');
const alertService = require('../services/alerts');
const logger = require('../utils/logger');
const { parseRemoteJid, normalizePhone } = require('../utils/validators');

// Config will be injected
let config = null;

/**
 * Set config reference
 */
function setConfig(cfg) {
  config = cfg;
}

/**
 * Check if source is allowed
 */
function checkAllowed(remoteJid) {
  const { sourceId, sourceType, isStatusBroadcast } = parseRemoteJid(remoteJid);

  if (isStatusBroadcast) {
    return { isAllowed: false, sourceId: '', sourceType: 'status', reason: 'status_broadcast' };
  }

  if (sourceType === 'group') {
    const isAllowed = config?.allowedGroups?.some(g => g.groupId === sourceId) || false;
    return { isAllowed, sourceId, sourceType, reason: isAllowed ? null : 'not_in_allowed_groups' };
  }

  // Personal message
  const normalizedSourceId = normalizePhone(sourceId);
  const isAllowed = config?.allowedNumbers?.some(c =>
    normalizePhone(c.phone) === normalizedSourceId
  ) || false;

  return { isAllowed, sourceId, sourceType, reason: isAllowed ? null : 'not_in_allowed_contacts' };
}

/**
 * Handle MESSAGES_UPSERT - New incoming message
 */
async function handleUpsert(payload, context) {
  statsService.increment('MESSAGES_UPSERT', 'total');

  // Extract sender info - Evolution API wraps data in 'data' field
  const data = payload.data || payload;
  const remoteJid = data.key?.remoteJid || '';
  const { isAllowed, sourceId, sourceType, reason } = checkAllowed(remoteJid);

  // Skip status broadcasts silently
  if (sourceType === 'status') {
    statsService.increment('MESSAGES_UPSERT', 'filtered');
    return { action: 'filtered', reason: 'status_broadcast' };
  }

  if (!isAllowed) {
    statsService.increment('MESSAGES_UPSERT', 'filtered');
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      action: 'filtered',
      reason
    });
    logger.filter(sourceId, false, sourceType);
    return { action: 'filtered', reason };
  }

  // Forward to n8n
  try {
    await webhookService.forward(payload, {
      sourceId,
      sourceType,
      event: 'MESSAGES_UPSERT'
    });

    statsService.increment('MESSAGES_UPSERT', 'forwarded');
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      action: 'forwarded',
      details: {
        messageType: data.message?.conversation ? 'text' : 'media'
      }
    });
    logger.filter(sourceId, true, sourceType);

    return { action: 'forwarded', source: sourceId, sourceType };
  } catch (error) {
    statsService.increment('MESSAGES_UPSERT', 'failed');
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      action: 'failed',
      error: error.message
    });

    // Alert on repeated failures
    const health = webhookService.getHealth();
    if (health.consecutiveFailures === 3) {
      await alertService.send({
        level: alertService.ALERT_LEVELS.WARNING,
        event: 'webhook_failed',
        title: 'Webhook Forwarding Failed',
        message: `Failed to forward ${health.consecutiveFailures} messages to n8n webhook.`,
        details: {
          lastError: error.message,
          webhookUrl: health.url
        }
      });
    }

    return { action: 'failed', error: error.message };
  }
}

/**
 * Handle MESSAGES_UPDATE - Message status update (read, delivered)
 */
async function handleUpdate(payload, context) {
  statsService.increment('MESSAGES_UPDATE', 'total');

  if (process.env.ENABLE_MESSAGE_UPDATES === 'true') {
    try {
      await webhookService.forward(payload, { event: 'MESSAGES_UPDATE' });
      statsService.increment('MESSAGES_UPDATE', 'forwarded');
      statsService.logEvent({
        event: 'MESSAGES_UPDATE',
        action: 'forwarded'
      });
      return { action: 'forwarded' };
    } catch (error) {
      statsService.increment('MESSAGES_UPDATE', 'failed');
      logger.error('Failed to forward message update', { error: error.message });
      return { action: 'failed', error: error.message };
    }
  }

  statsService.logEvent({
    event: 'MESSAGES_UPDATE',
    action: 'logged'
  });
  return { action: 'logged' };
}

/**
 * Handle MESSAGES_DELETE - Message deleted
 */
async function handleDelete(payload, context) {
  statsService.increment('MESSAGES_DELETE', 'total');
  statsService.logEvent({
    event: 'MESSAGES_DELETE',
    action: 'logged'
  });
  return { action: 'logged' };
}

/**
 * Handle MESSAGES_SET - Message history sync
 */
async function handleSet(payload, context) {
  statsService.increment('MESSAGES_SET', 'total');
  statsService.logEvent({
    event: 'MESSAGES_SET',
    action: 'logged'
  });
  return { action: 'logged' };
}

/**
 * Handle SEND_MESSAGE - Outgoing message sent
 */
async function handleSend(payload, context) {
  statsService.increment('SEND_MESSAGE', 'total');

  if (process.env.ENABLE_OUTGOING_MESSAGES === 'true') {
    try {
      await webhookService.forward(payload, { event: 'SEND_MESSAGE' });
      statsService.increment('SEND_MESSAGE', 'forwarded');
      statsService.logEvent({
        event: 'SEND_MESSAGE',
        action: 'forwarded'
      });
      return { action: 'forwarded' };
    } catch (error) {
      statsService.increment('SEND_MESSAGE', 'failed');
      logger.error('Failed to forward outgoing message', { error: error.message });
      return { action: 'failed', error: error.message };
    }
  }

  statsService.logEvent({
    event: 'SEND_MESSAGE',
    action: 'logged'
  });
  return { action: 'logged' };
}

module.exports = {
  setConfig,
  handleUpsert,
  handleUpdate,
  handleDelete,
  handleSet,
  handleSend
};
