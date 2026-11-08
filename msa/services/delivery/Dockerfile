FROM node:24-bookworm-slim AS builder
WORKDIR /app/service

COPY services/delivery/package*.json ./
COPY shared/events/package.json /shared/events/package.json
RUN npm ci
COPY shared/events/*.cjs shared/events/*.d.cts /shared/events/

COPY services/delivery/nest-cli.json services/delivery/tsconfig*.json services/delivery/.prettierrc services/delivery/eslint.config.mjs ./
COPY services/delivery/src ./src
COPY services/delivery/test ./test
RUN npm run lint \
 && npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build

FROM builder AS checks
RUN node --test test/order-shipment-check.test.cjs

FROM node:24-bookworm-slim
WORKDIR /app/service
ENV NODE_ENV=production
ENV PORT=3003

COPY services/delivery/package*.json ./
COPY shared/events/package.json /shared/events/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY shared/events/*.cjs shared/events/*.d.cts /shared/events/

COPY --from=builder /app/service/dist ./dist

USER node
EXPOSE 3003
CMD ["node", "dist/main.js"]
