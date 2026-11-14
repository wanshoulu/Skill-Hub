# gate-service — Node 24 ESM 零框架，内存预算 ~256MB
FROM node:24-alpine

WORKDIR /app

# 先装依赖（层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# 证据 / 草稿 / runs 落盘目录（compose 挂 named volume）
ENV DATA_DIR=/data \
    PORT=3002 \
    BUILD_AGENT_URL=http://skill-build-agent:8300

EXPOSE 3002

CMD ["node", "--max-old-space-size=256", "src/server.js"]
