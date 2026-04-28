// 引擎共享配置（使用 globalThis 确保跨 API 路由共享状态）
// Next.js 不同 API route 可能不共享模块级变量，globalThis 可解决

interface SharedEngineConfig {
  commentaryDebug: boolean;
}

const GLOBAL_KEY = '__LETSGO_ENGINE_CONFIG__';

function getSharedConfig(): SharedEngineConfig {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { commentaryDebug: false } as SharedEngineConfig;
  }
  return g[GLOBAL_KEY] as SharedEngineConfig;
}

export function getCommentaryDebugShared(): boolean {
  return getSharedConfig().commentaryDebug;
}

export function setCommentaryDebugShared(value: boolean): void {
  getSharedConfig().commentaryDebug = value;
}
