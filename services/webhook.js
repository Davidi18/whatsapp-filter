/**
 * Webhook service for forwarding messages to n8n and secondary endpoints
 * Supports per-type webhook routing
 */

const axios = require('axios');
const logger = require('../utils/logger');

// Default webhook URL
let defaultWebhookUrl = process.env.WEBHOOK_URL || '';
let secondaryWebhookUrl = process.env.SECONDARY_WEBHOOK_URL;

// Per-type webhook URLs: { TYPE_NAME: 'https://...' }
let typeWebhooks = {};

// Stats tracking
let lastSuccess = null;
let lastError = null;
let consecutiveFailures = 0;

// Secondary webhook stats
let secondaryStats = {
  lastSuccess: null,
  lastError: null,
  consecutiveFailures: 0
};

// Per-type stats
let typeStats = {};

/**
 * Initialize webhook service
 */
function init(url, secondaryUrl) {
  if (url !== undefined) {
    defaultWebhookUrl = url || '';
  }
  if (secondaryUrl) {
    secondaryWebhookUrl = secondaryUrl;
  } else if (process.env.SECONDARY_WEBHOOK_URL) {
    secondaryWebhookUrl = process.env.SECONDARY_WEBHOOK_URL;
  }

  if (secondaryWebhookUrl) {
    logger.info('Secondary webhook configured', { url: secondaryWebhookUrl });
  }
}

/**
 * Set type-specific webhooks
 * @param {Object} webhooks - Map of type to webhook URL, e.g., { VIP: 'https://...', BUSINESS: 'https://...' }
 */
function setTypeWebhooks(webhooks) {
  typeWebhooks = webhooks || {};
  logger.info('Type webhooks configured', { types: Object.keys(typeWebhooks) });
}

/**
 * Get webhook URL for a specific type
 * Falls back to default if no type-specific webhook exists
 */
function getWebhookForType(entityType) {
  if (entityType && typeWebhooks[entityType]) {
    return typeWebhooks[entityType];
  }
  return defaultWebhookUrl;
}

/**
 * Get default webhook URL
 */
function getUrl() {
  return defaultWebhookUrl;
}

/**
 * Get all type webhooks
 */
function getTypeWebhooks() {
  return { ...typeWebhooks };
}

/**
 * Get webhook health status
 */
function getHealth() {
  return {
    url: defaultWebhookUrl,
    configured: !!defaultWebhookUrl || Object.keys(typeWebhooks).length > 0,
    healthy: consecutiveFailures === 0,
    lastSuccess,
    lastError,
    consecutiveFailures,
    typeWebhooks: Object.keys(typeWebhooks).length > 0 ? {
      configured: Object.keys(typeWebhooks),
      stats: typeStats
    } : null,
    secondary: secondaryWebhookUrl ? {
      url: secondaryWebhookUrl,
      configured: true,
      healthy: secondaryStats.consecutiveFailures === 0,
      lastSuccess: secondaryStats.lastSuccess,
      lastError: secondaryStats.lastError,
      consecutiveFailures: secondaryStats.consecutiveFailures
    } : null
  };
}

/**
 * Forward to secondary webhook (non-blocking)
 */
async function forwardToSecondary(payload, metadata) {
  if (!secondaryWebhookUrl) return;

  const { sourceId = '', sourceType = 'unknown', event = 'MESSAGES_UPSERT', entityType = '' } = metadata;

  try {
    await axios.post(secondaryWebhookUrl, payload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Filter-Source': 'whatsapp-filter',
        'X-Source-Id': sourceId,
        'X-Source-Type': sourceType,
        'X-Entity-Type': entityType,
        'X-Event-Type': event
      }
    });

    secondaryStats.lastSuccess = new Date().toISOString();
    secondaryStats.consecutiveFailures = 0;
    secondaryStats.lastError = null;

    logger.debug('Message forwarded to secondary webhook', { sourceId, event });
  } catch (error) {
    secondaryStats.consecutiveFailures++;
    secondaryStats.lastError = {
      message: error.message,
      timestamp: new Date().toISOString(),
      code: error.code || error.response?.status
    };

    logger.error('Failed to forward to secondary webhook', {
      sourceId,
      event,
      error: error.message
    });
    // Don't throw - secondary webhook failure shouldn't block primary
  }
}

