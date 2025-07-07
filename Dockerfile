FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (more forgiving)
RUN npm install --production

# Copy app
COPY . .

# Create config
RUN mkdir -p config && \
    echo '{"allowedNumbers":[],"stats":{"totalMessages":0,"filteredMessages":0,"allowedMessages":0}}' > config/contacts.json

EXPOSE 3000

CMD ["npm", "start"]
