FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create config directory and set permissions
RUN mkdir -p /app/config && \
    chown -R node:node /app

# Create default config if it doesn't exist
RUN echo '{"webhookUrl":"","allowedNumbers":[],"stats":{"totalMessages":0,"filteredMessages":0,"allowedMessages":0}}' > /app/config/contacts.json

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start application
CMD ["npm", "start"]
