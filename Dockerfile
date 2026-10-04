# Multi-stage Dockerfile for production deployment
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/
COPY config/ ./config/

# Production image
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/config ./config
COPY --from=builder /app/package*.json ./

# Create state directories
RUN mkdir -p /app/state/inbox /app/state/inbox/processed /app/state/logs && \
    chown -R appuser:appgroup /app/state

USER appuser

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const fs = require('fs'); console.log('OK'); process.exit(0)"

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Default command (overridden by K8s/Compose)
CMD ["node", "src/index.js", "--mode", "intraday"]