/**
 * Webhook service for forwarding messages to n8n and secondary endpoints
 */

const axios = require('axios');
const logger = require('../utils/logger');

let webhookUrl = process.env.WEBHOOK_URL;
let secondaryWebhookUrl = process.env.SECONDARY_WEBHOOK_URL;
let lastSuccess = null;
let lastError = null;
let consecutiveFailures = 0;

// Secondary webhook stats
let secondaryStats = {
  lastSuccess: null,
  lastError: null,
  consecutiveFailures: 0
};

/**
 * Initialize webhook service
 */
function init(url, secondaryUrl) {
  if (url) {
    webhookUrl = url;
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
 * Get webhook URL
 */
function getUrl() {
  return webhookUrl;
}

/**
 * Get webhook health status
 */
function getHealth() {
  return {
    url: webhookUrl,
    configured: !!webhookUrl,
    healthy: consecutiveFailures === 0,
    lastSuccess,
    lastError,
    consecutiveFailures,
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

  const { sourceId = '', sourceType = 'unknown', event = 'MESSAGES_UPSERT' } = metadata;

  try {
    await axios.post(secondaryWebhookUrl, payload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Filter-Source': 'whatsapp-filter',
        'X-Source-Id': sourceId,
        'X-Source-Type': sourceType,
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
 * Forward message/event to n8n webhook (and secondary if configured)
 */
async function forward(payload, metadata = {}) {
  if (!webhookUrl) {
    throw new Error('No webhook URL configured');
  }

  const {
    sourceId = '',
    sourceType = 'unknown',
    event = 'MESSAGES_UPSERT'
  } = metadata;

  // Forward to secondary webhook (non-blocking)
  forwardToSecondary(payload, metadata).catch(() => {});

  try {
    await axios.post(webhookUrl, payload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Filter-Source': 'whatsapp-filter',
        'X-Source-Id': sourceId,
        'X-Source-Type': sourceType,
        'X-Event-Type': event
      }
    });

    lastSuccess = new Date().toISOString();
    consecutiveFailures = 0;
    lastError = null;

    logger.debug('Message forwarded to webhook', { sourceId, sourceType, event });

    return { success: true };
  } catch (error) {
    consecutiveFailures++;
    lastError = {
      message: error.message,
      timestamp: new Date().toISOString(),
      code: error.code || error.response?.status
    };

    logger.error('Failed to forward message', {
      sourceId,
      sourceType,
      event,
      error: error.message,
      consecutiveFailures
    });

    throw error;
  }
}

/**
 * Test webhook connection
 */
async function test() {
  if (!webhookUrl) {
    return { success: false, error: 'No webhook URL configured' };
  }

  const testPayload = {
    test: true,
    timestamp: new Date().toISOString(),
    message: 'WhatsApp Filter webhook test',
    source: 'whatsapp-filter'
  };

  try {
    await axios.post(webhookUrl, testPayload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Filter-Source': 'whatsapp-filter-test'
      }
    });

    lastSuccess = new Date().toISOString();
    consecutiveFailures = 0;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      code: error.code || error.response?.status
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
  secondaryStats = {
    lastSuccess: null,
    lastError: null,
    consecutiveFailures: 0
  };
}

module.exports = {
  init,
  getUrl,
  getHealth,
  forward,
  test,
  resetStats
};
