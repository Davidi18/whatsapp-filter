# 🔥 WhatsApp Filter System

> **Smart WhatsApp message filtering with retro terminal UI**

A powerful Node.js application that filters WhatsApp messages from Evolution API and forwards only authorized contacts to your n8n workflows or other webhooks.

![Terminal Style](https://img.shields.io/badge/Style-Retro%20Terminal-00ff9f)
![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Docker](https://img.shields.io/badge/Docker-Ready-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

- 🛡️ **Smart Filtering**: Only authorized contacts and groups get through
- 🎨 **Retro Terminal UI**: Beautiful 80s-style admin interface
- 🔐 **Secure**: Basic Auth + IP whitelisting support
- 📊 **Real-time Stats**: Monitor filtered vs allowed messages
- 🔄 **Auto-persist**: Contacts survive deployments
- 🚀 **Fast**: Sub-5ms filtering decisions
- 📱 **Responsive**: Works perfectly on mobile
- 🔗 **RESTful API**: Full programmatic control
- 📚 **Self-documenting**: Built-in API docs
- 🤖 **Mention Detection**: Auto-detect @mentions & keywords → forward to OpenClaw for AI responses ([docs](MENTION_DETECTION.md))
- 👥 **Group Support**: Filter and route group messages with type-based webhooks
- 🔀 **Smart Routing**: Route different contact/group types to different webhooks
- 🔍 **Coverage Analysis**: See which types are missing webhook configurations
- ⚡ **Auto-retry**: 3 retries with exponential backoff for webhook failures
- 🔄 **Dual Mode**: Works with Evolution API (webhook) or Baileys (direct WhatsApp connection)

## 🎯 How It Works

```
WhatsApp → Evolution API/Baileys → Filter System → n8n/Webhooks
                                         ↓
                                 Check Authorized
                                  Contacts/Groups
                                         ↓
                                 Route by Type
                                         ↓
                            ┌────────────┴────────────┐
                            ↓                         ↓
                      Default Webhook         Type-Specific Webhooks
                      (e.g., n8n)             (VIP, BUSINESS, etc.)
```

### Message Flow

1. **WhatsApp** → Message arrives (personal or group)
2. **Evolution API/Baileys** → Sends to filter system
3. **Filter checks**:
   - Is sender/group in allowed list?
   - What's the entity type? (VIP, BUSINESS, GENERAL, etc.)
   - Is there a webhook configured for this type?
4. **Smart routing**:
   - Type-specific webhook → Use it
   - No type webhook → Use default webhook
   - No webhook at all → Log with `reason: 'no_webhook_for_type'`
5. **Auto-retry**: Failed webhooks retry 3 times with exponential backoff
6. **Stats tracking**: All actions logged for monitoring

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Evolution API instance
- n8n or webhook endpoint
- (Optional) Coolify for deployment

### 1. Clone & Install

```bash
git clone <your-repo>
cd whatsapp-filter
npm install
```

### 2. Configure Environment

```bash
# Required
WEBHOOK_URL=https://your-n8n.com/webhook/evolution
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password

# Optional
PORT=3000
NODE_ENV=production
ALLOWED_IPS=192.168.1.0/24,10.0.0.0/8
```

### 3. Run Locally

```bash
npm start
```

### 4. Configure Evolution API

Set your Evolution API webhook to:
```
https://your-domain.com/filter
```

### 5. Access Admin Interface

Visit: `https://your-domain.com`
- Username: `admin`
- Password: `your-secure-password`

## 🐳 Docker Deployment

### Basic Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p config
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t whatsapp-filter .
docker run -d \
  -p 3000:3000 \
  -e WEBHOOK_URL=https://your-n8n.com/webhook \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=secure123 \
  -v ./data:/app/config \
  whatsapp-filter
```

### Coolify Deployment

1. **Create Application**: Docker → Repository
2. **Environment Variables**:
   ```
   WEBHOOK_URL=https://your-n8n.com/webhook
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=secure123
   PORT=3000
   ```
3. **Add Storage**: `/app/config` → Volume Mount
4. **Deploy**

## 🎮 Admin Interface

Beautiful retro terminal-style interface with:

- 📊 **Real-time dashboard** with system stats
- ➕ **Add contacts** with phone, name, and type
- 🗑️ **Remove contacts** with one click
- 📱 **Mobile responsive** design
- ⚡ **Live updates** every 30 seconds

### Contact & Group Types

#### Contact Types
- **PERSONAL**: Friends, family
- **BUSINESS**: Clients, partners
- **VIP**: Priority contacts (can route to separate webhook)
- **TEMP**: Temporary access

#### Group Types
- **GENERAL**: Regular groups
- **BUSINESS**: Business/work groups
- **VIP**: Priority groups
- **SUPPORT**: Customer support groups
- **TEAM**: Internal team chats

Each type can have its own webhook URL for smart routing!

## 🔧 API Reference

### Health Check
```bash
GET /health
# No auth required
```

### API Documentation
```bash
GET /docs
# Complete interactive API docs
```

### Contacts Management

#### Get All Contacts
```bash
curl -X GET https://your-domain.com/api/config \
  -u "admin:password"
```

#### Add Contact
```bash
curl -X POST https://your-domain.com/api/contacts/add \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "972501234567",
    "name": "John Doe",
    "type": "BUSINESS"
  }'
```

#### Update Contact
```bash
curl -X PUT https://your-domain.com/api/contacts/972501234567 \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{"type": "VIP"}'
```

#### Delete Contact
```bash
curl -X DELETE https://your-domain.com/api/contacts/972501234567 \
  -u "admin:password"
```

### Groups Management

#### Get All Groups (with webhook status)
```bash
curl -X GET https://your-domain.com/api/groups \
  -u "admin:password"
```

Response includes webhook configuration status:
```json
{
  "groups": [
    {
      "groupId": "120363123456789012@g.us",
      "name": "Family Group",
      "type": "GENERAL",
      "webhookConfigured": true,
      "webhookUrl": "https://n8n.example.com/webhook/default"
    }
  ]
}
```

#### Add Group
```bash
curl -X POST https://your-domain.com/api/groups/add \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "120363123456789012@g.us",
    "name": "Team Chat",
    "type": "TEAM"
  }'
