FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
# PyPI 直连在部署环境仅 ~13KB/s，走清华镜像（实测 ~1.8MB/s）
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r /app/requirements.txt

# stdio 类 MCP 服务器（@modelcontextprotocol/server-* 等）需要 node/npx 拉起
# 放在 pip 层之后，避免打掉 Python 依赖缓存；apt 换阿里云源（deb.debian.org 实测 23min 拖不完）
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# 运行时 npx 下载 MCP 服务器包走国内镜像
ENV npm_config_registry=https://registry.npmmirror.com

COPY app /app/app

# skills/workspace 由 compose 卷挂载，仅保证目录存在
RUN mkdir -p /data/skills /data/workspace

EXPOSE 8310

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=15s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8310/v1/healthz', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8310", "--log-level", "info"]
