FROM node:24-bookworm-slim AS builder
WORKDIR /app/service

COPY services/order/package*.json ./
COPY shared/events /shared/events
RUN npm ci

COPY services/order/nest-cli.json services/order/tsconfig*.json services/order/.prettierrc services/order/eslint.config.mjs ./
COPY services/order/src ./src
COPY services/order/test ./test
COPY parity/security-events.test.cjs ./test/security-events.test.cjs
RUN npm run lint \
 && npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build \
 && node --test test/security-events.test.cjs

FROM builder AS checks
RUN node --test test/order-read.test.cjs test/database-audit.test.cjs test/order-deletion-check.test.cjs

FROM node:24-bookworm-slim
WORKDIR /app/service
ENV NODE_ENV=production
ENV PORT=3002

COPY services/order/package*.json ./
COPY shared/events /shared/events
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/service/dist ./dist

USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
