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
  isJidBroadcast,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const mediaStore = require('./mediaStore');
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
    // DEBUG: Log the full message structure to understand Baileys format
    logger.info('RAW Baileys message received', {
      'msg.key': msg.key,
      'msg.pushName': msg.pushName,
      'msg.senderPn': msg.senderPn,
      'msg.verifiedBizName': msg.verifiedBizName,
      'msg.messageTimestamp': msg.messageTimestamp,
      // Log all top-level keys
      'msgKeys': Object.keys(msg)
    });

    let remoteJid = msg.key.remoteJid;
    const isGroup = isJidGroup(remoteJid);
    const fromMe = msg.key.fromMe || false;

    // Skip messages to/from self (sync messages, delivery receipts)
    if (fromMe && phoneNumber && remoteJid === `${phoneNumber}@s.whatsapp.net`) {
      logger.debug('Skipping message to self', { remoteJid, id: msg.key.id });
      return;
    }

    if (isGroup) {
      logger.info('Group message received', {
        groupJid: remoteJid,
        participant: msg.key.participant,
        fromMe,
        messageKeys: msg.message ? Object.keys(msg.message) : 'null'
      });
    }

    // Extract message content - unwrap ephemeral/viewOnce wrappers
    let messageContent = msg.message;
    if (!messageContent) return;

    // Unwrap ephemeral messages (disappearing messages in groups)
    if (messageContent.ephemeralMessage?.message) {
      messageContent = messageContent.ephemeralMessage.message;
    }
    // Unwrap viewOnce messages
    if (messageContent.viewOnceMessage?.message) {
      messageContent = messageContent.viewOnceMessage.message;
    }
    // Unwrap viewOnceMessageV2
    if (messageContent.viewOnceMessageV2?.message) {
      messageContent = messageContent.viewOnceMessageV2.message;
    }
    // Unwrap documentWithCaptionMessage
    if (messageContent.documentWithCaptionMessage?.message) {
      messageContent = messageContent.documentWithCaptionMessage.message;
    }

    // Skip protocol messages (key distribution, etc.) - not real user messages
    if (messageContent.senderKeyDistributionMessage && !messageContent.conversation &&
        !messageContent.extendedTextMessage && !messageContent.imageMessage &&
        !messageContent.videoMessage && !messageContent.audioMessage &&
        !messageContent.documentMessage && !messageContent.stickerMessage &&
        !messageContent.contactMessage && !messageContent.locationMessage) {
      // senderKeyDistributionMessage alone is just a protocol message, skip it
      // But sometimes it comes alongside a real message, so only skip if no real content
      logger.debug('Skipping protocol-only message', { remoteJid, keys: Object.keys(messageContent) });
      return;
    }

    // For group messages, get the actual sender (participant)
    // For private messages, remoteJid is the sender (or recipient if fromMe)
    let senderPhone = null;

    // Handle LID format - extract phone number from various sources
    if (remoteJid.includes('@lid')) {
      // Try multiple sources for phone number resolution

      // Source 1: msg.key.senderPn (available in group messages)
      if (msg.key.senderPn) {
        senderPhone = msg.key.senderPn;
        logger.info('LID resolved via key.senderPn', {
          lid: remoteJid,
          phone: senderPhone
        });
      }

      // Source 2: msg.senderPn (sometimes at message root level)
      if (!senderPhone && msg.senderPn) {
        senderPhone = msg.senderPn;
        logger.info('LID resolved via msg.senderPn', {
          lid: remoteJid,
          phone: senderPhone
        });
      }

      // Source 3: Try the store for LID mapping (pass msg for pushName matching)
      if (!senderPhone) {
        const lidId = remoteJid.replace('@lid', '');
        try {
          const phoneJid = await resolvePhoneFromLid(lidId, msg);
          if (phoneJid) {
            senderPhone = phoneJid.replace('@s.whatsapp.net', '');
            logger.info('LID resolved via store lookup', { lid: lidId, phone: senderPhone });
          }
        } catch (resolveErr) {
          logger.debug('LID resolution failed', { error: resolveErr.message });
        }
      }

      // If we found a phone number, format it correctly as JID
      if (senderPhone) {
        // Ensure it's just the phone number (no suffix)
        senderPhone = senderPhone.replace('@s.whatsapp.net', '').replace('@lid', '');
        remoteJid = `${senderPhone}@s.whatsapp.net`;
      } else {
        logger.warn('Could not resolve LID to phone', {
          lid: remoteJid,
          pushName: msg.pushName,
          hasKeySenderPn: !!msg.key.senderPn,
          hasMsgSenderPn: !!msg.senderPn,
          fromMe
        });
      }
    }

    // Handle participant LID in group messages
    let participant = msg.key.participant;
    if (isGroup && participant && participant.includes('@lid')) {
      // Try to resolve participant LID to phone number
      const participantSenderPn = msg.key.senderPn || msg.senderPn;
      if (participantSenderPn) {
        participant = `${participantSenderPn.replace('@s.whatsapp.net', '').replace('@lid', '')}@s.whatsapp.net`;
        logger.info('Participant LID resolved via senderPn', {
          originalParticipant: msg.key.participant,
          resolved: participant
        });
      } else {
        // Try store resolution
        try {
          const resolvedParticipant = await resolvePhoneFromLid(participant, msg);
          if (resolvedParticipant) {
            participant = resolvedParticipant;
            logger.info('Participant LID resolved via store', {
              originalParticipant: msg.key.participant,
              resolved: participant
            });
          }
        } catch (err) {
          logger.debug('Failed to resolve participant LID', { error: err.message });
        }
      }
    }

    // Download media if present
    let mediaId = null;
    let thumbBase64 = null;
    const msgType = getMessageType(messageContent);
    const mediaMsg = messageContent.imageMessage || messageContent.videoMessage ||
      messageContent.audioMessage || messageContent.documentMessage ||
      messageContent.stickerMessage;
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(msgType)) {
      // Extract base64 thumbnail as fallback (always available inline, no download needed)
      if (mediaMsg?.jpegThumbnail) {
        try {
          const thumbBuf = Buffer.isBuffer(mediaMsg.jpegThumbnail)
            ? mediaMsg.jpegThumbnail
            : Buffer.from(mediaMsg.jpegThumbnail, 'base64');
          thumbBase64 = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
        } catch (e) {
          // ignore thumbnail extraction error
        }
      }

      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: socket.updateMediaMessage
        });
        if (buffer) {
          const mimeType = mediaMsg?.mimetype || 'application/octet-stream';
          mediaId = await mediaStore.saveMedia(msg.key.id, buffer, mimeType);
          logger.info('Media downloaded and saved', { id: msg.key.id, type: msgType, size: buffer.length, mediaId });
        } else {
          logger.warn('Media download returned empty buffer', { id: msg.key.id, type: msgType, fromMe });
        }
      } catch (dlErr) {
        logger.warn('Media download failed', { id: msg.key.id, type: msgType, fromMe, error: dlErr.message });
        // Fallback: save jpegThumbnail as media file
        if (mediaMsg?.jpegThumbnail) {
          try {
            const thumbBuffer = Buffer.isBuffer(mediaMsg.jpegThumbnail)
              ? mediaMsg.jpegThumbnail
              : Buffer.from(mediaMsg.jpegThumbnail, 'base64');
            mediaId = await mediaStore.saveMedia(msg.key.id, thumbBuffer, 'image/jpeg');
            logger.info('Saved jpegThumbnail fallback', { id: msg.key.id, size: thumbBuffer.length });
          } catch (thumbErr) {
            logger.warn('Thumbnail save failed', { id: msg.key.id, error: thumbErr.message });
          }
        }
      }
    }

    // Build Evolution API compatible payload
    const evolutionPayload = {
      data: {
        key: {
          remoteJid,
          fromMe,
          id: msg.key.id,
          participant
        },
        pushName: msg.pushName || '',
        message: messageContent,
        messageTimestamp: msg.messageTimestamp,
        messageType: msgType,
        mediaId,
        thumbBase64,
        // Add senderPn to payload for downstream use
        senderPn: msg.key.senderPn || msg.senderPn || null
      },
      event: 'MESSAGES_UPSERT',
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
 * Try to resolve LID to phone number using Baileys store and various methods
 */
async function resolvePhoneFromLid(lidId, msg = null) {
  if (!socket) return null;

  // Clean the lid ID
  const cleanLid = lidId.replace('@lid', '');

  try {
    // Method 1: Try Baileys v7 signalRepository lidMapping
    if (socket.signalRepository?.lidMapping) {
      const mapping = socket.signalRepository.lidMapping;
      if (typeof mapping.getPNForLID === 'function') {
        const pn = await mapping.getPNForLID(cleanLid);
        if (pn) {
          logger.debug('LID resolved via signalRepository', { lid: cleanLid, phone: pn });
          return `${pn}@s.whatsapp.net`;
        }
      }
    }

    // Method 2: Try using our in-memory store contacts
    if (store?.contacts) {
      for (const [jid, contact] of Object.entries(store.contacts)) {
        // Check if contact has lid field matching our lidId
        if (contact.lid === cleanLid || contact.lid === `${cleanLid}@lid`) {
          if (contact.phoneNumber) {
            logger.debug('LID resolved via store contact phoneNumber', { lid: cleanLid, phone: contact.phoneNumber });
            return `${contact.phoneNumber}@s.whatsapp.net`;
          }
          if (jid.includes('@s.whatsapp.net')) {
            logger.debug('LID resolved via store contact jid', { lid: cleanLid, jid });
            return jid;
          }
        }
        // Also check by notify/name if we have a pushName to match
        if (msg?.pushName && contact.notify === msg.pushName && jid.includes('@s.whatsapp.net')) {
          logger.debug('LID resolved via pushName match', { lid: cleanLid, pushName: msg.pushName, jid });
          return jid;
        }
      }
    }

    // Method 3: Check authState for self (if message is from me)
    const meLid = socket.authState?.creds?.me?.lid;
    if (meLid && (meLid === cleanLid || meLid === `${cleanLid}@lid`)) {
      logger.debug('LID resolved as self', { lid: cleanLid, me: socket.authState.creds.me.id });
      return socket.authState.creds.me.id;
    }

    // Method 4: Try chat store for recent chats
    if (store?.chats) {
      for (const [chatJid, chat] of Object.entries(store.chats)) {
        if (chat.lid === cleanLid || chat.lid === `${cleanLid}@lid`) {
          if (chatJid.includes('@s.whatsapp.net')) {
            logger.debug('LID resolved via chat store', { lid: cleanLid, jid: chatJid });
            return chatJid;
          }
        }
      }
    }

    // Method 5: Try socket.store if available (different from our store)
    if (socket.store?.contacts) {
      for (const [jid, contact] of Object.entries(socket.store.contacts)) {
        if (contact.lid === cleanLid || contact.lid === `${cleanLid}@lid`) {
          if (jid.includes('@s.whatsapp.net')) {
            logger.debug('LID resolved via socket.store', { lid: cleanLid, jid });
            return jid;
          }
        }
      }
    }

    return null;
  } catch (error) {
    logger.debug('resolvePhoneFromLid error', { error: error.message, lid: cleanLid });
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
