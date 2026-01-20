/**
 * Baileys WhatsApp Service
 * Direct WhatsApp connection using Baileys library
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  isJidGroup,
  isJidBroadcast
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const pino = require('pino');

// Service state
let socket = null;
let store = null;
let qrCodeData = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;
let retryCount = 0;
const MAX_RETRIES = 5;
const AUTH_DIR = path.join(__dirname, '..', 'config', 'baileys_auth');

// Event callbacks
let onMessageCallback = null;
let onConnectionChangeCallback = null;

// Baileys logger (quiet)
const baileysLogger = pino({ level: 'silent' });

/**
 * Initialize and connect to WhatsApp
 */
async function connect() {
  try {
    // Ensure auth directory exists
    await fs.mkdir(AUTH_DIR, { recursive: true });

    // Get auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Get latest Baileys version
    const { version } = await fetchLatestBaileysVersion();
    logger.info('Baileys connecting', { version: version.join('.') });

    // Try to create in-memory store (optional - for LID resolution)
    try {
      if (typeof makeInMemoryStore === 'function') {
        store = makeInMemoryStore({ logger: baileysLogger });
        logger.info('In-memory store created');
      }
    } catch (storeErr) {
      logger.warn('Could not create in-memory store', { error: storeErr.message });
      store = null;
    }

    // Create socket
    socket = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
      },
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      getMessage: async (key) => {
        if (store) {
          const msg = await store.loadMessage(key.remoteJid, key.id);
          return msg?.message || undefined;
        }
        return undefined;
      }
    });

    // Bind store to socket events (if store exists)
    if (store) {
      store.bind(socket.ev);
    }

    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR code
      if (qr) {
        qrCodeData = qr;
        try {
          qrCodeBase64 = await qrcode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: '#00ff9f', light: '#0d1b2a' }
          });
        } catch (err) {
          logger.error('Failed to generate QR code', { error: err.message });
        }
        connectionStatus = 'waiting_qr';
        logger.info('QR code generated, waiting for scan');

        if (onConnectionChangeCallback) {
          onConnectionChangeCallback({
            status: 'waiting_qr',
            qrCode: qrCodeBase64
          });
        }
      }

      // Handle connection state changes
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || 'unknown';

        logger.warn('Baileys connection closed', { statusCode, reason });
        connectionStatus = 'disconnected';
        qrCodeData = null;
        qrCodeBase64 = null;

        // Check if we should reconnect
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          logger.info('Reconnecting...', { attempt: retryCount, delay });

          setTimeout(() => connect(), delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          logger.info('Logged out, clearing auth state');
          await clearAuthState();
          retryCount = 0;
        }

        if (onConnectionChangeCallback) {
          onConnectionChangeCallback({
            status: 'disconnected',
            reason,
            willReconnect: shouldReconnect && retryCount < MAX_RETRIES
          });
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        retryCount = 0;
        qrCodeData = null;
        qrCodeBase64 = null;

        // Get phone number from socket
        phoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0];

        logger.info('Baileys connected', { phoneNumber });

        if (onConnectionChangeCallback) {
          onConnectionChangeCallback({
            status: 'connected',
            phoneNumber
          });
        }
      } else if (connection === 'connecting') {
        connectionStatus = 'connecting';

        if (onConnectionChangeCallback) {
          onConnectionChangeCallback({ status: 'connecting' });
        }
      }
    });

    // Save credentials on update
    socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      // Handle both 'notify' (real-time) and 'append' (sync/reconnect) messages
      // Skip 'prepend' as those are old historical messages
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        // Skip status broadcasts
        if (isJidBroadcast(msg.key.remoteJid)) continue;

        // Process message
        await handleIncomingMessage(msg);
      }
    });

    // Handle outgoing messages (sent by us)
    socket.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update?.status === 3) { // Message sent successfully
          // This is a sent message confirmation
        }
      }
    });

    return true;
  } catch (error) {
    logger.error('Failed to connect Baileys', { error: error.message });
    connectionStatus = 'error';
    return false;
  }
}

/**
 * Handle incoming message and convert to Evolution API format
 */
async function handleIncomingMessage(msg) {
  if (!onMessageCallback) return;

  try {
    let remoteJid = msg.key.remoteJid;
    const isGroup = isJidGroup(remoteJid);
    const fromMe = msg.key.fromMe || false;

    // Extract message content
    const messageContent = msg.message;
    if (!messageContent) return;

    // Handle LID format - log full message structure to understand what Baileys receives
    if (remoteJid.includes('@lid')) {
      logger.info('LID message received - full structure:', {
        remoteJid,
        keyFields: msg.key,
        pushName: msg.pushName,
        verifiedBizName: msg.verifiedBizName,
        participant: msg.participant,
        // Check for phone number in various possible locations
        msgTopLevelKeys: Object.keys(msg),
        messageKeys: msg.message ? Object.keys(msg.message) : [],
        // Check if there's a senderKeyDistributionMessage with sender info
        senderKeyDist: msg.message?.senderKeyDistributionMessage,
        // Check message context
        contextInfo: msg.message?.extendedTextMessage?.contextInfo ||
                     msg.message?.conversation?.contextInfo
      });

      // Try to resolve LID to phone number
      const lidId = remoteJid.replace('@lid', '');
      try {
        const phoneJid = await resolvePhoneFromLid(lidId);
        if (phoneJid) {
          logger.info('Resolved LID to phone', { lid: lidId, phone: phoneJid });
          remoteJid = phoneJid;
        }
      } catch (resolveErr) {
        logger.debug('LID resolution failed', { error: resolveErr.message });
      }
    }

    // Build Evolution API compatible payload
    const evolutionPayload = {
      data: {
        key: {
          remoteJid,
          fromMe,
          id: msg.key.id,
          participant: msg.key.participant
        },
        pushName: msg.pushName || '',
        message: messageContent,
        messageTimestamp: msg.messageTimestamp,
        messageType: getMessageType(messageContent)
      },
      event: fromMe ? 'SEND_MESSAGE' : 'MESSAGES_UPSERT',
      instance: 'baileys-direct',
      source: 'baileys'
    };

    // Call the message callback
    await onMessageCallback(evolutionPayload);
  } catch (error) {
    logger.error('Failed to process incoming message', { error: error.message });
  }
}

