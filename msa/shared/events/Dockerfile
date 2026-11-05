FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts && npm audit --audit-level=high
COPY . ./
RUN node --check index.cjs && npm test
USER node
CMD ["npm", "run", "test:integration"]
