# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine AS runtime
ENV NODE_ENV=production MATH_AGENT_VARIANT=general PORT=8080 SESSION_DATA_DIR=/app/data/sessions MCP_CONFIG_FILE=/app/runtime/mcp-servers.json AGENT_RUN_DATA_DIR=/app/runtime/runs
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p /app/data/sessions /app/runtime/runs && chown node:node /app/data /app/data/sessions /app/runtime /app/runtime/runs
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD node -e "fetch('http://127.0.0.1:8080/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
