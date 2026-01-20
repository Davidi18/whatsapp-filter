/**
 * Message event handlers
 * Handles: MESSAGES_UPSERT, MESSAGES_UPDATE, MESSAGES_DELETE, MESSAGES_SET, SEND_MESSAGE
 */

const webhookService = require('../services/webhook');
const statsService = require('../services/stats');
const alertService = require('../services/alerts');
const messageStore = require('../services/messageStore');
const logger = require('../utils/logger');
const { parseRemoteJid, normalizePhone, normalizeGroupId } = require('../utils/validators');

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
 * Returns: { isAllowed, sourceId, sourceType, entityType, reason }
 * entityType is the type of the contact/group (VIP, BUSINESS, etc.)
 */
function checkAllowed(remoteJid) {
  const { sourceId, sourceType, isStatusBroadcast, isLid } = parseRemoteJid(remoteJid);

  if (isStatusBroadcast) {
    return { isAllowed: false, sourceId: '', sourceType: 'status', entityType: null, reason: 'status_broadcast' };
  }

  if (sourceType === 'group') {
    // Normalize group ID for comparison (handles @g.us suffix variations)
    const normalizedSourceId = normalizeGroupId(sourceId);
    const matchedGroup = config?.allowedGroups?.find(g =>
      normalizeGroupId(g.groupId) === normalizedSourceId
    );
    const isAllowed = !!matchedGroup;

    // Debug logging for group matching
    if (!isAllowed && config?.allowedGroups?.length > 0) {
      logger.debug('Group match failed', {
        incoming: sourceId,
        normalized: normalizedSourceId,
        configuredSample: config.allowedGroups.slice(0, 3).map(g => ({
          original: g.groupId,
          normalized: normalizeGroupId(g.groupId)
        }))
      });
    }

    return {
      isAllowed,
      sourceId,
      sourceType,
      entityType: matchedGroup?.type || null,
      entityName: matchedGroup?.name || null,
      reason: isAllowed ? null : 'not_in_allowed_groups'
    };
  }

  // Personal message - normalize both sides for comparison
  const normalizedSourceId = normalizePhone(sourceId);

  // Find contact by phone number OR by LID (WhatsApp Linked ID)
  let matchedContact;
  if (isLid) {
    // Message came with LID format - check both lid field and phone field
    matchedContact = config?.allowedNumbers?.find(c =>
      c.lid === sourceId || normalizePhone(c.phone) === normalizedSourceId
    );
  } else {
    // Standard phone format - check phone and also lid field in case contact has LID stored
    matchedContact = config?.allowedNumbers?.find(c =>
      normalizePhone(c.phone) === normalizedSourceId || c.lid === sourceId
    );
  }

  const isAllowed = !!matchedContact;

  // Debug logging for phone matching
  if (!isAllowed && config?.allowedNumbers?.length > 0) {
    logger.debug('Phone match failed', {
      incoming: sourceId,
      normalized: normalizedSourceId,
      isLid,
      configuredSample: config.allowedNumbers.slice(0, 3).map(c => ({
        original: c.phone,
        normalized: normalizePhone(c.phone),
        lid: c.lid || null
      }))
    });
  }

  return {
    isAllowed,
    sourceId,
    sourceType,
    entityType: matchedContact?.type || null,
    entityName: matchedContact?.name || null,
    reason: isAllowed ? null : 'not_in_allowed_contacts'
  };
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
  const { isAllowed, sourceId, sourceType, entityType, entityName, reason } = checkAllowed(remoteJid);

  // Extract sender name (pushName) from Evolution API payload, fallback to entity name from config
  const senderName = data.pushName || entityName || '';

  // Skip status broadcasts silently
  if (sourceType === 'status') {
    statsService.increment('MESSAGES_UPSERT', 'filtered');
    return { action: 'filtered', reason: 'status_broadcast' };
  }

  if (!isAllowed) {
    statsService.increment('MESSAGES_UPSERT', 'filtered');
    // Extract message content for logging even for filtered messages
    const messageContent = extractMessageContent(data);
    const messagePreview = messageContent.body.length > 50
      ? messageContent.body.substring(0, 50) + '...'
      : messageContent.body;
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      senderName,
      action: 'filtered',
      messagePreview,
      messageBody: messageContent.body,
      messageType: messageContent.type,
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

  // If no webhook configured, message is allowed but nothing to forward to
  if (!webhookHealth.configured) {
    statsService.increment('MESSAGES_UPSERT', 'forwarded'); // Count as success
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      senderName,
      action: 'forwarded',
      messagePreview,
      messageBody: messageContent.body,
      messageType: messageContent.type
    });
    logger.filter(sourceId, true, sourceType);
    return { action: 'forwarded', source: sourceId, sourceType };
  }

  // Forward to n8n (with type-based routing)
  try {
    await webhookService.forward(payload, {
      sourceId,
      sourceType,
      entityType,
      event: 'MESSAGES_UPSERT'
    });

    statsService.increment('MESSAGES_UPSERT', 'forwarded');
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      entityType,
      senderName,
      action: 'forwarded',
      messagePreview,
      messageBody: messageContent.body,
      messageType: messageContent.type
    });
    logger.filter(sourceId, true, sourceType);

    return { action: 'forwarded', source: sourceId, sourceType, entityType };
  } catch (error) {
    statsService.increment('MESSAGES_UPSERT', 'failed');
    statsService.logEvent({
      event: 'MESSAGES_UPSERT',
      source: sourceId,
      sourceType,
      entityType,
      senderName,
      action: 'failed',
      messagePreview,
      messageBody: messageContent.body,
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

  // Forward to webhook if configured (outgoing messages to allowed contacts are always forwarded)
  const webhookHealth = webhookService.getHealth();
  if (webhookHealth.configured) {
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
        messageBody: messageContent.body,
        messageType: messageContent.type
      });
      return { action: 'forwarded' };
    } catch (error) {
      statsService.increment('SEND_MESSAGE', 'failed');
      statsService.logEvent({
        event: 'SEND_MESSAGE',
        source: sourceId,
        sourceType,
        senderName: 'Me → ' + recipientName,
        action: 'failed',
        messagePreview,
        messageBody: messageContent.body,
        messageType: messageContent.type,
        error: error.message
      });
      logger.error('Failed to forward outgoing message', { error: error.message });
      return { action: 'failed', error: error.message };
    }
  }

  // No webhook configured - just log
  statsService.increment('SEND_MESSAGE', 'forwarded'); // Count as success (no webhook = nothing to forward to)
  statsService.logEvent({
    event: 'SEND_MESSAGE',
    source: sourceId,
    sourceType,
    senderName: 'Me → ' + recipientName,
    action: 'forwarded',
    messagePreview,
    messageBody: messageContent.body,
    messageType: messageContent.type
  });
  return { action: 'forwarded' };
}

module.exports = {
  setConfig,
  handleUpsert,
  handleUpdate,
  handleDelete,
  handleSet,
  handleSend
};
