/**
 * Baileys WhatsApp Service
 * Direct WhatsApp connection using Baileys library
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
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
const lidStore = require('./lidStore');
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

// Every connect() bumps this. Events from an older socket are ignored so a
// superseded socket can't schedule reconnects or overwrite the shared state.
let socketGeneration = 0;

// In-flight connect() promise. Two callers (retry timer + watchdog + API) must
// never build two sockets at once - that is what caused the reconnect storms.
let connectInFlight = null;

// Set by disconnect(); keeps the watchdog from undoing a deliberate stop
let manualDisconnect = false;

// After fast retries are exhausted, keep trying at a slow interval instead of giving up
const SLOW_RETRY_INTERVAL = parseInt(process.env.BAILEYS_SLOW_RETRY_MS) || 5 * 60 * 1000;
let slowRetryMode = false;
let reconnectTimer = null;
let nextAttemptAt = 0;

// WhatsApp rejected the client outright: 405 (undocumented "connection
// failure" - stale registration or too many reconnects from this IP) and 403
// (forbidden). Fast retries make it worse, so back off hard and escalate to a
// "re-pair needed" state instead of hammering the endpoint.
const REJECTED_CODES = new Set([403, 405]);
const REJECT_BACKOFF_MS = parseInt(process.env.BAILEYS_REJECT_BACKOFF_MS) || 5 * 60 * 1000;
const REJECT_BACKOFF_MAX_MS = parseInt(process.env.BAILEYS_REJECT_BACKOFF_MAX_MS) || 60 * 60 * 1000;
const REJECTS_BEFORE_REPAIR = parseInt(process.env.BAILEYS_REJECTS_BEFORE_REPAIR) || 3;
let rejectedCount = 0;
let requiresRepair = false;
let lastDisconnectCode = null;

// Consecutive loggedOut (401) closes. Tracked apart from retryCount so an
// unrelated failure streak can never trigger an auth wipe.
let loggedOutCount = 0;

// WhatsApp refuses an outdated protocol version with 405 on the WebSocket
// upgrade - before any QR, before any auth. So the version has to come from a
// live lookup; the copy bundled inside the installed Baileys goes stale and is
// a last resort, not a default. Successful lookups are cached so a reconnect
// loop doesn't re-fetch on every attempt; a fallback is never cached.
const VERSION_CACHE_MS = 6 * 60 * 60 * 1000;
let cachedVersion = null;
let cachedVersionAt = 0;
let versionSource = null;
let versionIsStale = false;
// The version the last attempt actually used - kept for reporting, since a 405
// clears the cache and the status endpoint still has to show what was tried
let lastUsedVersion = null;

// Escape hatch for hosts that can't reach web.whatsapp.com or GitHub:
// BAILEYS_WA_VERSION=2.3000.1043857760
const PINNED_VERSION = (() => {
  const raw = (process.env.BAILEYS_WA_VERSION || '').trim();
  if (!raw) return null;
  const parts = raw.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
    logger.warn('Ignoring malformed BAILEYS_WA_VERSION, expected e.g. 2.3000.1043857760', { value: raw });
    return null;
  }
  return parts;
})();

/**
 * Schedule a reconnect attempt, replacing any pending one.
 * A single timer prevents overlapping connect() chains from creating duplicate sockets.
 */
function scheduleReconnect(delay) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  nextAttemptAt = Date.now() + delay;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(err => logger.error('Scheduled reconnect failed', { error: err.message }));
  }, delay);
}

/**
 * Cancel a pending reconnect and clear the cool-down window
 */
function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  nextAttemptAt = 0;
}

/**
 * Whether another attempt is already coming: a timer is armed, a connect is
 * running, or we are inside a back-off window. The watchdog checks this before
 * forcing a reconnect, so it can no longer stampede on top of our own schedule.
 */
function hasPendingReconnect() {
  return !!reconnectTimer || !!connectInFlight || Date.now() < nextAttemptAt;
}

/**
 * Close and unwire a socket so it stops emitting into our handlers.
 * Without this, a replaced socket keeps its listeners and every close it emits
 * schedules another reconnect - the source of the duplicate-connect storm.
 */
