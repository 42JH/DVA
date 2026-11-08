FROM node:24-bookworm-slim AS builder
WORKDIR /app/service

COPY services/consultation/package*.json ./
COPY shared/events/package.json /shared/events/package.json
RUN --mount=type=cache,id=dva-msa-npm,target=/root/.npm,sharing=locked npm ci
COPY shared/events/*.cjs shared/events/*.d.cts /shared/events/

COPY services/consultation/nest-cli.json services/consultation/tsconfig*.json services/consultation/.prettierrc services/consultation/eslint.config.mjs ./
COPY services/consultation/src ./src
COPY services/consultation/test ./test
COPY parity/security-events.test.cjs ./test/security-events.test.cjs
RUN npm run lint \
 && npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build \
 && node --test test/security-events.test.cjs

FROM builder AS checks
RUN node --test test/auth-bridge.test.cjs test/active-call-count.test.cjs test/recording-storage.test.cjs test/database-audit.test.cjs test/customer-context.test.cjs test/call-analysis-client.test.cjs test/analysis-audit.test.cjs

FROM node:24-bookworm-slim
WORKDIR /app/service
ENV NODE_ENV=production
ENV PORT=3004

COPY services/consultation/package*.json ./
COPY shared/events/package.json /shared/events/package.json
RUN --mount=type=cache,id=dva-msa-npm,target=/root/.npm,sharing=locked npm ci --omit=dev
COPY shared/events/*.cjs shared/events/*.d.cts /shared/events/

COPY --from=builder /app/service/dist ./dist

USER node
EXPOSE 3004
CMD ["node", "dist/main.js"]
