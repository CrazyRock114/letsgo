# ================================================================
# 小围棋乐园 - Docker 镜像
# Next.js + KataGo (预编译二进制) + GnuGo (apt安装)
# ================================================================
# 构建约 2-3 分钟（下载KataGo二进制30秒 + 模型下载30秒 + npm构建2分钟）
# 运行时内存 ~200-400MB（KataGo模型加载后）

# ---- Stage 1: 准备 KataGo（预编译二进制 + 模型）----
FROM node:24-slim AS katago-builder

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl unzip && \
    rm -rf /var/lib/apt/lists/*

ARG KATAGO_VERSION=v1.16.4
RUN mkdir -p /usr/local/katago && \
    cd /tmp && \
    # 下载 KataGo 预编译二进制（eigenavx2 = CPU + AVX2，无需GPU）
    curl -sL --max-time 120 -o katago.zip \
      "https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/katago-${KATAGO_VERSION#v}-eigenavx2-linux-x64.zip" && \
    unzip -o katago.zip -d katago-extracted && \
    # 二进制在 zip 根目录
    cp katago-extracted/katago /usr/local/katago/katago && \
    chmod +x /usr/local/katago/katago && \
    # 复制官方配置模板
    cp katago-extracted/default_gtp.cfg /usr/local/katago/gtp.cfg 2>/dev/null || true && \
    rm -rf katago.zip katago-extracted

# 注释掉官方配置中的重复键（后面会追加覆盖值）
RUN for key in numSearchThreads nnMaxBatchSize logAllGTPCommunication logSearchInfo; do \
      sed -i "s/^[[:space:]]*\(${key}[[:space:]]*=\)/#\\1/; t; s/^\(${key}[[:space:]]*=\)/#\\1/" /usr/local/katago/gtp.cfg; \
    done && \
    cat >> /usr/local/katago/gtp.cfg << 'CPUCFG'

# ===== 小围棋乐园 CPU 专用覆盖配置 =====
numSearchThreads = 2
nnMaxBatchSize = 8
logAllGTPCommunication = false
logSearchInfo = false
CPUCFG

# 下载神经网络模型（lionffen 2MB 小模型，支持所有棋盘大小）
RUN curl -sL --max-time 120 -H "Referer: https://katagotraining.org/extra_networks/" \
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
# standalone 模式会保留构建路径结构: .next/standalone/<workdir>/
WORKDIR /app
COPY --from=app-builder /app/.next/standalone/app ./
COPY --from=app-builder /app/.next/static ./.next/static
COPY --from=app-builder /app/public ./public

# 环境变量
ENV NODE_ENV=production
ENV PORT=5000
ENV HOSTNAME="0.0.0.0"

EXPOSE 5000

# 使用 standalone 模式的 server.js 启动
CMD ["node", "server.js"]