function tearDownSocket(sock = socket) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('creds.update');
    sock.ev.removeAllListeners('messages.upsert');
    sock.ev.removeAllListeners('messages.update');
    sock.ev.removeAllListeners('contacts.upsert');
  } catch (err) {
    logger.debug('Failed to remove socket listeners', { error: err.message });
  }
  try {
    sock.end(undefined);
  } catch (err) {
    logger.debug('Failed to end socket', { error: err.message });
  }
  if (sock === socket) socket = null;
}

/**
 * Resolve the WhatsApp Web protocol version to connect with.
 * Order: env pin -> cached success -> web.whatsapp.com -> Baileys repo ->
 * whatever the installed Baileys bundles (stale, expect 405).
 */
async function getVersion() {
  if (PINNED_VERSION) {
    versionSource = 'env';
    versionIsStale = false;
    return PINNED_VERSION;
  }

  if (cachedVersion && Date.now() - cachedVersionAt < VERSION_CACHE_MS) {
    return cachedVersion;
  }

  // web.whatsapp.com is the source of truth
  try {
    const live = await fetchLatestWaWebVersion({});
    if (live?.isLatest && Array.isArray(live.version)) {
      cachedVersion = live.version;
      cachedVersionAt = Date.now();
      versionSource = 'whatsapp';
      versionIsStale = false;
      return cachedVersion;
    }
    logger.warn('Could not read the WA version from web.whatsapp.com', {
      error: live?.error?.message || 'no client_revision in response'
    });
  } catch (err) {
    logger.warn('Could not read the WA version from web.whatsapp.com', { error: err.message });
  }

  // Second choice: the version file published on the Baileys repo
  const repo = await fetchLatestBaileysVersion();
  if (repo.isLatest && Array.isArray(repo.version)) {
    cachedVersion = repo.version;
    cachedVersionAt = Date.now();
    versionSource = 'baileys-repo';
    versionIsStale = false;
    return cachedVersion;
  }

  // Both lookups failed. What's left is the version compiled into the installed
  // Baileys, which WhatsApp starts refusing (405) as soon as it ages out - so
  // don't cache it, and make the reason loud.
  versionSource = 'bundled-fallback';
  versionIsStale = true;
  logger.error('Both WA version lookups failed, using the version bundled with Baileys', {
    version: repo.version?.join('.'),
    error: repo.error?.message,
    hint: 'WhatsApp answers 405 for outdated versions - allow egress to web.whatsapp.com / raw.githubusercontent.com, upgrade @whiskeysockets/baileys, or set BAILEYS_WA_VERSION'
  });
  return repo.version;
}

// Event callbacks
let onMessageCallback = null;
let onConnectionChangeCallback = null;

// Baileys logger (quiet)
const baileysLogger = pino({ level: 'silent' });

/**
 * Initialize and connect to WhatsApp.
 * Concurrent callers share a single attempt - creating two sockets at once
 * leaves an orphan whose events fight with the live one.
 */
function connect() {
  if (connectInFlight) {
    logger.debug('Connect already in progress, joining in-flight attempt');
    return connectInFlight;
  }
  connectInFlight = doConnect().finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}

