FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY abi ./abi
COPY src ./src
COPY web ./web
RUN mkdir -p /data && chown node:node /data
ENV PORT=8787 HOST=0.0.0.0 CHECKPOINT_PATH=/data/checkpoint.json
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO /dev/null http://127.0.0.1:8787/api/v1/health || exit 1
CMD ["node", "src/server.js"]
