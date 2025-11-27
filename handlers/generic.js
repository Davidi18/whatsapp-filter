/**
 * Generic event handler - catch-all for unhandled events
 */

const statsService = require('../services/stats');
const logger = require('../utils/logger');

/**
 * Handle any event not caught by specific handlers
 */
async function handle(payload, context) {
  const { event } = context;

  // Initialize stats for unknown events
  if (!statsService.hasEvent(event)) {
    statsService.initEvent(event);
  }

  statsService.increment(event, 'total');

  // Log for debugging (can be disabled in production)
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug(`Unhandled event: ${event}`, {
      payload: JSON.stringify(payload).slice(0, 200)
    });
  }

  // Skip logging PRESENCE_UPDATE if not enabled (very noisy)
  if (event === 'PRESENCE_UPDATE' && process.env.ENABLE_PRESENCE_LOGGING !== 'true') {
    return { action: 'skipped', event };
  }

  statsService.logEvent({
    event,
    action: 'logged'
  });

  return { action: 'logged', event };
}

module.exports = { handle };
