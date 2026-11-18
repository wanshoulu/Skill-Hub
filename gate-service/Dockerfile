# gate-service — Node 24 ESM 零框架，内存预算 ~256MB
FROM node:24-alpine

WORKDIR /app

# 探测环境对齐运行环境：stdio 类 MCP 服务器可能由 python3 拉起（echo-demo 等），
# node:24-alpine 自带 node/npx 但缺 python3，缺它会导致「测试连接」误报离线。
# 官方 alpine CDN 在部署机上会长时间挂起，切国内镜像源；npm 同理（与 skill-app-agent 镜像保持一致）
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
  && apk add --no-cache python3

ENV npm_config_registry=https://registry.npmmirror.com

# 先装依赖（层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
# 企业级规范资产：编写规范 + 安全基线 + 元模板库（对话创建时注入 creator）
COPY spec ./spec

# 证据 / 草稿 / runs 落盘目录（compose 挂 named volume）
ENV DATA_DIR=/data \
    PORT=3002 \
    BUILD_AGENT_URL=http://skill-build-agent:8300

EXPOSE 3002

CMD ["node", "--max-old-space-size=256", "src/server.js"]
