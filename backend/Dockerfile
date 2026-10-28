# Build with dev dependencies, run with production dependencies only.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM builder AS checks
COPY eslint.config.mjs .prettierrc.json ./
COPY test ./test
COPY scripts ./scripts
COPY migrations ./migrations
COPY data ./data
RUN npm run check
CMD ["npm", "run", "test:integration"]

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY data ./data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
