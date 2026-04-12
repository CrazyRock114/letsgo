#!/bin/bash
# KataGo 自动安装脚本 - 从源码编译 Eigen/AVX2 CPU 后端
# 适用于沙箱环境（无 GPU），每次环境重置后自动恢复
#
# 策略：
#   1. 检查已安装 → 跳过
#   2. 安装编译依赖 (cmake, libeigen3-dev, etc.)
#   3. 从 GitHub 克隆源码并编译 (约2-3分钟)
#   4. 下载神经网络模型 (先尝试小模型，回退到通用模型)
#   5. 生成 CPU 专用配置
#   6. 验证安装
set -Eeuo pipefail

KATAGO_DIR="/usr/local/katago"
KATAGO_BIN="${KATAGO_DIR}/katago"
KATAGO_CFG="${KATAGO_DIR}/gtp.cfg"
KATAGO_VERSION="v1.15.3"
BUILD_DIR="/tmp/katago-build"

# 颜色输出
info()  { echo -e "\033[36m[KataGo]\033[0m $*"; }
warn()  { echo -e "\033[33m[KataGo]\033[0m $*" >&2; }
ok()    { echo -e "\033[32m[KataGo]\033[0m $*"; }
fail()  { echo -e "\033[31m[KataGo]\033[0m $*" >&2; }

