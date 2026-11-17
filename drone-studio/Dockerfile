# Lucidity: the hosted app and its tool server in one image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8787 STATIC_DIR=dist
EXPOSE 8787
USER node
CMD ["node", "--import", "tsx", "server/main.ts"]
