FROM node:24-bookworm-slim AS builder
WORKDIR /app/service

COPY services/customer/package*.json ./
COPY shared/events/package.json /shared/events/package.json
RUN npm ci
COPY shared/events/*.cjs shared/events/*.d.cts /shared/events/

COPY services/customer/nest-cli.json services/customer/tsconfig*.json services/customer/.prettierrc services/customer/eslint.config.mjs ./
COPY services/customer/src ./src
COPY services/customer/test ./test
COPY parity/security-events.test.cjs ./test/security-events.test.cjs
RUN npm run lint \
 && npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build \
 && node --test test/security-events.test.cjs

FROM builder AS checks
RUN node --test test/auth-bridge.test.cjs test/database-audit.test.cjs test/call-context.test.cjs

FROM node:24-bookworm-slim
WORKDIR /app/service
ENV NODE_ENV=production
ENV PORT=3001

COPY services/customer/package*.json ./
COPY shared/events/package.json /shared/events/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY shared/events/*.cjs shared/events/*.d.cts /shared/events/

COPY --from=builder /app/service/dist ./dist

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
