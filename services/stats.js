/**
 * Statistics tracking & persistence service
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const STATS_FILE = path.join(__dirname, '..', 'config', 'stats.json');
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const RECENT_EVENTS_LIMIT = parseInt(process.env.RECENT_EVENTS_LIMIT) || 100;

// All known Evolution API events
const KNOWN_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'MESSAGES_DELETE',
  'MESSAGES_SET',
  'SEND_MESSAGE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
  'LOGOUT_INSTANCE',
  'REMOVE_INSTANCE',
  'APPLICATION_STARTUP',
  'CHATS_SET',
  'CHATS_UPDATE',
  'CHATS_UPSERT',
  'CHATS_DELETE',
  'GROUPS_UPSERT',
  'GROUP_UPDATE',
  'GROUP_PARTICIPANTS_UPDATE',
  'CONTACTS_SET',
  'CONTACTS_UPDATE',
  'CONTACTS_UPSERT',
  'CALL',
  'LABELS_ASSOCIATION',
  'LABELS_EDIT',
  'PRESENCE_UPDATE',
  'TYPEBOT_START',
  'TYPEBOT_CHANGE_STATUS'
];

// Initialize stats structure
function createEmptyEventStats() {
  return {
    total: 0,
    filtered: 0,
    forwarded: 0,
    failed: 0,
    lastReceived: null
  };
}

function createDefaultStats() {
  const events = {};
  KNOWN_EVENTS.forEach(event => {
    events[event] = createEmptyEventStats();
  });

  return {
    events,
    alerts: {
      sent: 0,
      failed: 0,
      byLevel: {
        critical: 0,
        warning: 0,
        info: 0
      }
    },
    recentEvents: [],
    session: {
      startedAt: new Date().toISOString(),
      lastSaved: null
    },
    // Legacy stats for backward compatibility
    legacy: {
      totalMessages: 0,
      filteredMessages: 0,
      allowedMessages: 0
    }
  };
}

let stats = createDefaultStats();
let saveTimer = null;

/**
 * Load stats from file
 */
async function load() {
  try {
    const data = await fs.readFile(STATS_FILE, 'utf8');
    const savedStats = JSON.parse(data);

    // Merge with defaults to handle new events
    stats = {
      ...createDefaultStats(),
      ...savedStats,
      events: {
        ...createDefaultStats().events,
        ...(savedStats.events || {})
      },
      alerts: {
        ...createDefaultStats().alerts,
        ...(savedStats.alerts || {})
      }
    };

    // Update session start time
    stats.session.startedAt = new Date().toISOString();

    logger.info('Statistics loaded', { eventsTracked: Object.keys(stats.events).length });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Failed to load stats', { error: error.message });
    }
    stats = createDefaultStats();
  }
}

/**
 * Save stats to file
 */
async function save() {
  try {
    stats.session.lastSaved = new Date().toISOString();
    await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
    logger.debug('Statistics saved');
  } catch (error) {
    logger.error('Failed to save stats', { error: error.message });
  }
}

/**
 * Start periodic save timer
 */
function startAutoSave() {
  if (saveTimer) return;

  saveTimer = setInterval(() => {
    save().catch(err => logger.error('Auto-save failed', { error: err.message }));
  }, SAVE_INTERVAL);

  // Ensure save on exit
  process.on('SIGTERM', async () => {
    await save();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await save();
    process.exit(0);
  });
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
 * Check if event exists in stats
 */
function hasEvent(eventType) {
  return !!stats.events[eventType];
}

/**
 * Initialize a new event type
 */
function initEvent(eventType) {
  if (!stats.events[eventType]) {
    stats.events[eventType] = createEmptyEventStats();
  }
}

/**
 * Increment a stat counter
 */
function increment(eventType, field = 'total') {
  if (!stats.events[eventType]) {
    initEvent(eventType);
  }

  if (typeof stats.events[eventType][field] === 'number') {
    stats.events[eventType][field]++;
  }

  if (field === 'total') {
    stats.events[eventType].lastReceived = new Date().toISOString();
  }

  // Update legacy stats for backward compatibility
  if (eventType === 'MESSAGES_UPSERT') {
    stats.legacy.totalMessages++;
    if (field === 'forwarded') {
      stats.legacy.allowedMessages++;
    } else if (field === 'filtered') {
      stats.legacy.filteredMessages++;
    }
  }
}

/**
 * Increment alert counter
 */
function incrementAlert(level, success = true) {
  if (success) {
    stats.alerts.sent++;
    if (stats.alerts.byLevel[level] !== undefined) {
      stats.alerts.byLevel[level]++;
    }
  } else {
    stats.alerts.failed++;
  }
}

/**
 * Log an event to recent events
 */
function logEvent(eventData) {
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    ...eventData
  };

  stats.recentEvents.unshift(event);

  // Trim to limit
  if (stats.recentEvents.length > RECENT_EVENTS_LIMIT) {
    stats.recentEvents = stats.recentEvents.slice(0, RECENT_EVENTS_LIMIT);
  }

  return event;
}

/**
 * Get recent events with optional filtering
 */
function getRecentEvents(options = {}) {
  const { limit = 50, eventType = null, offset = 0 } = options;

  let events = stats.recentEvents;

  if (eventType) {
    events = events.filter(e => e.event === eventType);
  }

  const total = events.length;
  events = events.slice(offset, offset + limit);

  return {
    events,
    total,
    hasMore: offset + events.length < total
  };
}

/**
 * Get all stats
 */
function getStats() {
  // Calculate totals
  let totalEvents = 0;
  let messagesForwarded = 0;
  let messagesFiltered = 0;

  Object.values(stats.events).forEach(eventStats => {
    totalEvents += eventStats.total;
  });

  if (stats.events.MESSAGES_UPSERT) {
    messagesForwarded = stats.events.MESSAGES_UPSERT.forwarded;
    messagesFiltered = stats.events.MESSAGES_UPSERT.filtered;
  }

  return {
    events: stats.events,
    totals: {
      allEvents: totalEvents,
      messagesForwarded,
      messagesFiltered,
      alertsSent: stats.alerts.sent
    },
    alerts: stats.alerts,
    period: {
      start: stats.session.startedAt,
      lastSaved: stats.session.lastSaved
    }
  };
}

/**
 * Get legacy stats (for backward compatibility)
 */
function getLegacyStats() {
  return {
    totalMessages: stats.legacy.totalMessages,
    filteredMessages: stats.legacy.filteredMessages,
    allowedMessages: stats.legacy.allowedMessages
  };
}

/**
 * Import legacy stats from old config
 */
function importLegacy(legacyStats) {
  if (legacyStats) {
    stats.legacy = {
      totalMessages: legacyStats.totalMessages || 0,
      filteredMessages: legacyStats.filteredMessages || 0,
      allowedMessages: legacyStats.allowedMessages || 0
    };
  }
}

module.exports = {
  load,
  save,
  startAutoSave,
  stopAutoSave,
  hasEvent,
  initEvent,
  increment,
  incrementAlert,
  logEvent,
  getRecentEvents,
  getStats,
  getLegacyStats,
  importLegacy,
  KNOWN_EVENTS
};
