# 🔥 WhatsApp Filter System

> **Smart WhatsApp message filtering with retro terminal UI**

A powerful Node.js application that filters WhatsApp messages from Evolution API and forwards only authorized contacts to your n8n workflows or other webhooks.

![Terminal Style](https://img.shields.io/badge/Style-Retro%20Terminal-00ff9f)
![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Docker](https://img.shields.io/badge/Docker-Ready-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

- 🛡️ **Smart Filtering**: Only authorized contacts get through
- 🎨 **Retro Terminal UI**: Beautiful 80s-style admin interface
- 🔐 **Secure**: Basic Auth + IP whitelisting support
- 📊 **Real-time Stats**: Monitor filtered vs allowed messages
- 🔄 **Auto-persist**: Contacts survive deployments
- 🚀 **Fast**: Sub-5ms filtering decisions
- 📱 **Responsive**: Works perfectly on mobile
- 🔗 **RESTful API**: Full programmatic control
- 📚 **Self-documenting**: Built-in API docs
- 🤖 **Mention Detection**: Auto-detect @mentions & keywords → forward to OpenClaw for AI responses ([docs](MENTION_DETECTION.md))

## 🎯 How It Works

```
WhatsApp → Evolution API → Filter System → n8n/Webhook
                              ↓
                         Only Allowed
                          Numbers
```

1. **Evolution API** sends all WhatsApp messages to the filter
2. **Filter checks** if sender is in authorized list
3. **If authorized** → forwards to your n8n/webhook
4. **If not** → blocks message (with stats tracking)

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

### Contact Types

- **PERSONAL**: Friends, family
- **BUSINESS**: Clients, partners  
- **VIP**: Priority contacts
- **TEMP**: Temporary access

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
| `WEBHOOK_URL` | ✅ | Target webhook URL | - |
| `ADMIN_USERNAME` | ✅ | Admin interface username | - |
| `ADMIN_PASSWORD` | ✅ | Admin interface password | - |
| `PORT` | ❌ | Server port | `3000` |
| `NODE_ENV` | ❌ | Environment | `production` |
| `ALLOWED_IPS` | ❌ | IP whitelist (comma-separated) | All IPs |

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

#### Messages Not Forwarding
1. Test webhook endpoint directly
2. Check WEBHOOK_URL environment variable
3. Verify n8n webhook accepts POST

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