/**
 * Try to resolve LID to phone number using Baileys store
 */
async function resolvePhoneFromLid(lidId) {
  if (!socket) return null;

  try {
    // Method 1: Try Baileys v7 signalRepository lidMapping
    if (socket.signalRepository?.lidMapping) {
      const mapping = socket.signalRepository.lidMapping;
      if (typeof mapping.getPNForLID === 'function') {
        const pn = await mapping.getPNForLID(lidId);
        if (pn) return `${pn}@s.whatsapp.net`;
      }
    }

    // Method 2: Try using our in-memory store contacts
    if (store?.contacts) {
      for (const [jid, contact] of Object.entries(store.contacts)) {
        // Check if contact has lid field matching our lidId
        if (contact.lid === lidId || contact.lid === `${lidId}@lid`) {
          if (contact.phoneNumber) {
            return `${contact.phoneNumber}@s.whatsapp.net`;
          }
          if (jid.includes('@s.whatsapp.net')) {
            return jid;
          }
        }
      }
    }

    // Method 3: Check authState for self
    if (socket.authState?.creds?.me?.lid === lidId) {
      return socket.authState.creds.me.id;
    }

    return null;
  } catch (error) {
    logger.debug('resolvePhoneFromLid error', { error: error.message });
    return null;
  }
}

/**
 * Determine message type from content
 */
function getMessageType(message) {
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.contactMessage) return 'contact';
  if (message.locationMessage) return 'location';
  if (message.reactionMessage) return 'reaction';
  return 'unknown';
}

/**
 * Send a text message
 */
async function sendMessage(to, text) {
  if (!socket || connectionStatus !== 'connected') {
    throw new Error('Not connected to WhatsApp');
  }

  // Format JID
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

  try {
    const result = await socket.sendMessage(jid, { text });
    logger.info('Message sent', { to: jid, messageId: result.key.id });
    return result;
  } catch (error) {
    logger.error('Failed to send message', { error: error.message, to: jid });
    throw error;
  }
}

/**
 * Send media message
 */
async function sendMedia(to, media, caption = '') {
  if (!socket || connectionStatus !== 'connected') {
    throw new Error('Not connected to WhatsApp');
  }

  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

  try {
    const result = await socket.sendMessage(jid, {
      [media.type]: { url: media.url },
      caption
    });
    logger.info('Media sent', { to: jid, type: media.type, messageId: result.key.id });
    return result;
  } catch (error) {
    logger.error('Failed to send media', { error: error.message, to: jid });
    throw error;
  }
}

/**
 * Disconnect from WhatsApp
 */
async function disconnect() {
  if (socket) {
    try {
      await socket.logout();
    } catch (error) {
      logger.warn('Error during logout', { error: error.message });
    }
    socket = null;
  }
  connectionStatus = 'disconnected';
  qrCodeData = null;
  qrCodeBase64 = null;
  phoneNumber = null;
}

/**
 * Clear auth state (for logout)
 */
async function clearAuthState() {
  try {
    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    await fs.mkdir(AUTH_DIR, { recursive: true });
    logger.info('Auth state cleared');
  } catch (error) {
    logger.error('Failed to clear auth state', { error: error.message });
  }
}

/**
 * Get current status
 */
function getStatus() {
  return {
    enabled: process.env.BAILEYS_ENABLED === 'true',
    status: connectionStatus,
    phoneNumber,
    hasQRCode: !!qrCodeBase64,
    retryCount
  };
}

/**
 * Get QR code
 */
function getQRCode() {
  return {
    available: !!qrCodeBase64,
    base64: qrCodeBase64,
    raw: qrCodeData
  };
}

/**
 * Set message callback
 */
function onMessage(callback) {
  onMessageCallback = callback;
}

/**
 * Set connection change callback
 */
function onConnectionChange(callback) {
  onConnectionChangeCallback = callback;
}

/**
 * Check if Baileys is enabled
 */
function isEnabled() {
  return process.env.BAILEYS_ENABLED === 'true';
}

/**
 * Check if connected
 */
function isConnected() {
  return connectionStatus === 'connected';
}

/**
 * Get socket instance (for advanced usage)
 */
function getSocket() {
  return socket;
}

module.exports = {
  connect,
  disconnect,
  sendMessage,
  sendMedia,
  getStatus,
  getQRCode,
  onMessage,
  onConnectionChange,
  isEnabled,
  isConnected,
  getSocket,
  clearAuthState
};
