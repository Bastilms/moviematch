# Build stage
FROM node:24-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

# Remove dev dependencies
RUN npm prune --omit=dev

# Runtime stage
FROM node:24-alpine

WORKDIR /app

# Copy dependencies
COPY --from=builder /build/node_modules ./node_modules

# Copy built application and assets
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/public ./public
COPY --from=builder /build/i18n ./i18n
COPY --from=builder /build/package.json ./package.json

# Ensure node user owns /app directory and create /data directory
RUN chown -R node:node /app && mkdir -p /data && chown -R node:node /data

EXPOSE 8000

ENV DATABASE_PATH=/data/moviematch.db
VOLUME ["/data"]

USER node

CMD ["node", "dist/index.js"]
