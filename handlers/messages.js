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

// Connected phone number (auto-allowed)
let connectedPhone = null;

/**
 * Set config reference
 */
function setConfig(cfg) {
  config = cfg;
}

/**
 * Set connected phone number (auto-allowed for outgoing messages)
 */
function setConnectedPhone(phone) {
  connectedPhone = phone ? normalizePhone(phone) : null;
  if (connectedPhone) {
    logger.info('Connected phone set (auto-allowed)', { phone: connectedPhone });
  }
}

/**
 * Check if source is allowed
 * Returns: { isAllowed, sourceId, sourceType, entityType, reason }
 * entityType is the type of the contact/group (VIP, BUSINESS, etc.)
 *
 * @param {string} remoteJid - The remote JID
 * @param {string|null} senderPn - Optional sender phone number (from Baileys LID resolution)
 */
function checkAllowed(remoteJid, senderPn = null) {
  const { sourceId, sourceType, isStatusBroadcast } = parseRemoteJid(remoteJid);

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
  let normalizedSourceId = normalizePhone(sourceId);

  // If sourceId looks like a LID and we have senderPn, use senderPn instead
  if ((sourceId.includes('lid') || !normalizedSourceId.match(/^\d{10,15}$/)) && senderPn) {
    const normalizedSenderPn = normalizePhone(senderPn);
    if (normalizedSenderPn.match(/^\d{10,15}$/)) {
      logger.debug('Using senderPn for phone matching', {
        originalSourceId: sourceId,
        senderPn,
        normalizedSenderPn
      });
      normalizedSourceId = normalizedSenderPn;
    }
  }

  // Auto-allow the connected phone number
  const isOwnPhone = connectedPhone && normalizedSourceId === connectedPhone;

  const matchedContact = config?.allowedNumbers?.find(c =>
    normalizePhone(c.phone) === normalizedSourceId
  );
  const isAllowed = !!matchedContact || isOwnPhone;

  // Debug logging for phone matching
  if (!isAllowed && config?.allowedNumbers?.length > 0) {
    logger.debug('Phone match failed', {
      incoming: sourceId,
      normalized: normalizedSourceId,
      senderPn: senderPn || 'none',
      configuredSample: config.allowedNumbers.slice(0, 3).map(c => ({
        original: c.phone,
        normalized: normalizePhone(c.phone)
      }))
    });
  }

  return {
    isAllowed,
    sourceId: normalizedSourceId, // Return the resolved phone number
    sourceType,
    entityType: matchedContact?.type || (isOwnPhone ? 'SELF' : null),
    entityName: matchedContact?.name || (isOwnPhone ? 'Me' : null),
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
  } else if (message.reactionMessage) {
    body = message.reactionMessage.text || '';
    type = 'reaction';
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
    mediaId: data.mediaId || null,
    thumbBase64: data.thumbBase64 || null,
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
  // Get senderPn from Baileys payload (used for LID resolution fallback)
  const senderPn = data.senderPn || data.key?.senderPn || null;
  const { isAllowed, sourceId, sourceType, entityType, entityName, reason } = checkAllowed(remoteJid, senderPn);

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
      mediaId: messageContent.mediaId,
      thumbBase64: messageContent.thumbBase64,
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

  // Check for mentions (if enabled and in group chat)
  const mentionEnabled = process.env.ENABLE_MENTION_DETECTION === 'true';
  if (mentionEnabled && sourceType === 'group' && connectedPhone) {
    const mention = checkMentioned(data, connectedPhone);
    
    if (mention.isMentioned) {
      // Forward to mention webhook (OpenClaw)
      const mentionForwarded = await forwardMention(
        payload,
        mention,
        sourceId,
        sourceType,
        senderName
      );
      
      // Log mention detection
      statsService.logEvent({
        event: 'MENTION_DETECTED',
        source: sourceId,
        sourceType,
        senderName,
        action: mentionForwarded ? 'forwarded_to_openclaw' : 'detection_only',
        messagePreview,
        messageBody: messageContent.body,
        messageType: messageContent.type,
        method: mention.method,
        keywords: mention.keywords
      });
      
      logger.info('Mention detected', { 
        source: sourceId,
        method: mention.method,
        keywords: mention.keywords,
        forwarded: mentionForwarded
      });
      
      // If configured to forward mentions only to OpenClaw (not n8n), return here
      if (process.env.MENTION_ONLY_OPENCLAW === 'true') {
        statsService.increment('MESSAGES_UPSERT', 'forwarded');
        return { 
          action: 'mention_forwarded', 
          source: sourceId, 
          sourceType,
          mention: true,
          method: mention.method
        };
      }
      
      // Otherwise, continue to also forward to n8n (mention + regular flow)
    }
  }

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
      messageType: messageContent.type,
      mediaId: messageContent.mediaId,
      thumbBase64: messageContent.thumbBase64
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
      messageType: messageContent.type,
      mediaId: messageContent.mediaId,
      thumbBase64: messageContent.thumbBase64
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
      mediaId: messageContent.mediaId,
      thumbBase64: messageContent.thumbBase64,
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
  // Get senderPn from Baileys payload (used for LID resolution fallback)
  const senderPn = data.senderPn || data.key?.senderPn || null;

  // Check if recipient is in allowed list (only store messages to allowed contacts)
  const { isAllowed, sourceId, sourceType } = checkAllowed(remoteJid, senderPn);

  // Skip if recipient is not in allowed list
  if (!isAllowed) {
    statsService.increment('SEND_MESSAGE', 'filtered');
    logger.filter(sourceId, false, sourceType);
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
        messageType: messageContent.type,
      mediaId: messageContent.mediaId
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
      mediaId: messageContent.mediaId,
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

/**
 * Check if message mentions the connected phone number
 * @param {Object} messageData - Message payload
 * @param {string} connectedPhone - Connected phone number (normalized)
 * @returns {Object} { isMentioned, method, keywords }
 */
function checkMentioned(messageData, connectedPhone) {
  if (!connectedPhone) {
    return { isMentioned: false, method: null, keywords: [] };
  }

  const message = messageData.message || {};
  const messageContent = extractMessageContent(messageData);
  const body = messageContent.body.toLowerCase();
  
  // 1. Check for @mention in contextInfo
  const mentioned = message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const isMentionedByTag = mentioned.some(jid => {
    const phone = jid.replace(/@.*$/, ''); // Extract phone from jid
    return phone === connectedPhone || phone.endsWith(connectedPhone);
  });
  
  if (isMentionedByTag) {
    return { isMentioned: true, method: '@mention', keywords: [] };
  }
  
  // 2. Check for text keywords (configurable via env)
  const keywordsEnv = process.env.MENTION_KEYWORDS || 'דוד,david';
  const keywords = keywordsEnv.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
  const matchedKeywords = keywords.filter(kw => body.includes(kw));
  
  if (matchedKeywords.length > 0) {
    return { isMentioned: true, method: 'keyword', keywords: matchedKeywords };
  }
  
  // 3. Check if it's a reply to our message
  const quotedMsgKey = message.extendedTextMessage?.contextInfo?.stanzaId;
  if (quotedMsgKey) {
    const isReplyToUs = messageStore.isOurMessage(quotedMsgKey);
    if (isReplyToUs) {
      return { isMentioned: true, method: 'reply', keywords: [] };
    }
  }
  
  return { isMentioned: false, method: null, keywords: [] };
}

/**
 * Forward mention to OpenClaw webhook
 * @param {Object} payload - Original message payload
 * @param {Object} mention - Mention detection result
 * @param {string} sourceId - Source phone/group
 * @param {string} sourceType - 'personal' or 'group'
 * @param {string} senderName - Sender name
 */
async function forwardMention(payload, mention, sourceId, sourceType, senderName) {
  const mentionWebhookUrl = process.env.MENTION_WEBHOOK_URL;
  const mentionApiKey = process.env.MENTION_API_KEY;
  
  if (!mentionWebhookUrl) {
    logger.debug('Mention detected but MENTION_WEBHOOK_URL not configured', { mention });
    return false;
  }
  
  // Build mention payload
  const mentionPayload = {
    ...payload,
    _mention: {
      detected: true,
      method: mention.method,
      keywords: mention.keywords,
      timestamp: new Date().toISOString(),
      source: {
        id: sourceId,
        type: sourceType,
        name: senderName
      }
    }
  };
  
  // Forward to mention webhook
  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (mentionApiKey) {
      headers['Authorization'] = `Bearer ${mentionApiKey}`;
    }
    
    const response = await fetch(mentionWebhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(mentionPayload)
    });
    
    if (!response.ok) {
      throw new Error(`Mention webhook returned ${response.status}`);
    }
    
    logger.info('Mention forwarded to OpenClaw', { 
      method: mention.method, 
      keywords: mention.keywords,
      source: sourceId
    });
    
    statsService.increment('MENTIONS', 'forwarded');
    return true;
  } catch (error) {
    logger.error('Failed to forward mention', { error: error.message });
    statsService.increment('MENTIONS', 'failed');
    return false;
  }
}

module.exports = {
  setConfig,
  setConnectedPhone,
  handleUpsert,
  handleUpdate,
  handleDelete,
  handleSet,
  handleSend,
  checkMentioned,
  forwardMention
};