```

#### Update Group
```bash
curl -X PUT https://your-domain.com/api/groups/120363123456789012@g.us \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{"type": "VIP"}'
```

#### Delete Group
```bash
curl -X DELETE https://your-domain.com/api/groups/120363123456789012@g.us \
  -u "admin:password"
```

### Webhook Configuration

#### Set Default Webhook
```bash
curl -X POST https://your-domain.com/api/webhook \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://n8n.example.com/webhook/default"
  }'
```

#### Set Type-Specific Webhooks
```bash
curl -X POST https://your-domain.com/api/webhooks/types \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{
    "typeWebhooks": {
      "VIP": "https://n8n.example.com/webhook/vip",
      "BUSINESS": "https://n8n.example.com/webhook/business",
      "TEAM": "https://n8n.example.com/webhook/team"
    }
  }'
```

#### Get Webhook Coverage Analysis
```bash
curl -X GET https://your-domain.com/api/webhooks/types \
  -u "admin:password"
```

Response shows which types lack webhooks:
```json
{
  "typeWebhooks": {
    "VIP": "https://n8n.example.com/webhook/vip"
  },
  "defaultWebhook": "https://n8n.example.com/webhook/default",
  "coverage": {
    "groups": [
      {
        "type": "GENERAL",
        "hasWebhook": true,
        "count": 3
      },
      {
        "type": "TEAM",
        "hasWebhook": false,
        "count": 2
      }
    ],
    "missingWebhooks": {
      "groups": ["TEAM"],
      "contacts": []
    }
  }
}
```

## 🔀 Type-Based Routing

One of the most powerful features - route different message types to different webhooks!

### Use Cases

1. **VIP Priority Queue**
   - VIP contacts → Urgent n8n workflow
   - Regular contacts → Standard workflow

2. **Business Separation**
   - BUSINESS contacts → CRM integration
   - PERSONAL contacts → Personal automation

3. **Group Categorization**
   - TEAM groups → Slack notifications
   - SUPPORT groups → Ticketing system
   - GENERAL groups → Archive workflow

### How It Works

```javascript
// Incoming message from VIP contact
{
  "entityType": "VIP",
  "sourceType": "personal",
  "message": "Urgent request"
}
// → Routes to: https://n8n.example.com/webhook/vip

