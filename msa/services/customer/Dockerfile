FROM node:24-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY nest-cli.json tsconfig*.json ./
COPY src ./src
COPY test ./test
RUN npm test -- --runInBand \
 && npm run test:e2e -- --runInBand \
 && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]