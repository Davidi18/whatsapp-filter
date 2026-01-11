FROM node:20-alpine

# Install dependencies for Baileys (canvas/sharp support)
RUN apk add --no-cache \
    libc6-compat \
    python3 \
    make \
    g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create config directories
RUN mkdir -p config config/baileys_auth

# Declare volume for persistent data
VOLUME ["/app/config"]

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
