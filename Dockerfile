# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app/broker/selfhost
COPY broker/selfhost/package*.json ./
RUN npm ci --no-audit --no-fund
COPY broker/src ../src
COPY broker/selfhost ./
RUN npm run build && npm test

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/var/lib/gha-mcp
WORKDIR /app
RUN mkdir -p /var/lib/gha-mcp && chown node:node /var/lib/gha-mcp
COPY --from=build /app/broker/selfhost/dist/ ./
COPY broker/VENDOR.md ./licenses/VENDOR.md
COPY broker/third_party/ ./licenses/third_party/
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "/app/server.mjs"]
