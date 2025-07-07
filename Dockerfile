FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create config directory
RUN mkdir -p config && \
    echo '{"allowedNumbers":[],"stats":{"totalMessages":0,"filteredMessages":0,"allowedMessages":0}}' > config/contacts.json

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
