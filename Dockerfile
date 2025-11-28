FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create config directory
RUN mkdir -p config

# Declare volume for persistent data
VOLUME ["/app/config"]

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
