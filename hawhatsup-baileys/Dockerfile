ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/index.js"]

