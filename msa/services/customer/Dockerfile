FROM node:24-bookworm-slim AS builder
WORKDIR /app/service

COPY services/customer/package*.json ./
COPY shared/events /shared/events
RUN npm ci

COPY services/customer/nest-cli.json services/customer/tsconfig*.json services/customer/.prettierrc services/customer/eslint.config.mjs ./
COPY services/customer/src ./src
COPY services/customer/test ./test
RUN npm run lint \
 && npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build

FROM builder AS checks
RUN node --test test/auth-bridge.test.cjs test/database-audit.test.cjs test/call-context.test.cjs

FROM node:24-bookworm-slim
WORKDIR /app/service
ENV NODE_ENV=production
ENV PORT=3001

COPY services/customer/package*.json ./
COPY shared/events /shared/events
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/service/dist ./dist

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
