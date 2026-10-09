FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/watches.db
# No runtime dependencies: Node runs the TypeScript sources directly.
COPY package.json ./
COPY src ./src
VOLUME /data
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
