FROM node:24-bookworm-slim
WORKDIR /app
COPY backend/payment-test/*.mjs ./
COPY backend/payment-test/public ./public
USER node
EXPOSE 3000
ENTRYPOINT ["flock", "--no-fork", "-n", "/data/service.lock", "node", "main.mjs"]