/**
 * Forward message/event to webhook (with type-based routing)
 * Retries up to 3 times with exponential backoff (1s, 2s, 4s delays)
 * to handle transient failures like server restart during reconnect bursts.
 */
async function forward(payload, metadata = {}) {
  const {
    sourceId = '',
    sourceType = 'unknown',
    event = 'MESSAGES_UPSERT',
    entityType = ''
  } = metadata;

  // Get webhook URL based on entity type
  const targetUrl = getWebhookForType(entityType);

  if (!targetUrl) {
    throw new Error('No webhook URL configured');
  }

  // Forward to secondary webhook (non-blocking)
  forwardToSecondary(payload, metadata).catch(() => {});

  const MAX_RETRIES = 3;
  const headers = {
    'Content-Type': 'application/json',
    'X-Filter-Source': 'whatsapp-filter',
    'X-Source-Id': sourceId,
    'X-Source-Type': sourceType,
    'X-Entity-Type': entityType,
    'X-Event-Type': event
  };

  let lastAttemptError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const timeout = attempt === 1 ? 5000 : 10000;
      await axios.post(targetUrl, payload, { timeout, headers });

      lastSuccess = new Date().toISOString();
      consecutiveFailures = 0;
      lastError = null;

      if (entityType) {
        if (!typeStats[entityType]) typeStats[entityType] = { successes: 0, failures: 0, lastSuccess: null };
        typeStats[entityType].successes++;
        typeStats[entityType].lastSuccess = lastSuccess;
      }

      if (attempt > 1) {
        logger.info('Message forwarded to webhook after retry', { sourceId, sourceType, entityType, event, attempt });
      } else {
        logger.debug('Message forwarded to webhook', { sourceId, sourceType, entityType, event });
      }

      return { success: true, usedUrl: targetUrl, attempt };
    } catch (error) {
      lastAttemptError = error;
      const status = error.response?.status;
      const isRetryable = !status || status >= 500;

      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        logger.warn('Webhook forward failed, retrying', {
          sourceId, event, attempt, nextAttempt: attempt + 1, retryDelay: delay, error: error.message
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  consecutiveFailures++;
  lastError = {
    message: lastAttemptError.message,
    timestamp: new Date().toISOString(),
    code: lastAttemptError.code || lastAttemptError.response?.status
  };

  if (entityType) {
    if (!typeStats[entityType]) typeStats[entityType] = { successes: 0, failures: 0, lastError: null };
    typeStats[entityType].failures++;
    typeStats[entityType].lastError = lastError;
  }

  logger.error('Failed to forward message after all retries', {
    sourceId, sourceType, entityType, event,
    error: lastAttemptError.message, consecutiveFailures, maxRetries: MAX_RETRIES
  });

  throw lastAttemptError;
}

/**
 * Test webhook connection
 */
async function test(entityType = null) {
  const targetUrl = entityType ? getWebhookForType(entityType) : defaultWebhookUrl;

  if (!targetUrl) {
    return { success: false, error: 'No webhook URL configured' };
  }

  const testPayload = {
    test: true,
    timestamp: new Date().toISOString(),
    message: 'WhatsApp Filter webhook test',
    source: 'whatsapp-filter',
    entityType: entityType || 'default'
  };

  try {
    await axios.post(targetUrl, testPayload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Filter-Source': 'whatsapp-filter-test',
        'X-Entity-Type': entityType || 'default'
      }
    });

    lastSuccess = new Date().toISOString();
    consecutiveFailures = 0;

    return { success: true, testedUrl: targetUrl };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code || error.response?.status,
      testedUrl: targetUrl
    };
  }
}

/**
 * Reset webhook stats
 */
function resetStats() {
  lastSuccess = null;
  lastError = null;
  consecutiveFailures = 0;
  typeStats = {};
  secondaryStats = {
    lastSuccess: null,
    lastError: null,
    consecutiveFailures: 0
  };
}

module.exports = {
  init,
  setTypeWebhooks,
  getWebhookForType,
  getUrl,
  getTypeWebhooks,
  getHealth,
  forward,
  test,
  resetStats
};
