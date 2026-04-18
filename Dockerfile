# ================================================================
# 小围棋乐园 - Docker 镜像
# Next.js + KataGo (预编译二进制) + GnuGo (apt安装)
# ================================================================

# ---- Stage 1: 准备 KataGo（预编译二进制 + 模型）----
FROM node:24-slim AS katago-builder

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl unzip && \
    rm -rf /var/lib/apt/lists/*

ARG KATAGO_VERSION=v1.16.4
RUN mkdir -p /usr/local/katago && \
    cd /tmp && \
    KATAGO_URL="https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/katago-${KATAGO_VERSION}-eigenavx2-linux-x64.zip" && \
    echo "Downloading KataGo from: $KATAGO_URL" && \
    curl -fSL --retry 3 --max-time 300 -o katago.zip "$KATAGO_URL" && \
    ls -lh katago.zip && \
    unzip -o katago.zip -d katago-extracted && \
    find katago-extracted -name katago -type f -exec cp {} /usr/local/katago/katago \; && \
    chmod +x /usr/local/katago/katago && \
    rm -rf katago.zip katago-extracted

# 直接生成最小化 CPU 配置（不依赖官方配置模板）
RUN cat > /usr/local/katago/gtp.cfg << 'CPUCFG'
# KataGo CPU 专用最小配置 - 小围棋乐园
koRule = SIMPLE
scoringRule = AREA
taxRule = NONE
multiStoneSuicideLegal = false
hasResignedRule = true
numSearchThreads = 2
nnMaxBatchSize = 8
logAllGTPCommunication = false
logSearchInfo = false
CPUCFG

# 下载神经网络模型（lionffen 2MB 小模型，支持所有棋盘大小）
RUN curl -fSL --retry 3 --max-time 180 -H "Referer: https://katagotraining.org/extra_networks/" \
      -o /usr/local/katago/lionffen_b6c64.txt.gz \
      "https://media.katagotraining.org/uploaded/networks/models_extra/lionffen_b6c64_3x3_v10.txt.gz" ; \
    if [ "$(stat -c%s /usr/local/katago/lionffen_b6c64.txt.gz 2>/dev/null || echo 0)" -gt 100000 ]; then \
      echo "Downloaded lionffen model OK"; \
    else \
      echo "lionffen download failed, trying rect15..."; \
      rm -f /usr/local/katago/lionffen_b6c64.txt.gz; \
      curl -sL --max-time 300 -H "Referer: https://katagotraining.org/extra_networks/" \
        -o /usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz \
        "https://media.katagotraining.org/uploaded/networks/models_extra/rect15-b20c256-s343365760-d96847752.bin.gz" ; \
      if [ "$(stat -c%s /usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz 2>/dev/null || echo 0)" -gt 10000000 ]; then \
        echo "Downloaded rect15 model OK"; \
      else \
        echo "All model downloads failed, trying GitHub human SL model..."; \
        rm -f /usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz; \
        curl -sL --max-time 600 --retry 1 \
          -o /usr/local/katago/b18c384nbt-humanv0.bin.gz \
          "https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz" ; \
        if [ "$(stat -c%s /usr/local/katago/b18c384nbt-humanv0.bin.gz 2>/dev/null || echo 0)" -gt 10000000 ]; then \
          echo "Downloaded human SL model OK"; \
        else \
          echo "WARNING: All model downloads failed"; \
          rm -f /usr/local/katago/b18c384nbt-humanv0.bin.gz; \
        fi; \
      fi; \
    fi

# 验证安装
RUN /usr/local/katago/katago version && \
    ls -lh /usr/local/katago/*.gz 2>/dev/null || true

# ---- Stage 2: 构建 Next.js ----
FROM node:24-slim AS app-builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 先复制依赖文件（利用 Docker 缓存层）
COPY package.json pnpm-lock.yaml* ./
# 覆盖 npm 镜像配置
RUN echo "registry=https://registry.npmjs.org/" > .npmrc
RUN pnpm install --frozen-lockfile --prefer-offline 2>/dev/null || pnpm install

# 复制源码并构建
COPY . .
RUN pnpm next build

# ---- Stage 3: 运行时镜像 ----
FROM node:24-slim AS runner

# 安装 GnuGo
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends gnugo && \
    rm -rf /var/lib/apt/lists/*

# 从 katago-builder 复制 KataGo
COPY --from=katago-builder /usr/local/katago /usr/local/katago

# 从 app-builder 复制构建产物
# Next.js standalone 保留完整构建路径，不能展平（server.js 有相对路径 require）
COPY --from=app-builder /app/.next/standalone /next-standalone
COPY --from=app-builder /app/.next/static /next-standalone-static
COPY --from=app-builder /app/public /next-standalone-public

# 定位 server.js 并将 static/public 复制到正确位置
RUN SERVER_JS=$(find /next-standalone -name "server.js" -type f | head -1) && \
    if [ -z "$SERVER_JS" ]; then \
      echo "ERROR: server.js not found in standalone output" && \
      find /next-standalone -type f | head -30 && exit 1; \
    fi && \
    SERVER_DIR=$(dirname "$SERVER_JS") && \
    echo "Found server.js at: $SERVER_JS" && \
    echo "Server directory: $SERVER_DIR" && \
    mkdir -p "$SERVER_DIR/.next/static" && \
    cp -r /next-standalone-static/. "$SERVER_DIR/.next/static/" && \
    cp -r /next-standalone-public "$SERVER_DIR/public" && \
    rm -rf /next-standalone-static /next-standalone-public

# 复制启动脚本
COPY docker-start.sh /docker-start.sh
RUN chmod +x /docker-start.sh

# 环境变量
ENV NODE_ENV=production
ENV PORT=5000
ENV HOSTNAME="0.0.0.0"

EXPOSE 5000

# 使用启动脚本动态定位 server.js 并运行
CMD ["/docker-start.sh"]
