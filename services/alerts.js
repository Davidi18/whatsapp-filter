/**
 * Alert service for sending notifications (Slack, webhook)
 */

const axios = require('axios');
const logger = require('../utils/logger');
const statsService = require('./stats');

const ALERT_LEVELS = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info'
};

const LEVEL_COLORS = {
  critical: '#FF0000',
  warning: '#FFA500',
  info: '#00FF00'
};

const LEVEL_ICONS = {
  critical: ':red_circle:',
  warning: ':warning:',
  info: ':large_green_circle:'
};

/**
 * Send alert to all configured channels
 */
async function send(alert) {
  const {
    level = ALERT_LEVELS.INFO,
    event,
    title,
    message,
    details = {},
    actions = []
  } = alert;

  const alertPayload = {
    id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    source: 'whatsapp-filter',
    instance: process.env.INSTANCE_NAME || 'main',
    level,
    event,
    title,
    message,
    details,
    actions
  };

  logger.alert(level, event, message);

  const promises = [];

  // Send to alerts webhook
  if (process.env.ALERTS_WEBHOOK_URL) {
    promises.push(sendToWebhook(alertPayload));
  }

  // Send to Slack for critical and warning alerts
  if (process.env.SLACK_WEBHOOK_URL && (level === ALERT_LEVELS.CRITICAL || level === ALERT_LEVELS.WARNING)) {
    promises.push(sendToSlack(alertPayload));
  }

  if (promises.length === 0) {
    logger.debug('No alert channels configured');
    return { sent: false, reason: 'no_channels_configured' };
  }

  try {
    await Promise.allSettled(promises);
    statsService.incrementAlert(level, true);
    return { sent: true };
  } catch (error) {
    statsService.incrementAlert(level, false);
    return { sent: false, error: error.message };
  }
}

/**
 * Send alert to webhook endpoint
 */
async function sendToWebhook(payload) {
  const url = process.env.ALERTS_WEBHOOK_URL;
  if (!url) return;

  try {
    await axios.post(url, payload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-Alert-Source': 'whatsapp-filter',
        'X-Alert-Level': payload.level
      }
    });
    logger.debug('Alert sent to webhook', { event: payload.event });
  } catch (error) {
    logger.error('Failed to send alert to webhook', { error: error.message });
    throw error;
  }
}

/**
 * Send alert to Slack
 */
async function sendToSlack(payload) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  const slackMessage = formatSlackMessage(payload);

  try {
    await axios.post(url, slackMessage, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    logger.debug('Alert sent to Slack', { event: payload.event });
  } catch (error) {
    logger.error('Failed to send alert to Slack', { error: error.message });
    throw error;
  }
}

/**
 * Format message for Slack
 */
function formatSlackMessage(payload) {
  const color = LEVEL_COLORS[payload.level] || LEVEL_COLORS.info;
  const icon = LEVEL_ICONS[payload.level] || LEVEL_ICONS.info;

  const fields = [
    {
      type: 'mrkdwn',
      text: `*Instance:*\n${payload.instance}`
    },
    {
      type: 'mrkdwn',
      text: `*Time:*\n${new Date(payload.timestamp).toLocaleString()}`
    }
  ];

  // Add details as fields
  if (payload.details) {
    if (payload.details.phoneNumber) {
      fields.push({
        type: 'mrkdwn',
        text: `*Phone:*\n${payload.details.phoneNumber}`
      });
    }
    if (payload.details.reason) {
      fields.push({
        type: 'mrkdwn',
        text: `*Reason:*\n${payload.details.reason}`
      });
    }
    if (payload.details.previousState) {
      fields.push({
        type: 'mrkdwn',
        text: `*Previous State:*\n${payload.details.previousState}`
      });
    }
    if (payload.details.newState) {
      fields.push({
        type: 'mrkdwn',
        text: `*New State:*\n${payload.details.newState}`
      });
    }
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${icon} ${payload.title}`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: payload.message
      }
    },
    {
      type: 'section',
      fields: fields.slice(0, 10) // Slack limit
    }
  ];

  // Add action buttons if provided
  if (payload.actions && payload.actions.length > 0) {
    const actionElements = payload.actions.map(action => ({
      type: 'button',
      text: {
        type: 'plain_text',
        text: action.label,
        emoji: true
      },
      url: action.url.startsWith('http') ? action.url : `${process.env.BASE_URL || ''}${action.url}`
    }));

    blocks.push({
      type: 'actions',
      elements: actionElements.slice(0, 5) // Slack limit
    });
  }

  return {
    attachments: [{
      color,
      blocks
    }]
  };
}

/**
 * Test alert channels
 */
async function test() {
  const testAlert = {
    level: ALERT_LEVELS.INFO,
    event: 'test',
    title: 'Test Alert',
    message: 'This is a test alert from WhatsApp Filter.',
    details: {
      test: true,
      timestamp: new Date().toISOString()
    },
    actions: [
      { label: 'View Dashboard', url: '/' }
    ]
  };

  return await send(testAlert);
}

module.exports = {
  ALERT_LEVELS,
  send,
  test
};
