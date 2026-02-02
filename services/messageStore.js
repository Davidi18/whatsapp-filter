/**
 * Message storage service
 * Stores filtered messages for retrieval via API
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const MESSAGES_FILE = path.join(__dirname, '..', 'config', 'messages.json');
const MAX_MESSAGES_PER_PHONE = parseInt(process.env.MAX_MESSAGES_PER_PHONE) || 100;
const MAX_TOTAL_MESSAGES = parseInt(process.env.MAX_TOTAL_MESSAGES) || 5000;
const SAVE_INTERVAL = 60 * 1000; // 1 minute

// In-memory message store: { phone: [messages] }
let messageStore = {};
let saveTimer = null;
let isDirty = false;

/**
 * Load messages from file
 */
async function load() {
  try {
    const data = await fs.readFile(MESSAGES_FILE, 'utf8');
    messageStore = JSON.parse(data);
    logger.info('Message store loaded', {
      phones: Object.keys(messageStore).length,
      totalMessages: Object.values(messageStore).reduce((sum, msgs) => sum + msgs.length, 0)
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Failed to load message store', { error: error.message });
    }
    messageStore = {};
  }
}

/**
 * Save messages to file
 */
async function save() {
  if (!isDirty) return;

  try {
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(messageStore, null, 2));
    isDirty = false;
    logger.debug('Message store saved');
  } catch (error) {
    logger.error('Failed to save message store', { error: error.message });
  }
}

/**
 * Start periodic save timer
 */
function startAutoSave() {
  if (saveTimer) return;

  saveTimer = setInterval(() => {
    save().catch(err => logger.error('Message store auto-save failed', { error: err.message }));
  }, SAVE_INTERVAL);
}

/**
 * Stop auto-save timer
 */
function stopAutoSave() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

/**
 * Store a message
 */
function storeMessage(phone, message) {
  // Normalize phone number
  const normalizedPhone = phone.replace(/\D/g, '');

  if (!messageStore[normalizedPhone]) {
    messageStore[normalizedPhone] = [];
  }

  // Add message at the beginning (newest first)
  messageStore[normalizedPhone].unshift({
    id: message.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    body: message.body || '',
    timestamp: message.timestamp || new Date().toISOString(),
    fromMe: message.fromMe || false,
    type: message.type || 'text',
    hasMedia: message.hasMedia || false,
    mediaType: message.mediaType || null,
    mediaId: message.mediaId || null,
    thumbBase64: message.thumbBase64 || null,
    quotedMessage: message.quotedMessage || null,
    storedAt: new Date().toISOString()
  });

  // Trim to max messages per phone
  if (messageStore[normalizedPhone].length > MAX_MESSAGES_PER_PHONE) {
    messageStore[normalizedPhone] = messageStore[normalizedPhone].slice(0, MAX_MESSAGES_PER_PHONE);
  }

  // Check total message count and cleanup if needed
  const totalMessages = Object.values(messageStore).reduce((sum, msgs) => sum + msgs.length, 0);
  if (totalMessages > MAX_TOTAL_MESSAGES) {
    cleanupOldMessages();
  }

  isDirty = true;
}

/**
 * Get messages for a phone number
 */
function getMessages(phone, options = {}) {
  const { limit = 50, offset = 0 } = options;
  const normalizedPhone = phone.replace(/\D/g, '');

  const messages = messageStore[normalizedPhone] || [];
  const total = messages.length;

  return {
    messages: messages.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total
  };
}

/**
 * Get all phones with messages
 */
function getPhones() {
  return Object.keys(messageStore).map(phone => ({
    phone,
    messageCount: messageStore[phone].length,
    lastMessage: messageStore[phone][0]?.timestamp || null
  }));
}

/**
 * Delete messages for a phone number
 */
function deleteMessages(phone) {
  const normalizedPhone = phone.replace(/\D/g, '');
  const count = messageStore[normalizedPhone]?.length || 0;
  delete messageStore[normalizedPhone];
  isDirty = true;
  return count;
}

/**
 * Cleanup old messages to stay under total limit
 */
function cleanupOldMessages() {
  // Get all messages with phone reference
  const allMessages = [];
  Object.entries(messageStore).forEach(([phone, messages]) => {
    messages.forEach((msg, index) => {
      allMessages.push({ phone, index, timestamp: msg.timestamp || msg.storedAt });
    });
  });

  // Sort by timestamp (oldest first)
  allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Remove oldest messages until under limit
  const toRemove = allMessages.length - MAX_TOTAL_MESSAGES;
  if (toRemove > 0) {
    const removeSet = new Set(allMessages.slice(0, toRemove).map(m => `${m.phone}:${m.index}`));

    Object.keys(messageStore).forEach(phone => {
      messageStore[phone] = messageStore[phone].filter((_, index) =>
        !removeSet.has(`${phone}:${index}`)
      );

      // Remove empty phone entries
      if (messageStore[phone].length === 0) {
        delete messageStore[phone];
      }
    });

    logger.info('Cleaned up old messages', { removed: toRemove });
  }

  isDirty = true;
}

/**
 * Get stats
 */
function getStats() {
  const phones = Object.keys(messageStore).length;
  const totalMessages = Object.values(messageStore).reduce((sum, msgs) => sum + msgs.length, 0);

  return {
    phones,
    totalMessages,
    maxPerPhone: MAX_MESSAGES_PER_PHONE,
    maxTotal: MAX_TOTAL_MESSAGES
  };
}

module.exports = {
  load,
  save,
  startAutoSave,
  stopAutoSave,
  storeMessage,
  getMessages,
  getPhones,
  deleteMessages,
  getStats
};
