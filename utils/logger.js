/**
 * Structured logging utility
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] || LOG_LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, context = {}) {
  const base = {
    timestamp: formatTimestamp(),
    level: level.toUpperCase(),
    message
  };

  if (Object.keys(context).length > 0) {
    return { ...base, ...context };
  }
  return base;
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= currentLevel;
}

function log(level, message, context = {}) {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, message, context);

  // For production, output structured JSON
  if (process.env.NODE_ENV === 'production') {
    console[level === 'error' ? 'error' : 'log'](JSON.stringify(formatted));
  } else {
    // For development, output human-readable format
    const icon = {
      debug: '🔍',
      info: 'ℹ️ ',
      warn: '⚠️ ',
      error: '❌'
    }[level];

    const contextStr = Object.keys(context).length > 0
      ? ` ${JSON.stringify(context)}`
      : '';

    console[level === 'error' ? 'error' : 'log'](
      `${icon} [${formatted.timestamp}] ${message}${contextStr}`
    );
  }
}

module.exports = {
  debug: (message, context) => log('debug', message, context),
  info: (message, context) => log('info', message, context),
  warn: (message, context) => log('warn', message, context),
  error: (message, context) => log('error', message, context),

  // Event-specific loggers
  event: (eventType, action, details = {}) => {
    log('info', `Event: ${eventType}`, { action, ...details });
  },

  filter: (sourceId, allowed, sourceType = 'contact') => {
    const action = allowed ? 'forwarded' : 'filtered';
    log('info', `Message ${action}`, { sourceId, sourceType, allowed });
  },

  alert: (level, event, message) => {
    log('warn', `Alert: ${event}`, { alertLevel: level, message });
  }
};