// Incoming message from GENERAL group
{
  "entityType": "GENERAL",
  "sourceType": "group",
  "message": "Regular discussion"
}
// → Routes to: https://n8n.example.com/webhook/default

// Message with no webhook configured
{
  "entityType": "TEMP",
  "sourceType": "personal"
}
// → Logged with reason: 'no_webhook_for_type'
```

### Configuration Example

```bash
# Set default webhook for all unconfigured types
export WEBHOOK_URL=https://n8n.example.com/webhook/default

# Configure type-specific webhooks via API
curl -X POST https://your-domain.com/api/webhooks/types \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{
    "typeWebhooks": {
      "VIP": "https://n8n.example.com/webhook/vip",
      "BUSINESS": "https://n8n.example.com/webhook/business",
      "TEAM": "https://n8n.example.com/webhook/team",
      "SUPPORT": "https://support.example.com/api/ticket"
    }
  }'
```

### Monitoring Coverage

Check which types need webhooks:

```bash
curl https://your-domain.com/api/webhooks/types -u "admin:password"
```

Look for `missingWebhooks` in the response to identify gaps.

## 📊 System Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   WhatsApp      │ -> │  Evolution API  │ -> │  Filter System  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                        │
                                               ┌─────────────────┐
                                               │   Admin UI      │
                                               │   - Add/Remove  │
                                               │   - Statistics  │
                                               │   - Monitoring  │
                                               └─────────────────┘
                                                        │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Your n8n      │ <- │   Webhook       │ <- │  Allowed Only   │
│   Workflows     │    │   Forward       │    │   Messages      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🛡️ Security Features

- **Basic Authentication**: Username/password for admin access
- **IP Whitelisting**: Restrict access by IP ranges
- **Input Validation**: Sanitized inputs prevent XSS
- **Rate Limiting**: 100 requests/minute protection
- **Secure Headers**: Helmet.js security middleware
- **Environment Secrets**: Sensitive data in env vars

## 📈 Performance

- **< 5ms**: Average filtering response time
- **Memory Efficient**: ~50MB RAM usage
- **Auto-scaling**: Handles 1000+ messages/hour
- **Persistent Storage**: Volume-backed contact storage
- **Graceful Degradation**: Continues working if n8n is down

## 🔧 Configuration

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `WEBHOOK_URL` | ⚠️ | Default webhook URL (or set in UI) | - |
| `SECONDARY_WEBHOOK_URL` | ❌ | Secondary webhook (non-blocking) | - |
| `ADMIN_USERNAME` | ✅ | Admin interface username | - |
| `ADMIN_PASSWORD` | ✅ | Admin interface password | - |
| `PORT` | ❌ | Server port | `3000` |
| `NODE_ENV` | ❌ | Environment | `production` |
| `ALLOWED_IPS` | ❌ | IP whitelist (comma-separated) | All IPs |
| `ENABLE_MENTION_DETECTION` | ❌ | Enable @mention detection | `false` |
| `MENTION_WEBHOOK_URL` | ❌ | OpenClaw webhook for mentions | - |
| `MENTION_API_KEY` | ❌ | API key for mention webhook | - |
| `MENTION_KEYWORDS` | ❌ | Comma-separated keywords | `דוד,david` |
| `MENTION_ONLY_OPENCLAW` | ❌ | Only forward mentions to OpenClaw | `false` |
| `ENABLE_MESSAGE_UPDATES` | ❌ | Forward read/delivered status | `false` |
| `BAILEYS_ENABLED` | ❌ | Use Baileys (direct WhatsApp) | `false` |

### Phone Number Format

- **Supported**: `972-XX-XXX-XXXX` or `972XXXXXXXXX`
- **Validation**: Israeli mobile numbers only
- **Storage**: Cleaned format without dashes

## 📝 Logs & Monitoring

### Log Levels
```bash
# System events
🚀 Server startup
✅ Configuration loaded
📞 Message processing
🚫 Filtered messages
❌ Error conditions
```

### Health Monitoring
```bash
curl https://your-domain.com/health
```

Returns:
- System uptime
- Memory usage  
- Contact count
- Webhook status
- Version info

## 🧪 Testing

### Test Filter Endpoint
```bash
curl -X POST https://your-domain.com/filter \
  -H "Content-Type: application/json" \
  -d '{
    "key": {
      "remoteJid": "972501234567@s.whatsapp.net"
    },
    "message": {
      "conversation": "test message"
    }
  }'