async function doConnect() {
  const generation = ++socketGeneration;

  try {
    // Cancel any pending reconnect - this call supersedes it
    cancelReconnect();
    manualDisconnect = false;

    // Drop the previous socket before building a new one
    tearDownSocket();

    // Load persistent LID→Phone mappings
    await lidStore.load();

    // Ensure auth directory exists
    await fs.mkdir(AUTH_DIR, { recursive: true });

    // Get auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Resolve the WA protocol version (a stale one is refused with 405)
    const version = await getVersion();
    lastUsedVersion = version;
    logger.info('Baileys connecting', {
      version: version.join('.'),
      versionSource,
      versionIsStale,
      registered: !!state.creds?.registered,
      attempt: retryCount
    });

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

    // Keep a local handle: `socket` may already point at a newer socket by the
    // time this one's handlers run
    const mySocket = socket;

    // Bind store to socket events (if store exists)
    if (store) {
      store.bind(socket.ev);
    }

    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
      // A newer connect() has taken over - this socket is a leftover and must
      // not touch shared state or schedule reconnects
      if (generation !== socketGeneration) {
        logger.debug('Ignoring update from superseded socket', {
          generation,
          current: socketGeneration,
          connection: update.connection
        });
        return;
      }

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

        logger.warn('Baileys connection closed', {
          statusCode,
          reason,
          // The Boom payload carries WhatsApp's own wording ("Connection
          // Failure", "Stream Errored", ...) which the status code alone hides
          error: lastDisconnect?.error?.message,
          payload: lastDisconnect?.error?.output?.payload,
          data: lastDisconnect?.error?.data,
          version: lastUsedVersion ? lastUsedVersion.join('.') : null,
          versionSource
        });
        connectionStatus = 'disconnected';
        lastDisconnectCode = statusCode || null;
        qrCodeData = null;
        qrCodeBase64 = null;

        // This socket is done - unwire it so it can't emit again
        tearDownSocket(mySocket);

        // loggedOut (401) = either user removed device OR stale session after restart
        // Strategy: on first loggedOut, try reconnecting once (handles restart race condition)
        // Only clear auth + request QR if we get loggedOut twice in a row
        if (statusCode === DisconnectReason.loggedOut) {
          loggedOutCount++;
          if (loggedOutCount === 1) {
            // First loggedOut - might be a stale-session false alarm after restart
            // Try reconnecting once before giving up. Counted separately from
            // retryCount so unrelated failures can't trigger an auth wipe.
            logger.info('Logged out (attempt 1), retrying once before clearing auth', { loggedOutCount });
            scheduleReconnect(2000);
            if (onConnectionChangeCallback) {
              onConnectionChangeCallback({ status: 'disconnected', reason, willReconnect: true });
            }
          } else {
            // Second loggedOut in a row - user genuinely removed device, clear auth
            logger.info('Logged out (confirmed), clearing auth state');
            await clearAuthState();
            retryCount = 0;
            loggedOutCount = 0;
            rejectedCount = 0;
            requiresRepair = false;
            slowRetryMode = false;
            cancelReconnect();
            if (onConnectionChangeCallback) {
              onConnectionChangeCallback({ status: 'disconnected', reason, willReconnect: false });
            }
          }
          return;
        }

        // badSession (500) = server-side session key refresh (normal, ~every 50min)
        // restartRequired (515) = WhatsApp wants a clean reconnect
        // For these: clear socket state but KEEP auth creds, reconnect immediately
        if (statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.restartRequired) {
          logger.info('Session refresh, reconnecting immediately (keeping auth)', { reason });
          retryCount = 0; // don't burn retries on normal session refreshes
          scheduleReconnect(1000);
          if (onConnectionChangeCallback) {
            onConnectionChangeCallback({ status: 'disconnected', reason, willReconnect: true });
          }
          return;
        }

        // 405 / 403 = WhatsApp refused the handshake itself. Fast retries never
        // succeed here and the flood is often what keeps the refusal alive, so
        // back off in growing steps and escalate to "re-pair needed".
        if (REJECTED_CODES.has(statusCode)) {
          rejectedCount++;

          // An outdated protocol version is the most common reason WhatsApp
          // refuses the upgrade, so drop the cached version and re-resolve it
          // on the next attempt instead of retrying with the same one.
          const staleVersionSuspected = versionIsStale || versionSource === 'bundled-fallback';
          cachedVersion = null;
          cachedVersionAt = 0;

          const delay = Math.min(
            REJECT_BACKOFF_MS * Math.pow(2, rejectedCount - 1),
            REJECT_BACKOFF_MAX_MS
          );
          const enteredSlowRetry = !slowRetryMode;
          slowRetryMode = true;
          retryCount = MAX_RETRIES; // fast retries are pointless for this class
          const repairJustDetected = !requiresRepair && rejectedCount >= REJECTS_BEFORE_REPAIR;
          if (repairJustDetected) requiresRepair = true;

          logger.warn('WhatsApp refused the connection, backing off', {
            statusCode,
            consecutiveRejections: rejectedCount,
            nextAttemptInMs: delay,
            staleVersionSuspected,
            requiresRepair
          });
          scheduleReconnect(delay);

          if (onConnectionChangeCallback) {
            onConnectionChangeCallback({
              status: 'disconnected',
              reason,
              statusCode,
              willReconnect: true,
              slowRetryMode,
              enteredSlowRetry,
              rejected: true,
              consecutiveRejections: rejectedCount,
              nextAttemptInMs: delay,
              staleVersionSuspected,
              requiresRepair,
              repairJustDetected
            });
          }
          return;
        }

        // All other reasons: reconnect with backoff up to MAX_RETRIES,
        // then NEVER give up - fall back to slow retries so the connection
        // always recovers eventually without manual intervention
        let enteredSlowRetry = false;
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000); // 1s, 2s, 4s, 8s, 16s
          logger.info('Reconnecting...', { attempt: retryCount, delay });
          scheduleReconnect(delay);
        } else {
          enteredSlowRetry = !slowRetryMode;
          slowRetryMode = true;
          // Log the switch once - re-logging it on every later close is what
          // filled the logs with "max fast retries reached"
          if (enteredSlowRetry) {
            logger.error('Max fast retries reached, switching to slow retry mode', {
              maxRetries: MAX_RETRIES,
              slowRetryIntervalMs: SLOW_RETRY_INTERVAL
            });
          } else {
            logger.warn('Still disconnected, next slow retry scheduled', {
              reason,
              statusCode,
              nextAttemptInMs: SLOW_RETRY_INTERVAL
            });
          }
          scheduleReconnect(SLOW_RETRY_INTERVAL);
        }

        if (onConnectionChangeCallback) {
          onConnectionChangeCallback({
            status: 'disconnected',
            reason,
            statusCode,
            willReconnect: true,
            slowRetryMode,
            enteredSlowRetry
          });
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        retryCount = 0;
        loggedOutCount = 0;
        slowRetryMode = false;
        rejectedCount = 0;
        requiresRepair = false;
        lastDisconnectCode = null;
        cancelReconnect();
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

    // Capture LID↔Phone mappings from contacts sync
    socket.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        if (contact.lid && contact.id?.includes('@s.whatsapp.net')) {
          const phone = contact.id.replace('@s.whatsapp.net', '');
          const lid = contact.lid.replace('@lid', '');
          lidStore.save(lid, phone, contact.name || contact.notify);
        }
      }
      logger.info('Contacts upsert processed for LID mapping', {
        total: contacts.length,
        lidMapSize: lidStore.size()
      });
    });

    return true;
  } catch (error) {
    logger.error('Failed to connect Baileys', { error: error.message });
    connectionStatus = 'error';

    // We cleared the pending timer on the way in and no socket exists to emit a
    // close, so re-arm here - otherwise the only thing left is the watchdog.
    if (generation === socketGeneration && !manualDisconnect) {
      const delay = slowRetryMode || retryCount >= MAX_RETRIES
        ? SLOW_RETRY_INTERVAL
        : Math.min(1000 * Math.pow(2, retryCount++), 30000);
      logger.info('Re-arming reconnect after failed connect attempt', { delay });
      scheduleReconnect(delay);
    }
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
    // Unwrap deviceSentMessage (outgoing messages sent from phone/other devices)
    if (messageContent.deviceSentMessage?.message) {
      logger.debug('Unwrapping deviceSentMessage', { remoteJid, fromMe, destinationJid: messageContent.deviceSentMessage.destinationJid });
      messageContent = messageContent.deviceSentMessage.message;
    }

    // Skip protocol messages (key distribution, etc.) - not real user messages
    if (messageContent.senderKeyDistributionMessage && !messageContent.conversation &&
        !messageContent.extendedTextMessage && !messageContent.imageMessage &&
        !messageContent.videoMessage && !messageContent.audioMessage &&
        !messageContent.documentMessage && !messageContent.stickerMessage &&
        !messageContent.contactMessage && !messageContent.locationMessage &&
        !messageContent.reactionMessage) {
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

      // Source 4: LID persistent mapping table
      if (!senderPhone) {
        const lidId = remoteJid.replace('@lid', '');
        const mapped = lidStore.resolve(lidId);
        if (mapped) {
          senderPhone = mapped.phone;
          logger.info('LID resolved via mapping table', { lid: lidId, phone: senderPhone });
        }
      }

      // If we found a phone number, format it correctly as JID
      if (senderPhone) {
        // Ensure it's just the phone number (no suffix)
        senderPhone = senderPhone.replace('@s.whatsapp.net', '').replace('@lid', '');
        remoteJid = `${senderPhone}@s.whatsapp.net`;

        // Save LID→Phone mapping for future use
        const originalLid = msg.key.remoteJid.replace('@lid', '');
        lidStore.save(originalLid, senderPhone, msg.pushName);
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

        // Try persistent LID mapping table
        if (participant.includes('@lid')) {
          const pLid = participant.replace('@lid', '');
          const mapped = lidStore.resolve(pLid);
          if (mapped) {
            participant = `${mapped.phone}@s.whatsapp.net`;
            logger.info('Participant LID resolved via mapping table', {
              originalParticipant: msg.key.participant,
              resolved: participant
            });
          }
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
 * Fetch all groups the connected account participates in
 */
async function fetchGroups() {
  if (!socket || connectionStatus !== 'connected') {
    throw new Error('Not connected to WhatsApp');
  }

  const groups = await socket.groupFetchAllParticipating();
  return Object.values(groups).map(g => ({
    id: g.id,
    subject: g.subject || '',
    participants: Array.isArray(g.participants) ? g.participants.length : 0,
    owner: g.owner || null,
    creation: g.creation || null
  }));
}

/**
 * Close the WhatsApp connection but KEEP the paired session.
 * Reconnecting later reuses the existing creds - no QR scan needed.
 */
async function disconnect() {
  // Intentional disconnect - cancel any scheduled auto-reconnect and make sure
  // the watchdog doesn't immediately bring it back up
  cancelReconnect();
  manualDisconnect = true;
  slowRetryMode = false;
  retryCount = 0;
  loggedOutCount = 0;
  rejectedCount = 0;

  socketGeneration++; // invalidate any close event still in flight
  tearDownSocket();

  connectionStatus = 'disconnected';
  qrCodeData = null;
  qrCodeBase64 = null;
  phoneNumber = null;
}

/**
 * Unlink this device on WhatsApp's side, then close the socket.
 * Destructive: the session is gone and a new QR/pairing code is required.
 */
async function logout() {
  cancelReconnect();
  manualDisconnect = true;

  if (socket) {
    try {
      await socket.logout();
    } catch (error) {
      logger.warn('Error during logout', { error: error.message });
    }
  }

  slowRetryMode = false;
  retryCount = 0;
  loggedOutCount = 0;
  rejectedCount = 0;
  requiresRepair = false;

  socketGeneration++;
  tearDownSocket();

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
    retryCount,
    slowRetryMode,
    reconnectScheduled: hasPendingReconnect(),
    nextAttemptAt: nextAttemptAt ? new Date(nextAttemptAt).toISOString() : null,
    lastDisconnectCode,
    consecutiveRejections: rejectedCount,
    requiresRepair,
    manualDisconnect,
    waVersion: lastUsedVersion ? lastUsedVersion.join('.') : null,
    waVersionSource: versionSource,
    waVersionStale: versionIsStale
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

/**
 * Request pairing code for a phone number (companion mode - no QR needed)
 * Use this instead of QR to keep phone push notifications active
 */
async function requestPairingCode(phone) {
  if (!socket) {
    throw new Error('Socket not initialized. Call connect() first.');
  }
  if (connectionStatus !== 'waiting_qr') {
    throw new Error(`Cannot request pairing code in state: ${connectionStatus}. Must be waiting_qr.`);
  }
  // phone must be digits only, no + or spaces
  const cleaned = phone.replace(/\D/g, '');
  const code = await socket.requestPairingCode(cleaned);
  logger.info('Pairing code generated', { phone: cleaned });
  return code;
}

module.exports = {
  connect,
  disconnect,
  logout,
  sendMessage,
  sendMedia,
  fetchGroups,
  hasPendingReconnect,
  getStatus,
  getQRCode,
  requestPairingCode,
  onMessage,
  onConnectionChange,
  isEnabled,
  isConnected,
  getSocket,
  clearAuthState
};
