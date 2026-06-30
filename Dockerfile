# ── Voice Companion — Dockerfile ────────────────────────────────────────────
# Production image for VPS / cloud VM deployment.
# Supports both Agora SDK mode and legacy WebSocket mode.
#
# Build:
#   docker build -t voice-companion .
#
# Run:
#   docker run -p 3456:3456 --env-file .env.production voice-companion
#
# Or with docker-compose:
#   docker-compose up -d

FROM node:20-alpine AS base

# Install build dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Rebuild native addons (mysql2, etc.)
FROM base AS rebuild-deps
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
RUN npm rebuild

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3456

# Copy node_modules from rebuild stage
COPY --from=rebuild-deps /app/node_modules ./node_modules
COPY . .

# Expose the port
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3456/api/health || exit 1

# Start command: use server.js for custom server (supports both modes)
CMD ["node", "server.js"]
