# ================================================================
# 小围棋乐园 - Docker 镜像
# Next.js + KataGo (源码编译) + GnuGo (apt安装)
# ================================================================
# 构建约 5-8 分钟（KataGo编译3分钟 + 模型下载1分钟 + npm构建2分钟）
# 运行时内存 ~200-400MB（KataGo模型加载后）

# ---- Stage 1: 编译 KataGo ----
FROM node:24-slim AS katago-builder

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      cmake g++ git libeigen3-dev zlib1g-dev libzip-dev ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

ARG KATAGO_VERSION=v1.15.3
RUN git clone --depth 1 --branch ${KATAGO_VERSION} https://github.com/lightvector/KataGo.git /tmp/katago-src && \
    mkdir -p /tmp/katago-src/cpp/build && \
    cd /tmp/katago-src/cpp/build && \
    cmake .. -DUSE_BACKEND=EIGEN -DUSE_AVX2=1 -DCMAKE_BUILD_TYPE=Release && \
    make -j"$(nproc)" && \
    mkdir -p /usr/local/katago && \
    cp katago /usr/local/katago/katago && \
    chmod +x /usr/local/katago/katago

# 复制官方完整配置并注释重复键
RUN cp /tmp/katago-src/cpp/configs/gtp_example.cfg /usr/local/katago/gtp.cfg && \
    for key in numSearchThreads nnMaxBatchSize logAllGTPCommunication logSearchInfo; do \
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
    ls -lh /usr/local/katago/*.gz 2>/dev/null || true && \
    rm -rf /tmp/katago-src

# ---- Stage 2: 构建 Next.js ----
FROM node:24-slim AS app-builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 先复制依赖文件（利用 Docker 缓存层）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 覆盖 npm 镜像配置（Railway 构建环境用默认 registry 更快）
RUN echo "registry=https://registry.npmjs.org/" > .npmrc
RUN pnpm install --frozen-lockfile --prefer-offline 2>/dev/null || pnpm install

# 复制源码并构建（直接用 next build，跳过 tsup 和 prepare.sh）
COPY . .
RUN pnpm next build

# ---- Stage 3: 运行时镜像 ----
FROM node:24-slim AS runner

# 安装 GnuGo（比捆绑二进制更可靠）和运行时依赖
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

# GnuGo 二进制也需要能被找到（项目代码搜索 /usr/games/gnugo）
# apt 安装的 gnugo 已经在 /usr/games/gnugo

# 环境变量
ENV NODE_ENV=production
ENV PORT=5000
ENV HOSTNAME="0.0.0.0"

EXPOSE 5000

# 使用 standalone 模式的 server.js 启动
CMD ["node", "server.js"]
