FROM node:24-bookworm-slim AS builder
WORKDIR /app/service

COPY services/operations/package*.json ./
COPY shared/events /shared/events
RUN npm ci

COPY services/operations/nest-cli.json services/operations/tsconfig*.json services/operations/.prettierrc services/operations/eslint.config.mjs ./
COPY services/operations/src ./src
COPY services/operations/test ./test
COPY services/operations/scripts ./scripts
COPY services/operations/data ./data
RUN npm run lint \
 && npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build \
 && node --test test/environment.test.cjs test/faq-call-sources.test.cjs

FROM builder AS checks
CMD ["node", "--test", "test/auth.test.cjs", "test/auth.integration.test.cjs"]

FROM node:24-bookworm-slim
WORKDIR /app/service
ENV NODE_ENV=production
ENV PORT=3005

COPY services/operations/package*.json ./
COPY shared/events /shared/events
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/service/dist ./dist
COPY services/operations/scripts ./scripts
COPY services/operations/data ./data

USER node
EXPOSE 3005
CMD ["node", "dist/main.js"]
