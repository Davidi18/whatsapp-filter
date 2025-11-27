/**
 * Webhook service for forwarding messages to n8n
 */

const axios = require('axios');
const logger = require('../utils/logger');

let webhookUrl = process.env.WEBHOOK_URL;
let lastSuccess = null;
let lastError = null;
let consecutiveFailures = 0;

/**
 * Initialize webhook service
 */
function init(url) {
  if (url) {
    webhookUrl = url;
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
    consecutiveFailures
  };
}

/**
 * Forward message/event to n8n webhook
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
}

module.exports = {
  init,
  getUrl,
  getHealth,
  forward,
  test,
  resetStats
};
