const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // For retro UI styling
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests' }
});
app.use(limiter);

// Configuration
let config = {
  webhookUrl: process.env.WEBHOOK_URL || '',
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
    config = { ...config, ...JSON.parse(data) };
    console.log('Configuration loaded');
  } catch (error) {
    console.log('No existing config found, using defaults');
  }
}

// Save configuration
async function saveConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'contacts.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Configuration saved');
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Get configuration
app.get('/api/config', (req, res) => {
  res.json({
    contacts: config.allowedNumbers || [],
    webhookUrl: config.webhookUrl || '',
    stats: config.stats
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

// Update webhook URL
app.post('/api/webhook', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url || !url.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid webhook URL' });
    }

    config.webhookUrl = url;
    await saveConfig();
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update webhook' });
  }
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
      message: 'Filter system test'
    };

    await axios.post(config.webhookUrl, testMessage, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      error: 'Webhook test failed',
      details: error.message 
    });
  }
});

// Main filter endpoint (from Evolution API)
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
            'X-Filter-Source': 'whatsapp-filter'
          }
        });
        config.stats.allowedMessages++;
      } catch (error) {
        console.error('Failed to forward message:', error.message);
      }
    } else {
      config.stats.filteredMessages++;
    }

    // Auto-save stats every 100 messages
    if (config.stats.totalMessages % 100 === 0) {
      await saveConfig();
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Filter error:', error);
    res.status(500).send('Error');
  }
});

// Start server
async function startServer() {
  await loadConfig();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Filter server running on port ${PORT}`);
    console.log(`📊 Admin UI: http://localhost:${PORT}`);
    console.log(`🔗 Filter endpoint: http://localhost:${PORT}/filter`);
  });
}

startServer().catch(console.error);
