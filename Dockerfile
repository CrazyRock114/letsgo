# ================================================================
# 小围棋乐园 - Docker 镜像
# Next.js + KataGo (预编译二进制) + GnuGo (apt安装)
# ================================================================

# ---- Stage 1: 准备 KataGo（预编译二进制 + 模型）----
FROM node:24-slim AS katago-builder

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl unzip libzip4 && \
    rm -rf /var/lib/apt/lists/*

ARG KATAGO_VERSION=v1.16.4
RUN mkdir -p /usr/local/katago && \
    cd /tmp && \
    KATAGO_URL="https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/katago-${KATAGO_VERSION}-eigenavx2-linux-x64.zip" && \
    echo "Downloading KataGo from: $KATAGO_URL" && \
    curl -fSL --retry 6 --retry-delay 10 --max-time 600 -o katago.zip "$KATAGO_URL" && \
    ls -lh katago.zip && \
    unzip -o katago.zip -d katago-extracted && \
    find katago-extracted -name katago -type f -exec cp {} /usr/local/katago/katago \; && \
    chmod +x /usr/local/katago/katago && \
    echo "Extracting AppImage (Docker has no FUSE)..." && \
    cd /usr/local/katago && \
    ./katago --appimage-extract && \
    # 提取后的二进制可能在不同位置，尝试找到真正的 ELF
    if [ -f squashfs-root/usr/bin/katago ]; then \
        cp squashfs-root/usr/bin/katago ./katago.real; \
    elif [ -f squashfs-root/katago ]; then \
        cp squashfs-root/katago ./katago.real; \
    else \
        find squashfs-root -name katago -type f | head -1 | xargs -I{} cp {} ./katago.real; \
    fi && \
    rm -rf squashfs-root ./katago && \
    mv ./katago.real ./katago && \
    chmod +x ./katago && \
    echo "Verifying katago binary..." && \
    ./katago version && \
    rm -rf /tmp/katago.zip /tmp/katago-extracted

# 直接生成最小化 CPU 配置（不依赖官方配置模板）
RUN cat > /usr/local/katago/gtp.cfg << 'CPUCFG'
# KataGo CPU 专用最小配置 - 小围棋乐园
rules = chinese
koRule = SIMPLE
scoringRule = AREA
taxRule = NONE
multiStoneSuicideLegal = false
hasResignedRule = true
numSearchThreads = 2
nnMaxBatchSize = 8
maxVisits = 1000
logAllGTPCommunication = false
logSearchInfo = false
# 人类风格模型需要此配置
humanSLProfile = preaz_5k
CPUCFG

# Analysis Engine 专用配置（JSON 异步协议）
RUN cat > /usr/local/katago/analysis.cfg << 'ANALYSISCFG'
# KataGo Analysis Engine 配置 - 小围棋乐园
# Railway Hobby plan: ~2 vCPU / ~1GB 内存优化

# 规则
rules = chinese
koRule = SIMPLE
scoringRule = AREA
taxRule = NONE
multiStoneSuicideLegal = false

# 搜索线程（Hobby plan 2 CPU）
numSearchThreads = 2

# 分析引擎设置
reportAnalysisWinratesAs = BLACK
analysisPVLen = 15

# 内存优化（默认 nnCacheSizePowerOfTwo=20 约 1.5GB → 18 约 375MB）
nnCacheSizePowerOfTwo = 18
nnMutexPoolSizePowerOfTwo = 14
nnMaxBatchSize = 4

# 友好 pass（中国规则）
conservativePass = true
friendlyPassOk = true
enablePassingHacks = true

# 人类风格模型预留（仅 humanv0 生效，其他模型忽略）
humanSLProfile = preaz_5k

# 日志控制
logAllGTPCommunication = false
logSearchInfo = false
ANALYSISCFG

# 下载神经网络模型（并行下载多个，供运行时切换选择）
# 1. lionffen b6c64 (2MB, 快, 支持所有棋盘)
RUN curl -fSL --retry 3 --max-time 180 -H "Referer: https://katagotraining.org/extra_networks/" \
      -o /usr/local/katago/lionffen_b6c64.txt.gz \
      "https://media.katagotraining.org/uploaded/networks/models_extra/lionffen_b6c64_3x3_v10.txt.gz" && \
    echo "lionffen download attempted"

# 2. rect15 b20c256 (87MB, 通用, 棋力强)
RUN curl -sL --max-time 300 -H "Referer: https://katagotraining.org/extra_networks/" \
      -o /usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz \
      "https://media.katagotraining.org/uploaded/networks/models_extra/rect15-b20c256-s343365760-d96847752.bin.gz" && \
    echo "rect15 download attempted"

# 3. g170-b6c96 (3.7MB, KataGo官方小模型, 平衡速度与棋力)
RUN curl -sL --max-time 300 \
      -o /usr/local/katago/g170-b6c96-s175395328-d26788732.bin.gz \
      "https://media.katagotraining.org/uploaded/networks/models/g170-b6c96-s175395328-d26788732.bin.gz" || \
    curl -sL --max-time 300 \
      -o /usr/local/katago/g170-b6c96-s175395328-d26788732.bin.gz \
      "https://github.com/lightvector/KataGo/releases/download/v1.12.3/g170-b6c96-s175395328-d26788732.bin.gz" || \
    echo "g170-b6c96 download failed, skipping"

# 4. lionffen b24c64 (4.8MB, 比b6c64更大更深, 棋力更强)
RUN curl -fSL --retry 3 --max-time 180 -H "Referer: https://katagotraining.org/extra_networks/" \
      -o /usr/local/katago/lionffen_b24c64_3x3_v3_12300.bin.gz \
      "https://media.katagotraining.org/uploaded/networks/models_extra/lionffen_b24c64_3x3_v3_12300.bin.gz" && \
    echo "lionffen_b24c64 download attempted"

# 5. b18c384nbt-humanv0 (99MB, 人类风格模型, 下法更自然)
RUN curl -sL --max-time 300 -H "Referer: https://katagotraining.org/extra_networks/" \
      -o /usr/local/katago/b18c384nbt-humanv0.bin.gz \
      "https://media.katagotraining.org/uploaded/networks/models_extra/b18c384nbt-humanv0.bin.gz" && \
    echo "humanv0 download attempted"

# 6. kata9x9-b18c384nbt (97MB, 9x9专用模型, 小棋盘极强)
RUN curl -sL --max-time 300 -H "Referer: https://katagotraining.org/extra_networks/" \
      -o /usr/local/katago/kata9x9-b18c384nbt-20231025.bin.gz \
      "https://media.katagotraining.org/uploaded/networks/models_extra/kata9x9-b18c384nbt-20231025.bin.gz" && \
    echo "kata9x9 download attempted"

# 验证各模型是否下载成功
RUN for f in /usr/local/katago/*.gz; do \
      if [ -f "$f" ]; then \
        size=$(stat -c%s "$f" 2>/dev/null || echo 0); \
        if [ "$size" -gt 100000 ]; then \
          echo "OK: $f (${size} bytes)"; \
        else \
          echo "FAIL: $f too small (${size} bytes), removing"; \
          rm -f "$f"; \
        fi; \
      fi; \
    done

# 验证安装（katago version 必须成功，否则构建失败）
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

# 调试：确认 standalone 输出结构
RUN echo "=== Standalone output structure ===" && \
    find /app/.next/standalone -maxdepth 3 -type f -name "server.js" && \
    echo "=== Static files ===" && \
    ls /app/.next/static/chunks/ 2>/dev/null | head -5 && \
    echo "=== Public files ===" && \
    ls /app/public/ 2>/dev/null | head -5

# ---- Stage 3: 运行时镜像 ----
FROM node:24-slim AS runner

# 安装 GnuGo + KataGo 运行时依赖
# KataGo v1.16.x 编译于 Ubuntu 22.04，原生支持 OpenSSL 3.x，无需 libssl1.1
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends gnugo libgomp1 libzip4 ca-certificates && \
    ln -sf /usr/lib/x86_64-linux-gnu/libzip.so.4 /usr/lib/x86_64-linux-gnu/libzip.so.5 && \
    rm -rf /var/lib/apt/lists/*

# 从 katago-builder 复制 KataGo
COPY --from=katago-builder /usr/local/katago /usr/local/katago

# === Next.js standalone 部署 ===
# standalone 输出直接在 .next/standalone/ 下（非 monorepo 没有 app/ 子目录）
# 复制整个 standalone 到 /app，server.js 就在 /app/server.js
COPY --from=app-builder /app/.next/standalone /app
# static 和 public 需要单独复制（standalone 不包含这些）
COPY --from=app-builder /app/.next/static /app/.next/static
COPY --from=app-builder /app/public /app/public

# 复制启动脚本
COPY --from=app-builder /app/docker-start.sh /app/docker-start.sh
RUN chmod +x /app/docker-start.sh

# 环境变量
ENV NODE_ENV=production
ENV PORT=5000
ENV HOSTNAME="0.0.0.0"

WORKDIR /app

EXPOSE 5000

CMD ["/app/docker-start.sh"]
