const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!process.env.WEBHOOK_URL) {
  console.error('❌ WEBHOOK_URL environment variable is required');
  process.exit(1);
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error('❌ ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required');
  process.exit(1);
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // For retro UI styling
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Basic authentication middleware
function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  const [username, password] = credentials;

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    next();
  } else {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
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
      return clientIP.startsWith(network.split('.').slice(0, Math.floor(mask/8)).join('.'));
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
  webhookUrl: process.env.WEBHOOK_URL, // Load from environment
  allowedNumbers: [],
  stats: {
    totalMessages: 0,
    filteredMessages: 0,
    allowedMessages: 0
  }
};

// Load configuration
async function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'contacts.json');
    const data = await fs.readFile(configPath, 'utf8');
    const savedConfig = JSON.parse(data);
    
    // Merge with environment webhook URL (environment takes precedence)
    config = { 
      ...savedConfig, 
      webhookUrl: process.env.WEBHOOK_URL 
    };
    
    console.log('✅ Configuration loaded');
  } catch (error) {
    console.log('ℹ️  No existing config found, using defaults');
    config.webhookUrl = process.env.WEBHOOK_URL;
  }
}

// Save configuration
async function saveConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'contacts.json');
    // Don't save webhook URL to file (it comes from environment)
    const configToSave = { ...config };
    delete configToSave.webhookUrl;
    
    await fs.writeFile(configPath, JSON.stringify(configToSave, null, 2));
    console.log('✅ Configuration saved');
  } catch (error) {
    console.error('❌ Failed to save config:', error);
  }
}

// Apply authentication and IP whitelist to admin routes
app.use('/api', basicAuth);
app.use('/', ipWhitelist);

// Serve static files with authentication
app.use(express.static('public', { 
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// Routes

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    webhook_configured: !!config.webhookUrl,
    total_contacts: config.allowedNumbers?.length || 0,
    version: '2.1.0',
    endpoints: {
      admin_ui: '/',
      api_docs: '/docs',
      health: '/health',
      filter: '/filter'
    }
  });
});

