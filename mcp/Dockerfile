# 多租户浏览器沙箱
#
# 基础镜像用本机已有的 node:22-bookworm-slim（Debian 12）。
# 不用 docker pull：本机 daemon 的 DNS 解析异常，拉不了 registry 上的镜像。

FROM node:22-bookworm-slim

USER root
ENV DEBIAN_FRONTEND=noninteractive

# 换成国内 apt 源（deb.debian.org 在这台机器上下 56MB 的中文字体会卡死）
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g; s|http://security.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g; s|http://security.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi; \
    cat /etc/apt/sources.list.d/debian.sources 2>/dev/null | head -5

# Xvfb / VNC / noVNC / 窗口管理器 / 中文字体 / Chromium 运行库
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
      xvfb x11vnc novnc websockify openbox \
      ca-certificates curl procps tini \
      fonts-liberation fonts-noto-cjk fonts-dejavu-core \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libx11-xcb1 \
      libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com \
    && npm cache clean --force

# 与 package.json 里的 playwright 版本严格匹配的 Chromium
RUN npx playwright install chromium \
    && npx playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
# 以非 root 用户（宿主 uid 1000）运行，需要源码可读
RUN chmod -R a+rX /app

ENV DATA_DIR=/data \
    LISTEN_HOST=127.0.0.1 \
    LISTEN_PORT=8787 \
    PUBLIC_HOST=127.0.0.1 \
    PODS_MAX=6 \
    POD_IDLE_TTL_MIN=30 \
    NOVNC_WEB=/usr/share/novnc \
    TZ=Asia/Shanghai

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
