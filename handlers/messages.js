/**
 * Message event handlers
 * Handles: MESSAGES_UPSERT, MESSAGES_UPDATE, MESSAGES_DELETE, MESSAGES_SET, SEND_MESSAGE
 */

const webhookService = require('../services/webhook');
const statsService = require('../services/stats');
const alertService = require('../services/alerts');
const messageStore = require('../services/messageStore');
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
 * Extract message content from Evolution API payload
 */
function extractMessageContent(data) {
  const message = data.message || {};
  const key = data.key || {};

  // Get message body from various possible locations
  let body = '';
  let type = 'text';
  let hasMedia = false;
  let mediaType = null;

  if (message.conversation) {
    body = message.conversation;
    type = 'text';
  } else if (message.extendedTextMessage?.text) {
    body = message.extendedTextMessage.text;
    type = 'text';
  } else if (message.imageMessage) {
    body = message.imageMessage.caption || '[Image]';
    type = 'image';
    hasMedia = true;
    mediaType = 'image';
  } else if (message.videoMessage) {
    body = message.videoMessage.caption || '[Video]';
    type = 'video';
    hasMedia = true;
    mediaType = 'video';
  } else if (message.audioMessage) {
    body = '[Audio]';
    type = 'audio';
    hasMedia = true;
    mediaType = 'audio';
  } else if (message.documentMessage) {
    body = message.documentMessage.fileName || '[Document]';
    type = 'document';
    hasMedia = true;
    mediaType = 'document';
  } else if (message.stickerMessage) {
    body = '[Sticker]';
    type = 'sticker';
    hasMedia = true;
    mediaType = 'sticker';
  } else if (message.contactMessage) {
    body = message.contactMessage.displayName || '[Contact]';
    type = 'contact';
  } else if (message.locationMessage) {
    body = '[Location]';
    type = 'location';
  }

  // Get quoted message if exists
  let quotedMessage = null;
  const contextInfo = message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo;

  if (contextInfo?.quotedMessage) {
    quotedMessage = {
      body: contextInfo.quotedMessage.conversation ||
        contextInfo.quotedMessage.extendedTextMessage?.text ||
        '[Media]'
    };
  }

  return {
    id: key.id,
    body,
    type,
    hasMedia,
    mediaType,
    fromMe: key.fromMe || false,
    timestamp: data.messageTimestamp ?
      new Date(data.messageTimestamp * 1000).toISOString() :
      new Date().toISOString(),
    quotedMessage
  };
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

  // Extract sender name (pushName) from Evolution API payload
  const senderName = data.pushName || '';

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
      senderName,
      action: 'filtered',
      reason
    });
    logger.filter(sourceId, false, sourceType);
    return { action: 'filtered', reason };
  }

  // Store the message for later retrieval (all allowed messages - personal and groups)
  const messageContent = extractMessageContent(data);
  try {
    messageStore.storeMessage(sourceId, messageContent);
    logger.debug('Message stored', { source: sourceId, sourceType, type: messageContent.type });
  } catch (storeError) {
    logger.error('Failed to store message', { error: storeError.message });
    // Don't fail the whole operation if storage fails
  }

  // Create preview of message (truncate if too long)
  const messagePreview = messageContent.body.length > 50
    ? messageContent.body.substring(0, 50) + '...'
    : messageContent.body;

  // Check if webhook is configured
  const webhookHealth = webhookService.getHealth();

  // If no webhook configured, just mark as stored (Baileys-only mode)
  if (!webhookHealth.configured) {
    statsService.increment('MESSAGES_UPSERT', 'forwarded'); // Count as success
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      senderName,
      action: 'stored',
      messagePreview,
      messageType: messageContent.type
    });
    logger.filter(sourceId, true, sourceType);
    return { action: 'stored', source: sourceId, sourceType };
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
      senderName,
      action: 'forwarded',
      messagePreview,
      messageType: messageContent.type
    });
    logger.filter(sourceId, true, sourceType);

    return { action: 'forwarded', source: sourceId, sourceType };
  } catch (error) {
    statsService.increment('MESSAGES_UPSERT', 'failed');
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      senderName,
      action: 'failed',
      messagePreview,
      messageType: messageContent.type,
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

  // Extract and store outgoing message
  const data = payload.data || payload;
  const remoteJid = data.key?.remoteJid || '';
  const { sourceId, sourceType } = parseRemoteJid(remoteJid);

  // Check if recipient is in allowed list (only store messages to allowed contacts)
  const { isAllowed } = checkAllowed(remoteJid);

  // Skip if recipient is not in allowed list
  if (!isAllowed) {
    statsService.increment('SEND_MESSAGE', 'filtered');
    return { action: 'filtered', reason: 'recipient_not_allowed' };
  }

  // Extract message content
  const messageContent = extractMessageContent(data);
  messageContent.fromMe = true; // Mark as outgoing

  // Create preview of message
  const messagePreview = messageContent.body.length > 50
    ? messageContent.body.substring(0, 50) + '...'
    : messageContent.body;

  // Find recipient name from config
  const recipientConfig = config?.allowedNumbers?.find(c => normalizePhone(c.phone) === normalizePhone(sourceId));
  const recipientName = recipientConfig?.name || sourceId;

  // Store outgoing message to allowed contact/group
  if (sourceId) {
    try {
      messageStore.storeMessage(sourceId, messageContent);
      logger.debug('Outgoing message stored', { source: sourceId, sourceType, type: messageContent.type });
    } catch (storeError) {
      logger.error('Failed to store outgoing message', { error: storeError.message });
    }
  }

  // Check if webhook forwarding is enabled and configured
  const webhookHealth = webhookService.getHealth();
  if (process.env.ENABLE_OUTGOING_MESSAGES === 'true' && webhookHealth.configured) {
    try {
      await webhookService.forward(payload, { event: 'SEND_MESSAGE' });
      statsService.increment('SEND_MESSAGE', 'forwarded');
      statsService.logEvent({
        event: 'SEND_MESSAGE',
        source: sourceId,
        sourceType,
        senderName: 'Me → ' + recipientName,
        action: 'forwarded',
        messagePreview,
        messageType: messageContent.type
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
    source: sourceId,
    sourceType,
    senderName: 'Me → ' + recipientName,
    action: 'stored',
    messagePreview,
    messageType: messageContent.type
  });
  return { action: 'stored' };
}

module.exports = {
  setConfig,
  handleUpsert,
  handleUpdate,
  handleDelete,
  handleSet,
  handleSend
};