// API Documentation
app.get('/docs', (req, res) => {
  res.json({
    title: "WhatsApp Filter API Documentation",
    version: "2.1.0",
    base_url: req.protocol + '://' + req.get('host'),
    authentication: "Basic Auth required for all /api/* endpoints",
    endpoints: {
      "GET /health": {
        description: "System health check",
        auth_required: false,
        response: "System status and basic info"
      },
      "GET /docs": {
        description: "API documentation",
        auth_required: false,
        response: "This documentation"
      },
      "POST /filter": {
        description: "Webhook endpoint for Evolution API",
        auth_required: false,
        body: "Evolution API message format",
        response: "OK"
      },
      "GET /api/config": {
        description: "Get all contacts and system stats",
        auth_required: true,
        response: {
          contacts: "Array of contact objects",
          webhookUrl: "Configured webhook URL",
          stats: "Message statistics",
          webhookFromEnv: "Boolean"
        }
      },
      "POST /api/contacts": {
        description: "Replace entire contacts list",
        auth_required: true,
        body: {
          contacts: [
            {
              phone: "972-XX-XXX-XXXX",
              name: "Contact Name",
              type: "PERSONAL|BUSINESS|VIP|TEMP"
            }
          ]
        },
        response: { success: true }
      },
      "POST /api/contacts/add": {
        description: "Add single contact",
        auth_required: true,
        body: {
          phone: "972-XX-XXX-XXXX (required)",
          name: "Contact Name (required, 2-50 chars)",
          type: "PERSONAL|BUSINESS|VIP|TEMP (required)"
        },
        response: {
          success: true,
          contact: "Added contact object"
        },
        errors: {
          400: "Missing/invalid fields",
          409: "Contact already exists"
        }
      },
      "GET /api/contacts/:phone": {
        description: "Get specific contact",
        auth_required: true,
        params: {
          phone: "Phone number (e.g., 972555074798)"
        },
        response: {
          success: true,
          contact: "Contact object"
        },
        errors: {
          404: "Contact not found"
        }
      },
      "PUT /api/contacts/:phone": {
        description: "Update contact name and/or type",
        auth_required: true,
        params: {
          phone: "Phone number to update"
        },
        body: {
          name: "New name (optional, 2-50 chars)",
          type: "New type (optional: PERSONAL|BUSINESS|VIP|TEMP)"
        },
        response: {
          success: true,
          contact: "Updated contact object"
        },
        errors: {
          404: "Contact not found",
          400: "Invalid field values"
        }
      },
      "DELETE /api/contacts/:phone": {
        description: "Remove contact",
        auth_required: true,
        params: {
          phone: "Phone number to remove"
        },
        response: {
          success: true,
          removed: "Removed contact object"
        },
        errors: {
          404: "Contact not found"
        }
      },
      "POST /api/test-webhook": {
        description: "Test webhook connection to n8n",
        auth_required: true,
        response: {
          success: true
        },
        errors: {
          400: "No webhook configured",
          500: "Webhook test failed"
        }
      }
    },
    examples: {
      add_contact: {
        url: "POST /api/contacts/add",
        headers: {
          "Authorization": "Basic YWRtaW46cGFzc3dvcmQ=",
          "Content-Type": "application/json"
        },
        body: {
          phone: "972501234567",
          name: "John Doe",
          type: "BUSINESS"
        }
      },
      update_contact: {
        url: "PUT /api/contacts/972501234567",
        headers: {
          "Authorization": "Basic YWRtaW46cGFzc3dvcmQ=",
          "Content-Type": "application/json"
        },
        body: {
          type: "VIP"
        }
      }
    },
    curl_examples: {
      add_contact: `curl -X POST ${req.protocol}://${req.get('host')}/api/contacts/add \\
  -u "admin:password" \\
  -H "Content-Type: application/json" \\
  -d '{"phone": "972501234567", "name": "John Doe", "type": "BUSINESS"}'`,
      get_contacts: `curl -X GET ${req.protocol}://${req.get('host')}/api/config \\
  -u "admin:password"`,
      delete_contact: `curl -X DELETE ${req.protocol}://${req.get('host')}/api/contacts/972501234567 \\
  -u "admin:password"`
    },
    contact_types: {
      PERSONAL: "Personal contacts (friends, family)",
      BUSINESS: "Business contacts (clients, partners)",
      VIP: "VIP contacts (priority handling)",
      TEMP: "Temporary contacts (short-term access)"
    },
    phone_format: "Israeli format: 972-XX-XXX-XXXX or 972XXXXXXXXX",
    notes: [
      "All /api/* endpoints require Basic Authentication",
      "Phone numbers are stored without formatting but validated on input", 
      "Contact names must be 2-50 characters",
      "Webhook URL is configured via WEBHOOK_URL environment variable",
      "System automatically forwards messages from allowed contacts to configured webhook"
    ]
  });
});

// Get configuration
app.get('/api/config', (req, res) => {
  res.json({
    contacts: config.allowedNumbers || [],
    webhookUrl: config.webhookUrl || '',
    stats: config.stats,
    webhookFromEnv: true // Indicate webhook comes from environment
  });
});

// Update contacts
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
    await saveConfig();
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update contacts' });
  }
});