```

### Test Webhook Connection
```bash
curl -X POST https://your-domain.com/api/test-webhook \
  -u "admin:password"
```

## 🚨 Troubleshooting

### Common Issues

#### Filter Not Receiving Messages
1. Check Evolution API webhook URL
2. Verify Evolution is sending POST requests
3. Check network connectivity
4. If using Baileys mode, check QR code connection

#### Messages Not Forwarding
1. **Check webhook coverage**: `GET /api/webhooks/types` to see missing webhooks
2. **Group messages not forwarding**: Verify group type has webhook configured
3. Test webhook endpoint directly
4. Check WEBHOOK_URL environment variable
5. Verify n8n webhook accepts POST
6. Check logs for `reason: 'no_webhook_for_type'`

#### Messages Marked as "Forwarded" but Not Arriving
**This was the original bug** - fixed in commit `33416f5`:
- Old behavior: Messages marked "forwarded" even without webhook
- New behavior: Checks if webhook exists for specific entity type
- Solution: Configure webhooks for all your contact/group types
- Check: Use coverage analysis endpoint to find missing webhooks

#### Admin Interface Not Loading
1. Check ADMIN_USERNAME/PASSWORD
2. Verify Basic Auth headers
3. Check browser network tab

### Debug Mode
```bash
# Enable verbose logging
NODE_ENV=development npm start
```

### Check Logs
```bash
# Docker
docker logs container-name

# PM2
pm2 logs whatsapp-filter

# Direct
tail -f /var/log/whatsapp-filter.log
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## 📝 Recent Updates

### v2.1.0 (2026-02-23)
**🐛 Critical Fix: Group Message Forwarding**
- Fixed bug where group messages were marked "forwarded" but not actually sent
- Added entity-type-specific webhook validation before forwarding
- Improved logging with `reason: 'no_webhook_for_type'` for better debugging

**✨ New Features**
- Webhook coverage analysis API endpoint
- Group webhook status in GET `/api/groups`
- Per-type webhook routing for contacts and groups
- Missing webhook detection and reporting

**🔧 Improvements**
- Better error messages for webhook failures
- Enhanced API responses with webhook configuration status
- Improved debugging with entityType in all log events

### v2.0.0
- Added Baileys support (direct WhatsApp connection)
- Mention detection system with OpenClaw integration
- Group message support
- Type-based webhook routing
- Auto-retry with exponential backoff
- Secondary webhook support

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Evolution API](https://github.com/EvolutionAPI/evolution-api) - WhatsApp API
- [n8n](https://n8n.io) - Workflow automation
- [Express.js](https://expressjs.com) - Web framework
- [Coolify](https://coolify.io) - Deployment platform

## 📞 Support

- 📧 **Email**: info@ystrudel.marketing
- 💬 **Issues**: [GitHub Issues](https://github.com/yourusername/whatsapp-filter/issues)
- 📖 **Docs**: Built-in at `/docs`

---

**Made with ❤️ and terminal nostalgia**

> *"Because not every WhatsApp message deserves your attention"*