# ========== 1. 检查已安装 ==========
if [ -x "${KATAGO_BIN}" ]; then
  # 还需要检查模型是否存在
  if ls "${KATAGO_DIR}"/*.bin.gz 1>/dev/null 2>&1 || ls "${KATAGO_DIR}"/*.txt.gz 1>/dev/null 2>&1; then
    ok "KataGo already installed: $(${KATAGO_BIN} version 2>/dev/null | head -1)"
    exit 0
  fi
fi

info "KataGo not found, starting auto-install..."

# ========== 2. 安装编译依赖 ==========
info "Installing build dependencies..."
apt-get update -qq 2>/dev/null
apt-get install -y -qq cmake libeigen3-dev zlib1g-dev libzip-dev 2>/dev/null
ok "Build dependencies installed"

# ========== 3. 从源码编译 ==========
info "Cloning KataGo ${KATAGO_VERSION} source..."
rm -rf "${BUILD_DIR}"
git clone --depth 1 --branch "${KATAGO_VERSION}" https://github.com/lightvector/KataGo.git "${BUILD_DIR}" 2>/dev/null

info "Compiling KataGo with Eigen/AVX2 CPU backend (this takes ~2-3 minutes)..."
mkdir -p "${BUILD_DIR}/cpp/build"
cd "${BUILD_DIR}/cpp/build"
cmake .. -DUSE_BACKEND=EIGEN -DUSE_AVX2=1 -DCMAKE_BUILD_TYPE=Release 2>/dev/null
make -j"$(nproc)" 2>/dev/null

# 安装到 /usr/local/katago
mkdir -p "${KATAGO_DIR}"
cp katago "${KATAGO_BIN}"
chmod +x "${KATAGO_BIN}"
ok "KataGo compiled and installed: $(${KATAGO_BIN} version 2>/dev/null | head -1)"

# ========== 4. 下载神经网络模型 ==========
# 模型下载策略：始终下载所有可用模型（不同模型支持不同场景）
#   - lionffen b6c64 (2MB, 快速下载, 实测支持所有棋盘大小) 
#   - rect15 b20c256 (87MB, 支持所有棋盘大小, 棋力更强)
# 注: katagotraining.org 主模型库从此沙箱无法访问(403)
#     GitHub releases 下载速度极慢(~25KB/s)

# 尝试下载 lionffen b6c64 小模型 (2MB, 快速，优先使用)
info "Trying to download lionffen b6c64 model (2MB, fast)..."
if curl -sL --max-time 60 -H "Referer: https://katagotraining.org/extra_networks/" \
    -o "${KATAGO_DIR}/lionffen_b6c64.txt.gz" \
    "https://media.katagotraining.org/uploaded/networks/models_extra/lionffen_b6c64_3x3_v10.txt.gz" \
    && [ "$(stat -c%s "${KATAGO_DIR}/lionffen_b6c64.txt.gz" 2>/dev/null || echo 0)" -gt 100000 ]; then
  ok "Downloaded lionffen b6c64 model (fast, all board sizes)"
else
  warn "lionffen model download failed"
  rm -f "${KATAGO_DIR}/lionffen_b6c64.txt.gz"
fi

# 尝试下载 rect15 通用模型 (87MB, 棋力更强)
info "Trying to download rect15 b20c256 model (87MB, stronger - may take a minute)..."
if curl -sL --max-time 300 -H "Referer: https://katagotraining.org/extra_networks/" \
    -o "${KATAGO_DIR}/rect15-b20c256-s343365760-d96847752.bin.gz" \
    "https://media.katagotraining.org/uploaded/networks/models_extra/rect15-b20c256-s343365760-d96847752.bin.gz" \
    && [ "$(stat -c%s "${KATAGO_DIR}/rect15-b20c256-s343365760-d96847752.bin.gz" 2>/dev/null || echo 0)" -gt 10000000 ]; then
  ok "Downloaded rect15 b20c256 model (stronger, all board sizes)"
else
  warn "rect15 model download failed"
  rm -f "${KATAGO_DIR}/rect15-b20c256-s343365760-d96847752.bin.gz"
fi

# 最后尝试从 GitHub releases 下载 human SL 模型 (较慢但可靠)
if ! ls "${KATAGO_DIR}"/*.bin.gz 1>/dev/null 2>&1 && ! ls "${KATAGO_DIR}"/*.txt.gz 1>/dev/null 2>&1; then
  info "No models downloaded yet, trying human SL model from GitHub (slow, ~100MB)..."
  if curl -sL --max-time 600 --retry 1 \
      -o "${KATAGO_DIR}/b18c384nbt-humanv0.bin.gz" \
      "https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz" \
      && [ "$(stat -c%s "${KATAGO_DIR}/b18c384nbt-humanv0.bin.gz" 2>/dev/null || echo 0)" -gt 10000000 ]; then
    ok "Downloaded human SL model from GitHub"
  else
    warn "All model downloads failed"
    rm -f "${KATAGO_DIR}/b18c384nbt-humanv0.bin.gz"
  fi
fi

if ! ls "${KATAGO_DIR}"/*.bin.gz 1>/dev/null 2>&1 && ! ls "${KATAGO_DIR}"/*.txt.gz 1>/dev/null 2>&1; then
  fail "No model downloaded - KataGo will not be usable"
  fail "You can manually download a model to ${KATAGO_DIR}/ and restart"
fi

# ========== 5. 生成配置 ==========
info "Creating GTP configuration..."

# 复制官方完整配置（避免缺少必要字段）
if [ -f "${BUILD_DIR}/cpp/configs/gtp_example.cfg" ]; then
  cp "${BUILD_DIR}/cpp/configs/gtp_example.cfg" "${KATAGO_CFG}"
  
  # 注释掉原始配置中的重复键（避免KataGo因重复键报错崩溃）
  # 这些键会在下面的CPU专用配置段中覆盖
  for key in numSearchThreads nnMaxBatchSize logAllGTPCommunication logSearchInfo; do
    sed -i "s/^[[:space:]]*\(${key}[[:space:]]*=\)/#\\1/; t; s/^\(${key}[[:space:]]*=\)/#\\1/" "${KATAGO_CFG}"
  done
fi

# 追加 CPU 专用覆盖配置
cat >> "${KATAGO_CFG}" << 'CPUCFG'

# ===== 小围棋乐园 CPU 专用覆盖配置 =====
numSearchThreads = 2
nnMaxBatchSize = 8
logAllGTPCommunication = false
logSearchInfo = false
CPUCFG

ok "GTP config created at ${KATAGO_CFG}"

# ========== 6. 验证安装 ==========
info "Verifying installation..."

# 找到第一个可用的模型文件
MODEL_FILE=""
for f in "${KATAGO_DIR}"/*.bin.gz "${KATAGO_DIR}"/*.txt.gz; do
  if [ -f "$f" ]; then
    MODEL_FILE="$f"
    break
  fi
done

if [ -z "${MODEL_FILE}" ]; then
  fail "No model file found - KataGo installed but unusable"
  exit 1
fi

info "Testing with model: $(basename "${MODEL_FILE}")"
if echo -e "name\nversion\nboardsize 9\ngenmove white" | \
   timeout 30 "${KATAGO_BIN}" gtp -model "${MODEL_FILE}" -config "${KATAGO_CFG}" 2>/dev/null | grep -q "KataGo"; then
  ok "KataGo installation verified and working!"
else
  warn "KataGo binary works but GTP test had issues - will try at runtime"
fi

# 清理编译目录
rm -rf "${BUILD_DIR}"

ok "KataGo auto-install complete!"
ok "  Binary: ${KATAGO_BIN}"
ok "  Config: ${KATAGO_CFG}"
ok "  Model:  ${MODEL_FILE}"
