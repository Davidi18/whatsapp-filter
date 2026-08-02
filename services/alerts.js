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

const TELEGRAM_ICONS = {
  critical: '\u{1F534}', // red circle
  warning: '\u{26A0}\u{FE0F}', // warning sign
  info: '\u{1F7E2}' // green circle
};

// Per-event cooldown so reconnect loops don't spam every channel
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS) || 5 * 60 * 1000;
const lastSentAt = new Map();

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

  // Throttle repeated alerts for the same event+level (test alerts are never throttled)
  if (event !== 'test') {
    const cooldownKey = `${event}:${level}`;
    const last = lastSentAt.get(cooldownKey);
    if (last && Date.now() - last < ALERT_COOLDOWN_MS) {
      logger.debug('Alert suppressed by cooldown', { event, level });
      return { sent: false, reason: 'cooldown' };
    }
    lastSentAt.set(cooldownKey, Date.now());
  }

  const promises = [];

  // Send to alerts webhook
  if (process.env.ALERTS_WEBHOOK_URL) {
    promises.push(sendToWebhook(alertPayload));
  }

  // Send to Slack for critical and warning alerts
  if (process.env.SLACK_WEBHOOK_URL && (level === ALERT_LEVELS.CRITICAL || level === ALERT_LEVELS.WARNING)) {
    promises.push(sendToSlack(alertPayload));
  }

  // Send to Telegram (all levels)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    promises.push(sendToTelegram(alertPayload));
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
 * Send alert to Telegram (direct bot API - no middleman needed)
 */
async function sendToTelegram(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const icon = TELEGRAM_ICONS[payload.level] || TELEGRAM_ICONS.info;
  const lines = [
    `${icon} <b>${escapeTelegramHtml(payload.title)}</b>`,
    '',
    escapeTelegramHtml(payload.message)
  ];

  const detailLines = [];
  if (payload.details?.reason) detailLines.push(`Reason: ${escapeTelegramHtml(String(payload.details.reason))}`);
  if (payload.details?.phoneNumber) detailLines.push(`Phone: ${escapeTelegramHtml(String(payload.details.phoneNumber))}`);
  if (payload.details?.status) detailLines.push(`Status: ${escapeTelegramHtml(String(payload.details.status))}`);
  if (detailLines.length > 0) {
    lines.push('', ...detailLines);
  }
  lines.push('', `<i>${escapeTelegramHtml(payload.instance)} · ${new Date(payload.timestamp).toLocaleString()}</i>`);

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 5000 });
    logger.debug('Alert sent to Telegram', { event: payload.event });
  } catch (error) {
    logger.error('Failed to send alert to Telegram', { error: error.response?.data?.description || error.message });
    throw error;
  }
}

function escapeTelegramHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/**
 * Get configured alert channels (for UI status display)
 */
function getChannels() {
  return {
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    slack: !!process.env.SLACK_WEBHOOK_URL,
    webhook: !!process.env.ALERTS_WEBHOOK_URL,
    cooldownMs: ALERT_COOLDOWN_MS
  };
}

module.exports = {
  ALERT_LEVELS,
  send,
  test,
  getChannels
};