// Add single contact
app.post('/api/contacts/add', async (req, res) => {
  try {
    const { phone, name, type } = req.body;
    
    if (!phone || !name || !type) {
      return res.status(400).json({ error: 'Missing required fields: phone, name, type' });
    }

    // Validate phone format
    const phoneRegex = /^972[-\s]?[1-9]\d{1}[-\s]?\d{3}[-\s]?\d{4}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone format' });
    }

    // Validate name
    if (name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: 'Name must be 2-50 characters' });
    }

    // Validate type
    const validTypes = ['PERSONAL', 'BUSINESS', 'VIP', 'TEMP'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be: PERSONAL, BUSINESS, VIP, or TEMP' });
    }

    // Check if contact already exists
    if (config.allowedNumbers.some(c => c.phone === phone)) {
      return res.status(409).json({ error: 'Contact already exists' });
    }

    const newContact = { phone, name, type };
    config.allowedNumbers.push(newContact);
    await saveConfig();
    
    res.json({ success: true, contact: newContact });
  } catch (error) {
    console.error('Failed to add contact:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// Update single contact
app.put('/api/contacts/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const { name, type } = req.body;
    
    const contactIndex = config.allowedNumbers.findIndex(c => c.phone === phone);
    if (contactIndex === -1) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = config.allowedNumbers[contactIndex];

    // Update fields if provided
    if (name !== undefined) {
      if (name.length < 2 || name.length > 50) {
        return res.status(400).json({ error: 'Name must be 2-50 characters' });
      }
      contact.name = name;
    }

    if (type !== undefined) {
      const validTypes = ['PERSONAL', 'BUSINESS', 'VIP', 'TEMP'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid type. Must be: PERSONAL, BUSINESS, VIP, or TEMP' });
      }
      contact.type = type;
    }
    
    await saveConfig();
    res.json({ success: true, contact });
  } catch (error) {
    console.error('Failed to update contact:', error);
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
    await saveConfig();
    
    res.json({ success: true, removed: removedContact });
  } catch (error) {
    console.error('Failed to remove contact:', error);
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

// Get single contact
app.get('/api/contacts/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const contact = config.allowedNumbers.find(c => c.phone === phone);
    
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    
    res.json({ success: true, contact });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get contact' });
  }
});

// Webhook URL is read-only (comes from environment)
app.post('/api/webhook', (req, res) => {
  res.status(400).json({ 
    error: 'Webhook URL is configured via WEBHOOK_URL environment variable',
    current_url: config.webhookUrl
  });
});

// Test webhook
app.post('/api/test-webhook', async (req, res) => {
  try {
    if (!config.webhookUrl) {
      return res.status(400).json({ error: 'No webhook URL configured' });
    }

    const testMessage = {
      test: true,
      timestamp: new Date().toISOString(),
      message: 'Filter system test',
      source: 'whatsapp-filter'
    };

    await axios.post(config.webhookUrl, testMessage, {
      timeout: 5000,
      headers: { 
        'Content-Type': 'application/json',
        'X-Filter-Source': 'whatsapp-filter-test'
      }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      error: 'Webhook test failed',
      details: error.message 
    });
  }
});

// Main filter endpoint (from Evolution API) - NO AUTH REQUIRED
app.post('/filter', async (req, res) => {
  try {
    const message = req.body;
    config.stats.totalMessages++;
    
    // Extract phone number
    const remoteJid = message.key?.remoteJid || '';
    const phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
    
    // Skip groups and status updates
    if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
      config.stats.filteredMessages++;
      return res.status(200).send('OK');
    }

    // Check if number is allowed
    const isAllowed = config.allowedNumbers.some(contact => 
      contact.phone.replace(/[-\s]/g, '') === phoneNumber.replace(/[-\s]/g, '')
    );

    if (isAllowed && config.webhookUrl) {
      // Forward to n8n
      try {
        await axios.post(config.webhookUrl, message, {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'X-Filter-Source': 'whatsapp-filter',
            'X-Original-Phone': phoneNumber
          }
        });
        config.stats.allowedMessages++;
        console.log(`✅ Message forwarded from ${phoneNumber}`);
      } catch (error) {
        console.error(`❌ Failed to forward message from ${phoneNumber}:`, error.message);
      }
    } else {
      config.stats.filteredMessages++;
      console.log(`🚫 Message filtered from ${phoneNumber}`);
    }

    // Auto-save stats every 100 messages
    if (config.stats.totalMessages % 100 === 0) {
      await saveConfig();
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Filter error:', error);
    res.status(500).send('Error');
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
async function startServer() {
  await loadConfig();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp Filter Server v1.0`);
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🔗 Filter endpoint: http://localhost:${PORT}/filter`);
    console.log(`👤 Admin UI: http://localhost:${PORT} (user: ${process.env.ADMIN_USERNAME})`);
    console.log(`🎯 Webhook target: ${config.webhookUrl}`);
    console.log(`📊 Total contacts: ${config.allowedNumbers?.length || 0}`);
  });
}

startServer().catch(console.error);
