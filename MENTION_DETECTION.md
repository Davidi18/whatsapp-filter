# Mention Detection - WhatsApp Filter

Auto-detect when you're mentioned in group chats and forward to OpenClaw for AI responses.

## How It Works

```
Group Message
    ↓
whatsapp-filter
    ├─ Not mentioned? → n8n (regular flow)
    └─ Mentioned? → OpenClaw webhook → AI response
```

## Detection Methods

1. **@Mention** - Someone @mentions your phone number
2. **Keywords** - Configurable keywords (e.g., "דוד", "david")
3. **Replies** - Someone replies to your message

## Configuration

### Environment Variables

```env
# Enable mention detection
ENABLE_MENTION_DETECTION=true

# OpenClaw webhook URL
MENTION_WEBHOOK_URL=http://localhost:18789/hooks/whatsapp-mention

# Optional: API key for authentication
MENTION_API_KEY=your-secret-key

# Keywords to detect (comma-separated)
MENTION_KEYWORDS=דוד,david

# Send mentions ONLY to OpenClaw (don't also forward to n8n)
MENTION_ONLY_OPENCLAW=true
```

### Setup Steps

1. **Update `.env`**
   ```bash
   ENABLE_MENTION_DETECTION=true
   MENTION_WEBHOOK_URL=http://localhost:18789/hooks/whatsapp-mention
   MENTION_KEYWORDS=דוד,david,strudel
   MENTION_ONLY_OPENCLAW=true
   ```

2. **Restart whatsapp-filter**
   ```bash
   docker restart whatsapp-filter
   # or
   pm2 restart whatsapp-filter
   ```

3. **OpenClaw will receive mentions** at `/hooks/whatsapp-mention`

## Webhook Payload

When a mention is detected, OpenClaw receives:

```json
{
  "key": {
    "remoteJid": "120363..@g.us",
    "id": "message-id"
  },
  "message": {
    "conversation": "היי דוד, מה דעתך?"
  },
  "pushName": "Sender Name",
  "_mention": {
    "detected": true,
    "method": "keyword",
    "keywords": ["דוד"],
    "timestamp": "2026-02-13T13:45:00.000Z",
    "source": {
      "id": "120363..@g.us",
      "type": "group",
      "name": "Client Group"
    }
  }
}
```

## OpenClaw Webhook Handler

Create `/hooks/whatsapp-mention` endpoint in OpenClaw:

```javascript
// Example handler
app.post('/hooks/whatsapp-mention', async (req, res) => {
  const { message, pushName, _mention } = req.body;
  
  // Extract message text
  const text = message.conversation || 
               message.extendedTextMessage?.text || 
               '[Media]';
  
  // Get group context (last 15 messages)
  const context = await getGroupContext(_mention.source.id);
  
  // Generate AI response
  const response = await generateAIResponse({
    message: text,
    sender: pushName,
    context,
    group: _mention.source.name
  });
  
  // Send response back to WhatsApp
  await sendToWhatsApp(_mention.source.id, response);
  
  res.json({ ok: true, sent: true });
});
```

## Testing

### 1. Test Mention Detection

Send a message in a group:
```
היי דוד, מה המצב?
```

Check logs:
```bash
docker logs whatsapp-filter | grep -i mention
```

Expected output:
```
Mention detected: keyword (דוד)
Mention forwarded to OpenClaw: true
```

### 2. Test OpenClaw Response

Check OpenClaw logs:
```bash
openclaw status
# or
tail -f /root/.openclaw/logs/gateway.log
```

## Routing Options

### Option 1: Mentions Only to OpenClaw (Recommended)
```env
MENTION_ONLY_OPENCLAW=true
```
- Mentions → OpenClaw only
- Regular messages → n8n only
- Clean separation

### Option 2: Mentions to Both
```env
MENTION_ONLY_OPENCLAW=false
```
- Mentions → OpenClaw AND n8n
- Useful if n8n needs to log mentions

## Statistics

View mention stats in the admin UI:

```
http://your-domain.com/api/stats
```

Includes:
- Total mentions detected
- Mentions forwarded
- Failed forwards
- Detection methods breakdown

## Troubleshooting

### Mentions not detected?

1. **Check ENABLE_MENTION_DETECTION**
   ```bash
   docker exec whatsapp-filter env | grep MENTION
   ```

2. **Check keywords match**
   - Keywords are case-insensitive
   - Hebrew works: דוד, שטרודל
   - English works: david, strudel

3. **Check group is allowed**
   - Mention detection only works in allowed groups
   - Check `/api/config` - is the group listed?

### Webhook not receiving?

1. **Check URL is correct**
   ```bash
   curl -X POST http://localhost:18789/hooks/whatsapp-mention \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

2. **Check OpenClaw is running**
   ```bash
   openclaw status
   ```

3. **Check logs**
   ```bash
   docker logs whatsapp-filter --tail 50
   ```

## Security

- **API Key**: Use `MENTION_API_KEY` for webhook authentication
- **IP Whitelist**: Limit access to OpenClaw webhook
- **Rate Limiting**: Built into whatsapp-filter (100 req/min)

---

**Author**: Chuck (צ'אק) - Strudel Marketing AI Agent  
**Date**: 2026-02-13  
**Version**: 1.0
