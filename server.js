/**
 * WhatsApp Filter Server v2.0
 * Multi-event support with intelligent routing, alerts, and detailed logging
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// Services
const statsService = require('./services/stats');
const connectionService = require('./services/connection');
const alertService = require('./services/alerts');
const webhookService = require('./services/webhook');
const messageStore = require('./services/messageStore');
const baileysService = require('./services/baileys');

// Handlers
const eventRouter = require('./handlers/index');
const baileysEvents = require('./handlers/baileysEvents');

// Utils
const logger = require('./utils/logger');
const { isValidPhone, isValidGroupId, isValidContactType, isValidGroupType, isValidName, normalizeGroupId } = require('./utils/validators');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (nginx, Cloudflare, etc.)
const PORT = process.env.PORT || 3000;
const VERSION = '2.1.0';
const startedAt = new Date().toISOString();
const BAILEYS_ENABLED = process.env.BAILEYS_ENABLED === 'true';

// Validate required environment variables
// WEBHOOK_URL is optional if Baileys mode is enabled (can work standalone)
if (!process.env.WEBHOOK_URL && !BAILEYS_ENABLED) {
  console.error('WEBHOOK_URL environment variable is required (or enable BAILEYS_ENABLED=true)');
  process.exit(1);
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error('ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required');
  process.exit(1);
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // For retro UI styling
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Session token store (in-memory)
const sessions = new Map();
const SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

// Generate secure session token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}, 60 * 60 * 1000); // Clean every hour

// Authentication middleware (supports both Basic Auth and Bearer token)
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Bearer token authentication
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const session = sessions.get(token);

    if (session && Date.now() < session.expiresAt) {
      session.lastActivity = Date.now();
      req.user = session.username;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Basic authentication (fallback for API clients)
  if (auth.startsWith('Basic ')) {
    const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    const [username, password] = credentials;

    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
      req.user = username;
      return next();
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  return res.status(401).json({ error: 'Invalid authentication method' });
}

// IP whitelist middleware (optional)
function ipWhitelist(req, res, next) {
  const allowedIPs = process.env.ALLOWED_IPS?.split(',') || [];

  if (allowedIPs.length === 0) {
    return next(); // No IP restriction
  }

  const clientIP = req.ip || req.connection.remoteAddress;
  const isAllowed = allowedIPs.some(allowedIP => {
    if (allowedIP.includes('/')) {
      // CIDR notation support (basic)
      const [network, mask] = allowedIP.split('/');
      return clientIP.startsWith(network.split('.').slice(0, Math.floor(mask / 8)).join('.'));
    }
    return clientIP === allowedIP;
  });

  if (!isAllowed) {
    return res.status(403).json({ error: 'IP not allowed' });
  }

  next();
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests' }
});
app.use(limiter);

// Configuration
let config = {
  webhookUrl: process.env.WEBHOOK_URL,
  allowedNumbers: [],
  allowedGroups: [],
  stats: {
    totalMessages: 0,
    filteredMessages: 0,
    allowedMessages: 0
  }
};

// Load configuration
async function loadConfig() {
  const validators = require('./utils/validators');

  try {
    const configPath = path.join(__dirname, 'config', 'contacts.json');
    const data = await fs.readFile(configPath, 'utf8');
    const savedConfig = JSON.parse(data);

    // Environment webhook takes precedence over saved config
    const webhookUrl = process.env.WEBHOOK_URL || savedConfig.webhookUrl || '';

    config = {
      ...savedConfig,
      webhookUrl,
      typeWebhooks: savedConfig.typeWebhooks || {},
      customContactTypes: savedConfig.customContactTypes || [],
      customGroupTypes: savedConfig.customGroupTypes || []
    };

    // Initialize webhook service with the URL and type webhooks
    webhookService.init(webhookUrl);
    webhookService.setTypeWebhooks(config.typeWebhooks);

    // Set custom types in validators
    validators.setCustomTypes(config.customContactTypes, config.customGroupTypes);

    // Import legacy stats
    if (savedConfig.stats) {
      statsService.importLegacy(savedConfig.stats);
    }

    logger.info('Configuration loaded', {
      contacts: config.allowedNumbers?.length || 0,
      groups: config.allowedGroups?.length || 0,
      webhookConfigured: !!webhookUrl,
      typeWebhooks: Object.keys(config.typeWebhooks).length,
      customTypes: config.customContactTypes.length + config.customGroupTypes.length,
      webhookSource: process.env.WEBHOOK_URL ? 'env' : (savedConfig.webhookUrl ? 'config' : 'none')
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Failed to load config', { error: error.message });
    } else {
      logger.info('No existing config found, using defaults');
    }
    config.webhookUrl = process.env.WEBHOOK_URL || '';
    config.typeWebhooks = {};
    config.customContactTypes = [];
    config.customGroupTypes = [];
    webhookService.init(config.webhookUrl);
  }

  // Set config for event router
  eventRouter.setConfig(config);
}

// Save configuration
async function saveConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'contacts.json');

    // Ensure config directory exists
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    // Save all configuration
    const configToSave = {
      allowedNumbers: config.allowedNumbers,
      allowedGroups: config.allowedGroups,
      typeWebhooks: config.typeWebhooks || {},
      customContactTypes: config.customContactTypes || [],
      customGroupTypes: config.customGroupTypes || [],
      stats: statsService.getLegacyStats()
    };

    // Only save webhookUrl if it wasn't set via environment
    if (!process.env.WEBHOOK_URL && config.webhookUrl) {
      configToSave.webhookUrl = config.webhookUrl;
    }

    await fs.writeFile(configPath, JSON.stringify(configToSave, null, 2));
    logger.debug('Configuration saved');
  } catch (error) {
    logger.error('Failed to save config', { error: error.message });
  }
}

// Apply authentication and IP whitelist to admin routes
app.use('/api', authMiddleware);
app.use('/', ipWhitelist);

// ============ AUTH ENDPOINTS (PUBLIC) ============

// Login endpoint
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    const token = generateToken();
    const expiresAt = Date.now() + SESSION_EXPIRY;

    sessions.set(token, {
      username,
      createdAt: Date.now(),
      expiresAt,
      lastActivity: Date.now()
    });

    logger.info('User logged in', { username });

    return res.json({
      success: true,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      username
    });
  }

  logger.warn('Failed login attempt', { username });
  return res.status(401).json({ error: 'Invalid credentials' });
});

// Logout endpoint
app.post('/auth/logout', (req, res) => {
  const auth = req.headers.authorization;

  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (sessions.has(token)) {
      const session = sessions.get(token);
      logger.info('User logged out', { username: session.username });
      sessions.delete(token);
    }
  }

  res.json({ success: true });
});

// Verify token endpoint
app.get('/auth/verify', (req, res) => {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }

  const token = auth.slice(7);
  const session = sessions.get(token);

  if (session && Date.now() < session.expiresAt) {
    return res.json({
      valid: true,
      username: session.username,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  }

  return res.status(401).json({ valid: false });
});

// Serve static files
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// ============ PUBLIC ENDPOINTS ============

// Health check (no auth required)
app.get('/health', (req, res) => {
  const stats = statsService.getStats();
  const connection = connectionService.getState();
  const baileysStatus = baileysService.getStatus();

  // Use Baileys connection status if enabled
  const effectiveConnection = BAILEYS_ENABLED ? {
    status: baileysStatus.status,
    phone: baileysStatus.phoneNumber,
    source: 'baileys'
  } : {
    status: connection.status,
    phone: connection.phoneNumber,
    source: 'evolution'
  };

  res.json({
    status: 'OK',
    version: VERSION,
    uptime: process.uptime(),
    mode: BAILEYS_ENABLED ? 'baileys' : 'evolution',
    connection: effectiveConnection,
    baileys: BAILEYS_ENABLED ? {
      enabled: true,
      status: baileysStatus.status,
      hasQRCode: baileysStatus.hasQRCode
    } : { enabled: false },
    stats: {
      messagesForwarded: stats.totals.messagesForwarded,
      messagesFiltered: stats.totals.messagesFiltered,
      totalContacts: config.allowedNumbers?.length || 0,
      totalGroups: config.allowedGroups?.length || 0
    },
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// API Documentation
app.get('/docs', (req, res) => {
  res.json({
    title: 'WhatsApp Filter API Documentation',
    version: VERSION,
    base_url: req.protocol + '://' + req.get('host'),
    authentication: 'Basic Auth required for all /api/* endpoints',
    endpoints: {
      'GET /health': {
        description: 'System health check with connection status',
        auth_required: false
      },
      'GET /api/status': {
        description: 'Detailed system status',
        auth_required: true
      },
      'GET /api/stats': {
        description: 'Event statistics',
        auth_required: true
      },
      'GET /api/events/recent': {
        description: 'Recent events log',
        auth_required: true,
        query_params: { limit: 'number (default 50)', event: 'event type filter' }
      },
      'GET /api/connection': {
        description: 'Connection status and history',
        auth_required: true
      },
      'GET /api/qrcode': {
        description: 'Get QR code if available',
        auth_required: true
      },
      'GET /api/config': {
        description: 'Get all contacts and groups',
        auth_required: true
      },
      'POST /api/contacts/add': {
        description: 'Add single contact',
        auth_required: true
      },
      'POST /api/groups/add': {
        description: 'Add group',
        auth_required: true
      },
      'POST /api/test-webhook': {
        description: 'Test webhook connection',
        auth_required: true
      },
      'POST /api/test-alert': {
        description: 'Test alert system',
        auth_required: true
      },
      'POST /filter': {
        description: 'Fallback filter endpoint (auto-detects event)',
        auth_required: false
      },
      'POST /filter/:event': {
        description: 'Event-specific filter endpoint',
        auth_required: false
      }
    },
    supported_events: eventRouter.getSupportedEvents(),
    contact_types: ['PERSONAL', 'BUSINESS', 'VIP', 'TEMP']
  });
});

// ============ FILTER ENDPOINTS (NO AUTH) ============

// Main filter endpoint with event type
app.post('/filter/:event', async (req, res) => {
  try {
    // Normalize event name: messages-upsert -> MESSAGES_UPSERT
    const event = req.params.event.toUpperCase().replace(/-/g, '_');
    const payload = req.body;

    await eventRouter.routeEvent(event, payload, req);

    // Auto-save every 100 messages
    const stats = statsService.getStats();
    if (stats.totals.allEvents % 100 === 0) {
      await saveConfig();
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error('Filter error', { error: error.message });
    res.status(500).send('Error');
  }
});

// Fallback filter endpoint (tries to detect event type)
app.post('/filter', async (req, res) => {
  try {
    const payload = req.body;

    // Try to detect event type from payload
    let event = eventRouter.detectEventType(payload);

    // Default to MESSAGES_UPSERT for backward compatibility
    if (!event) {
      event = 'MESSAGES_UPSERT';
    }

    await eventRouter.routeEvent(event, payload, req);

    // Auto-save every 100 messages
    const stats = statsService.getStats();
    if (stats.totals.allEvents % 100 === 0) {
      await saveConfig();
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error('Filter error', { error: error.message });
    res.status(500).send('Error');
  }
});

// ============ PROTECTED API ENDPOINTS ============

// Get system status
app.get('/api/status', (req, res) => {
  const connection = connectionService.getState();
  const webhookHealth = webhookService.getHealth();
  const stats = statsService.getStats();

  res.json({
    connection: {
      status: connection.status,
      lastStatusChange: connection.statusSince,
      instance: connection.instance,
      phoneNumber: connection.phoneNumber
    },
    webhooks: {
      messages: {
        url: webhookHealth.url,
        healthy: webhookHealth.healthy,
        lastSuccess: webhookHealth.lastSuccess,
        consecutiveFailures: webhookHealth.consecutiveFailures
      },
      alerts: {
        url: process.env.ALERTS_WEBHOOK_URL || null,
        configured: !!process.env.ALERTS_WEBHOOK_URL
      },
      slack: {
        configured: !!process.env.SLACK_WEBHOOK_URL
      }
    },
    system: {
      version: VERSION,
      uptime: process.uptime(),
      startedAt,
      totalEvents: stats.totals.allEvents
    }
  });
});

// Get statistics
app.get('/api/stats', (req, res) => {
  res.json(statsService.getStats());
});

// Get recent events
app.get('/api/events/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const eventType = req.query.event || null;
  const offset = parseInt(req.query.offset) || 0;

  res.json(statsService.getRecentEvents({ limit, eventType, offset }));
});

// Get connection status
app.get('/api/connection', (req, res) => {
  res.json(connectionService.getState());
});

// Get QR code (supports both Evolution API and Baileys)
app.get('/api/qrcode', (req, res) => {
  // If Baileys is enabled, prefer Baileys QR code
  if (BAILEYS_ENABLED) {
    const baileysQR = baileysService.getQRCode();
    if (baileysQR.available) {
      return res.json({
        available: true,
        base64: baileysQR.base64,
        source: 'baileys'
      });
    }
  }
  res.json(connectionService.getQRCode());
});

// ============ BAILEYS ENDPOINTS ============

// Get Baileys status
app.get('/api/baileys/status', (req, res) => {
  res.json(baileysService.getStatus());
});

// Connect Baileys
app.post('/api/baileys/connect', async (req, res) => {
  if (!BAILEYS_ENABLED) {
    return res.status(400).json({ error: 'Baileys mode is not enabled. Set BAILEYS_ENABLED=true' });
  }

  try {
    const result = await baileysService.connect();
    res.json({ success: result, message: result ? 'Connecting...' : 'Failed to start connection' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect Baileys
app.post('/api/baileys/disconnect', async (req, res) => {
  try {
    await baileysService.disconnect();
    res.json({ success: true, message: 'Disconnected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logout and clear session
app.post('/api/baileys/logout', async (req, res) => {
  try {
    await baileysService.disconnect();
    await baileysService.clearAuthState();
    res.json({ success: true, message: 'Logged out and session cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message via Baileys
app.post('/api/baileys/send', async (req, res) => {
  if (!BAILEYS_ENABLED) {
    return res.status(400).json({ error: 'Baileys mode is not enabled' });
  }

  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing required fields: to, message' });
  }

  try {
    const result = await baileysService.sendMessage(to, message);
    res.json({ success: true, messageId: result.key.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get configuration
app.get('/api/config', (req, res) => {
  const validators = require('./utils/validators');
  const webhookHealth = webhookService.getHealth();
  res.json({
    contacts: config.allowedNumbers || [],
    groups: config.allowedGroups || [],
    webhookUrl: config.webhookUrl || '',
    typeWebhooks: config.typeWebhooks || {},
    stats: statsService.getLegacyStats(),
    webhookConfigured: webhookHealth.configured,
    webhookFromEnv: !!process.env.WEBHOOK_URL,
    types: {
      contact: validators.getValidContactTypes(),
      group: validators.getValidGroupTypes()
    }
  });
});

// Update webhook URL
app.post('/api/webhook', async (req, res) => {
  try {
    // Check if webhook is locked by environment variable
    if (process.env.WEBHOOK_URL) {
      return res.status(403).json({
        error: 'Webhook URL is set via environment variable and cannot be changed from UI',
        source: 'env'
      });
    }

    const { url } = req.body;

    // Validate URL format (allow empty to clear)
    if (url && typeof url === 'string' && url.trim()) {
      try {
        new URL(url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
      }
    }

    const webhookUrl = url?.trim() || '';
    config.webhookUrl = webhookUrl;
    webhookService.init(webhookUrl);
    await saveConfig();

    logger.info('Webhook URL updated', { configured: !!webhookUrl });

    res.json({
      success: true,
      configured: !!webhookUrl,
      url: webhookUrl
    });
  } catch (error) {
    logger.error('Failed to update webhook URL', { error: error.message });
    res.status(500).json({ error: 'Failed to update webhook URL' });
  }
});

// Test webhook connection
app.post('/api/webhook/test', async (req, res) => {
  try {
    const { entityType } = req.body;
    const result = await webhookService.test(entityType);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get/Set type-specific webhooks
app.get('/api/webhooks/types', (req, res) => {
  const validators = require('./utils/validators');
  res.json({
    typeWebhooks: config.typeWebhooks || {},
    availableTypes: {
      contact: validators.getValidContactTypes(),
      group: validators.getValidGroupTypes()
    }
  });
});

app.post('/api/webhooks/types', async (req, res) => {
  try {
    const { typeWebhooks } = req.body;

    if (!typeWebhooks || typeof typeWebhooks !== 'object') {
      return res.status(400).json({ error: 'Invalid typeWebhooks format' });
    }

    // Validate URLs
    for (const [type, url] of Object.entries(typeWebhooks)) {
      if (url && typeof url === 'string' && url.trim()) {
        try {
          new URL(url);
        } catch {
          return res.status(400).json({ error: `Invalid URL for type ${type}` });
        }
      }
    }

    // Filter out empty URLs
    const cleanedWebhooks = {};
    for (const [type, url] of Object.entries(typeWebhooks)) {
      if (url && typeof url === 'string' && url.trim()) {
        cleanedWebhooks[type] = url.trim();
      }
    }

    config.typeWebhooks = cleanedWebhooks;
    webhookService.setTypeWebhooks(cleanedWebhooks);
    await saveConfig();

    logger.info('Type webhooks updated', { types: Object.keys(cleanedWebhooks) });

    res.json({
      success: true,
      typeWebhooks: cleanedWebhooks
    });
  } catch (error) {
    logger.error('Failed to update type webhooks', { error: error.message });
    res.status(500).json({ error: 'Failed to update type webhooks' });
  }
});

// Custom types management
app.get('/api/types', (req, res) => {
  const validators = require('./utils/validators');
  res.json({
    contactTypes: {
      default: validators.DEFAULT_CONTACT_TYPES,
      custom: config.customContactTypes || []
    },
    groupTypes: {
      default: validators.DEFAULT_GROUP_TYPES,
      custom: config.customGroupTypes || []
    }
  });
});

app.post('/api/types', async (req, res) => {
  try {
    const validators = require('./utils/validators');
    const { customContactTypes, customGroupTypes } = req.body;

    // Validate types are arrays of strings
    if (customContactTypes !== undefined) {
      if (!Array.isArray(customContactTypes)) {
        return res.status(400).json({ error: 'customContactTypes must be an array' });
      }
      for (const type of customContactTypes) {
        if (typeof type !== 'string' || type.length < 2 || type.length > 20) {
          return res.status(400).json({ error: 'Type names must be 2-20 characters' });
        }
      }
      config.customContactTypes = customContactTypes.map(t => t.toUpperCase());
    }

    if (customGroupTypes !== undefined) {
      if (!Array.isArray(customGroupTypes)) {
        return res.status(400).json({ error: 'customGroupTypes must be an array' });
      }
      for (const type of customGroupTypes) {
        if (typeof type !== 'string' || type.length < 2 || type.length > 20) {
          return res.status(400).json({ error: 'Type names must be 2-20 characters' });
        }
      }
      config.customGroupTypes = customGroupTypes.map(t => t.toUpperCase());
    }

    // Update validators
    validators.setCustomTypes(config.customContactTypes, config.customGroupTypes);
    await saveConfig();

    logger.info('Custom types updated', {
      contactTypes: config.customContactTypes,
      groupTypes: config.customGroupTypes
    });

    res.json({
      success: true,
      contactTypes: validators.getValidContactTypes(),
      groupTypes: validators.getValidGroupTypes()
    });
  } catch (error) {
    logger.error('Failed to update custom types', { error: error.message });
    res.status(500).json({ error: 'Failed to update custom types' });
  }
});

// Update contacts (replace all)
app.post('/api/contacts', async (req, res) => {
  try {
    const { contacts } = req.body;

    if (!Array.isArray(contacts)) {
      return res.status(400).json({ error: 'Invalid contacts format' });
    }

    // Validate contacts
    for (const contact of contacts) {
      if (!contact.phone || !contact.name || !contact.type) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
    }

    config.allowedNumbers = contacts;
    eventRouter.setConfig(config);
    await saveConfig();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update contacts' });
  }
});

// Add single contact
app.post('/api/contacts/add', async (req, res) => {
  try {
    const { phone, name, type, lid } = req.body;

    if (!phone || !name || !type) {
      return res.status(400).json({ error: 'Missing required fields: phone, name, type' });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone format. Use country code + number (e.g., 972547554964)' });
    }

    if (!isValidName(name)) {
      return res.status(400).json({ error: 'Name must be 2-50 characters' });
    }

    if (!isValidContactType(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be: PERSONAL, BUSINESS, VIP, or TEMP' });
    }

    // Validate LID format if provided (numeric string, typically 14-20 digits)
    if (lid && (typeof lid !== 'string' || !/^\d{10,25}$/.test(lid))) {
      return res.status(400).json({ error: 'Invalid LID format. Must be 10-25 digits.' });
    }

    if (config.allowedNumbers.some(c => c.phone === phone)) {
      return res.status(409).json({ error: 'Contact already exists' });
    }

    const newContact = { phone, name, type };
    if (lid) {
      newContact.lid = lid;
    }
    config.allowedNumbers.push(newContact);
    eventRouter.setConfig(config);
    await saveConfig();

    res.json({ success: true, contact: newContact });
  } catch (error) {
    logger.error('Failed to add contact', { error: error.message });
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// Get single contact
app.get('/api/contacts/:phone', (req, res) => {
  const phone = req.params.phone;
  const contact = config.allowedNumbers.find(c => c.phone === phone);

  if (!contact) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  res.json({ success: true, contact });
});

// Update single contact
app.put('/api/contacts/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const { name, type, lid } = req.body;

    const contactIndex = config.allowedNumbers.findIndex(c => c.phone === phone);
    if (contactIndex === -1) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = config.allowedNumbers[contactIndex];

    if (name !== undefined) {
      if (!isValidName(name)) {
        return res.status(400).json({ error: 'Name must be 2-50 characters' });
      }
      contact.name = name;
    }

    if (type !== undefined) {
      if (!isValidContactType(type)) {
        return res.status(400).json({ error: 'Invalid type. Must be: PERSONAL, BUSINESS, VIP, or TEMP' });
      }
      contact.type = type;
    }

    // Handle LID field - can be set, updated, or removed (empty string removes it)
    if (lid !== undefined) {
      if (lid === '' || lid === null) {
        delete contact.lid;
      } else if (typeof lid === 'string' && /^\d{10,25}$/.test(lid)) {
        contact.lid = lid;
      } else {
        return res.status(400).json({ error: 'Invalid LID format. Must be 10-25 digits or empty to remove.' });
      }
    }

    eventRouter.setConfig(config);
    await saveConfig();
    res.json({ success: true, contact });
  } catch (error) {
    logger.error('Failed to update contact', { error: error.message });
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// Delete single contact
app.delete('/api/contacts/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const contactIndex = config.allowedNumbers.findIndex(c => c.phone === phone);

    if (contactIndex === -1) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const removedContact = config.allowedNumbers.splice(contactIndex, 1)[0];
    eventRouter.setConfig(config);
    await saveConfig();

    res.json({ success: true, removed: removedContact });
  } catch (error) {
    logger.error('Failed to remove contact', { error: error.message });
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

// ============ GROUP ENDPOINTS ============

// Get all groups
app.get('/api/groups', (req, res) => {
  res.json({ groups: config.allowedGroups || [] });
});

// Add group
app.post('/api/groups/add', async (req, res) => {
  try {
    let { groupId, name, type } = req.body;

    if (!groupId || !name) {
      return res.status(400).json({ error: 'Missing required fields: groupId, name' });
    }

    // Remove @g.us suffix if present
    groupId = normalizeGroupId(groupId);

    // Default type if not provided
    type = type || 'GENERAL';

    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID format' });
    }

    if (!isValidName(name)) {
      return res.status(400).json({ error: 'Name must be 2-50 characters' });
    }

    if (!isValidGroupType(type)) {
      return res.status(400).json({ error: 'Invalid group type' });
    }

    if (!config.allowedGroups) {
      config.allowedGroups = [];
    }

    if (config.allowedGroups.some(g => normalizeGroupId(g.groupId) === groupId)) {
      return res.status(409).json({ error: 'Group already exists' });
    }

    const newGroup = { groupId, name, type };
    config.allowedGroups.push(newGroup);
    eventRouter.setConfig(config);
    await saveConfig();

    res.json({ success: true, group: newGroup });
  } catch (error) {
    logger.error('Failed to add group', { error: error.message });
    res.status(500).json({ error: 'Failed to add group' });
  }
});

// Update group
app.put('/api/groups/:groupId', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.params.groupId);
    const { name, type } = req.body;

    if (!config.allowedGroups) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const groupIndex = config.allowedGroups.findIndex(g => normalizeGroupId(g.groupId) === groupId);
    if (groupIndex === -1) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (name !== undefined) {
      if (!isValidName(name)) {
        return res.status(400).json({ error: 'Name must be 2-50 characters' });
      }
      config.allowedGroups[groupIndex].name = name;
    }

    if (type !== undefined) {
      if (!isValidGroupType(type)) {
        return res.status(400).json({ error: 'Invalid group type' });
      }
      config.allowedGroups[groupIndex].type = type;
    }

    eventRouter.setConfig(config);
    await saveConfig();
    res.json({ success: true, group: config.allowedGroups[groupIndex] });
  } catch (error) {
    logger.error('Failed to update group', { error: error.message });
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Delete group
app.delete('/api/groups/:groupId', async (req, res) => {
  try {
    const groupId = normalizeGroupId(req.params.groupId);

    if (!config.allowedGroups) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const groupIndex = config.allowedGroups.findIndex(g => normalizeGroupId(g.groupId) === groupId);
    if (groupIndex === -1) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const removedGroup = config.allowedGroups.splice(groupIndex, 1)[0];
    eventRouter.setConfig(config);
    await saveConfig();

    res.json({ success: true, removed: removedGroup });
  } catch (error) {
    logger.error('Failed to remove group', { error: error.message });
    res.status(500).json({ error: 'Failed to remove group' });
  }
});

// ============ TEST ENDPOINTS ============

// Test webhook
app.post('/api/test-webhook', async (req, res) => {
  const result = await webhookService.test();

  if (result.success) {
    res.json({ success: true, message: 'Webhook test successful' });
  } else {
    res.status(500).json({
      success: false,
      error: 'Webhook test failed',
      details: result.error
    });
  }
});

// Test alerts
app.post('/api/test-alert', async (req, res) => {
  const result = await alertService.test();

  if (result.sent) {
    res.json({ success: true, message: 'Alert test sent' });
  } else {
    res.status(result.reason === 'no_channels_configured' ? 400 : 500).json({
      success: false,
      error: 'Alert test failed',
      details: result.reason || result.error
    });
  }
});

// Webhook URL is read-only
app.post('/api/webhook', (req, res) => {
  res.status(400).json({
    error: 'Webhook URL is configured via WEBHOOK_URL environment variable',
    current_url: config.webhookUrl
  });
});

// ============ MESSAGE STORAGE ENDPOINTS ============

// Get messages for a phone number
app.get('/api/messages', (req, res) => {
  const { phone, limit, offset } = req.query;

  if (!phone) {
    return res.status(400).json({ error: 'Missing required parameter: phone' });
  }

  const result = messageStore.getMessages(phone, {
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0
  });

  res.json(result);
});

// Get all phones with stored messages
app.get('/api/messages/phones', (req, res) => {
  const phones = messageStore.getPhones();
  res.json({ phones });
});

// Get message store stats
app.get('/api/messages/stats', (req, res) => {
  res.json(messageStore.getStats());
});

// Delete messages for a phone number
app.delete('/api/messages/:phone', async (req, res) => {
  const { phone } = req.params;
  const count = messageStore.deleteMessages(phone);

  if (count === 0) {
    return res.status(404).json({ error: 'No messages found for this phone' });
  }

  await messageStore.save();
  res.json({ success: true, deleted: count });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
async function startServer() {
  // Load configuration
  await loadConfig();

  // Load stats
  await statsService.load();
  statsService.startAutoSave();

  // Load message store
  await messageStore.load();
  messageStore.startAutoSave();

  // Initialize webhook service (only if URL is configured)
  if (config.webhookUrl) {
    webhookService.init(config.webhookUrl);
  }

  // Initialize Baileys if enabled
  if (BAILEYS_ENABLED) {
    baileysEvents.initialize();
    // Auto-connect Baileys on startup
    baileysEvents.start().catch(err => {
      logger.error('Failed to auto-start Baileys', { error: err.message });
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info('WhatsApp Filter Server started', {
      version: VERSION,
      port: PORT,
      baileysEnabled: BAILEYS_ENABLED,
      contacts: config.allowedNumbers?.length || 0,
      groups: config.allowedGroups?.length || 0
    });

    console.log(`WhatsApp Filter Server v${VERSION}`);
    console.log(`Server running on port ${PORT}`);
    console.log(`Mode: ${BAILEYS_ENABLED ? 'BAILEYS (Direct WhatsApp)' : 'Evolution API (Webhook)'}`);

    if (BAILEYS_ENABLED) {
      console.log(`Baileys: Enabled - will connect automatically`);
      console.log(`QR Code: http://localhost:${PORT} (check UI for QR)`);
    } else {
      console.log(`Filter endpoint: http://localhost:${PORT}/filter`);
      console.log(`Filter with event: http://localhost:${PORT}/filter/:event`);
    }

    console.log(`Admin UI: http://localhost:${PORT}`);

    if (config.webhookUrl) {
      console.log(`Webhook target: ${config.webhookUrl}`);
    }

    console.log(`Contacts: ${config.allowedNumbers?.length || 0}`);
    console.log(`Groups: ${config.allowedGroups?.length || 0}`);

    if (process.env.ALERTS_WEBHOOK_URL) {
      console.log(`Alerts webhook: ${process.env.ALERTS_WEBHOOK_URL}`);
    }
    if (process.env.SLACK_WEBHOOK_URL) {
      console.log(`Slack alerts: Configured`);
    }
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  if (BAILEYS_ENABLED) {
    await baileysEvents.stop();
  }
  await saveConfig();
  await statsService.save();
  await messageStore.save();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  if (BAILEYS_ENABLED) {
    await baileysEvents.stop();
  }
  await saveConfig();
  await statsService.save();
  await messageStore.save();
  process.exit(0);
});

startServer().catch(error => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});
