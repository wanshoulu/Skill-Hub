# 技能构建定制 web 镜像 — 基于 skillhub v0.2.26 源码 + 本地构建的 dist
# 与上游 Dockerfile 的运行时层一致，仅前端产物换成定制版（含技能构建页 + gate-api/build-api 反代）
FROM nginx:alpine
ENV SKILLHUB_TRUST_FORWARDED_PROTO=false
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY dist/ /usr/share/nginx/html
COPY src/docs/skill.md.template /usr/share/nginx/html/registry/skill.md.template
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY runtime-config.js.template /usr/share/nginx/html/runtime-config.js.template
COPY docker-entrypoint.d/20-base-path.sh /docker-entrypoint.d/20-base-path.sh
COPY docker-entrypoint.d/30-runtime-config.sh /docker-entrypoint.d/30-runtime-config.sh
COPY analytics-config.awk /etc/skillhub/analytics-config.awk
COPY docker-entrypoint.d/40-analytics.sh /docker-entrypoint.d/40-analytics.sh
# 源码经 Windows git clone 可能带 CRLF，清洗后才能被 entrypoint 执行
RUN sed -i 's/\r$//' /docker-entrypoint.d/20-base-path.sh /docker-entrypoint.d/30-runtime-config.sh /docker-entrypoint.d/40-analytics.sh /etc/skillhub/analytics-config.awk
RUN chmod +x /docker-entrypoint.d/20-base-path.sh /docker-entrypoint.d/30-runtime-config.sh /docker-entrypoint.d/40-analytics.sh
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/nginx-health || exit 1
