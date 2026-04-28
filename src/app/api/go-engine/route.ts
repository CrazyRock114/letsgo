// Go 引擎 API - 与 KataGo/GnuGo 围棋 AI 引擎通信
// KataGo 使用 Analysis Engine JSON 协议（单进程 + 按需切换模型）
// GnuGo 仍使用 GTP 协议（每次 spawn 新进程）

import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getUserFromAuthHeader, type JWTPayload } from "@/lib/auth";
import { logAiEvent } from "@/lib/ai-logger";
import { getEnginePool, KataGoAnalysisManager, MODEL_PATHS } from "@/lib/katago-analysis-client";
import { getCommentaryDebugShared, setCommentaryDebugShared } from "@/lib/engine-shared-config";

// KataGo分析结果类型
interface KataGoAnalysis {
  winRate: number;       // 黑方胜率 0-100
  scoreLead: number;     // 黑方领先目数（负数=白方领先）
  actualVisits: number;  // 实际完成的搜索次数（kata-analyze时有效）
  bestMoves: {           // 推荐落点（前5，pass排最后）
    move: string;        // GTP坐标 如 "D4"
    winrate: number;     // 该点黑方胜率 0-100
    scoreMean: number;   // 该点目数领先（黑方视角）
    visits: number;      // 该点搜索次数
  }[];
}

// 防止 EPIPE 等管道错误导致进程崩溃（仅注册一次）
if (!process.env._EPIPE_HANDLER_SET) {
  process.on('uncaughtException', (err: unknown) => {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'EPIPE') {
      // KataGo 进程退出后 stdin 写入会触发 EPIPE，忽略即可
      console.warn('[go-engine] Ignored EPIPE error (KataGo process likely exited)');
      return;
    }
    throw err;
  });
  process.env._EPIPE_HANDLER_SET = '1';
}

// 引擎路径：支持环境变量覆盖，以及多路径自动发现
const KATAGO_HOME = process.env.HOME || process.env.USERPROFILE || '';
const KATAGO_CANDIDATES = [
  { path: "/usr/local/katago/katago", dir: "/usr/local/katago", config: "/usr/local/katago/gtp.cfg" },
  { path: `${KATAGO_HOME}/katago/katago`, dir: `${KATAGO_HOME}/katago`, config: `${KATAGO_HOME}/katago/gtp.cfg` },
];

function findKataGoPaths() {
  for (const c of KATAGO_CANDIDATES) {
    if (fs.existsSync(c.path) && fs.existsSync(c.config)) {
      return c;
    }
  }
  return KATAGO_CANDIDATES[0];
}

const KATAGO_PATHS = findKataGoPaths();
const KATAGO_PATH = KATAGO_PATHS.path;
const KATAGO_DIR = KATAGO_PATHS.dir;
const KATAGO_CONFIG = KATAGO_PATHS.config;

// 引擎落子类型（支持pass）
interface EngineMove {
  row: number;
  col: number;
  color: string;
  isPass?: boolean;
}

// GnuGo：优先项目捆绑版本（生产环境），备选系统安装路径（开发环境）
const GNUGO_PATHS = [
  process.cwd() + "/bin/gnugo",  // 项目捆绑，生产环境可用
  "/usr/games/gnugo",             // 系统安装，开发环境
];

// 积分消耗配置
const ENGINE_POINT_COSTS: Record<string, number> = {
  katago: 5,    // KataGo最强，消耗最多
  gnugo: 2,     // GnuGo中等
  local: 0,     // 本地AI免费
};

// 活跃对弈追踪
interface ActiveSession {
  userId: number;
  nickname: string;
  engine: string;
  boardSize: number;
  difficulty: string;
  moveCount: number;
  lastActive: Date;
}
const activeSessions: Map<string, ActiveSession> = new Map();

// 分析引擎配置（可在monitor页面动态调整）
// 0 = kata-raw-nn（瞬时，纯神经网络直出）
// >0 = kata-analyze（MCTS搜索N秒后用GTP stop中断）
let analysisSeconds = 3;
let currentModelPath: string | null = null;

// ============================================================
// 双引擎常驻配置（方案B：按功能区分 2 进程）
// 时间戳: 2026-04-25 02:47:01
// ============================================================

interface EngineConfig {
  gameModel: string;       // 对弈专用模型
  gameVisits: { easy: number; medium: number; hard: number };
  analysisModel: string;   // 分析专用模型（单引擎模式下跟随 gameModel）
  analysisVisits: { easy: number; medium: number; hard: number };
  dualEngine: boolean;     // true=双引擎独立，false=单引擎共用（默认）
  commentaryDebug: boolean; // 解说是否输出客观参数（调试模式）
}

const DEFAULT_GAME_MODEL = 'rect15';

// 使用 globalThis 持久化引擎配置，防止 Next.js HMR/模块重载导致配置丢失
const ENGINE_CONFIG_KEY = '__LETSGO_ENGINE_CONFIG__';
function getEngineConfig(): EngineConfig {
  const g = globalThis as Record<string, unknown>;
  if (!g[ENGINE_CONFIG_KEY]) {
    g[ENGINE_CONFIG_KEY] = {
      gameModel: DEFAULT_GAME_MODEL,
      gameVisits: { easy: 30, medium: 80, hard: 150 },
      analysisModel: DEFAULT_GAME_MODEL,
      // 解说分析需要更高 visits，低 visits 下胜率估计不稳定，会导致排序异常
      analysisVisits: { easy: 100, medium: 200, hard: 300 },
      dualEngine: false,
      commentaryDebug: false,
    } as EngineConfig;
  }
  return g[ENGINE_CONFIG_KEY] as EngineConfig;
}

let engineConfig: EngineConfig = getEngineConfig();

export function getCommentaryDebug(): boolean {
  const value = getCommentaryDebugShared();
  console.log(`[go-engine] getCommentaryDebug called, value=${value}`);
  return value;
}

function getGameEngine(): KataGoAnalysisManager {
  return getEnginePool().getEngine(engineConfig.gameModel);
}

function getAnalysisEngine(): KataGoAnalysisManager {
  if (!engineConfig.dualEngine) {
    return getGameEngine();  // 单引擎模式：共用对弈引擎
  }
  return getEnginePool().getEngine(engineConfig.analysisModel);
}

// 获取所有可用的KataGo模型列表
function getAvailableModels(): Array<{ name: string; path: string; sizeMB: number }> {
  try {
    const files = fs.readdirSync(KATAGO_DIR);
    const modelFiles = files.filter(f => f.endsWith(".bin.gz") || f.endsWith(".txt.gz"));
    return modelFiles.map(f => {
      const path = `${KATAGO_DIR}/${f}`;
      const stats = fs.statSync(path);
      return {
        name: f,
        path,
        sizeMB: Math.round(stats.size / 1024 / 1024 * 10) / 10,
      };
    });
  } catch {
    return [];
  }
}

// 获取模型显示名称
function getModelDisplayName(path: string): string {
  const basename = path.split('/').pop() || path;
  if (/kata9x9/.test(basename)) return 'Kata9x9-B18C384 (9x9专用, 97MB, 小棋盘极强)';
  if (/b18c384nbt-humanv0/.test(basename)) return 'HumanV0-B18C384 (人类风格, 99MB, 自然)';
  if (/rect15-b20c256/.test(basename)) return 'Rect15-B20C256 (通用, 87MB, 强)';
  if (/lionffen_b24c64/.test(basename)) return 'Lionffen-B24C64 (较大, 4.8MB, 比b6c64强)';
  if (/lionffen/.test(basename)) return 'Lionffen-B6C64 (小模型, 2MB, 快)';
  if (/g170-b6c96/.test(basename)) return 'G170-B6C96 (官方小模型, 3.7MB, 均衡)';
  if (/b28c512/.test(basename)) return 'Kata1-B28C512 (超大模型, 271MB, 超专业级)';
  if (/b10c128/.test(basename)) return 'Kata1-B10C128 (中模型, 11MB, ~1-3级)';
  if (/b20c256/.test(basename)) return 'B20C256 (中模型)';
  if (/b18c384/.test(basename)) return 'Kata1-B18C384 (大模型, 98MB, 专业级)';
  if (/b40c256/.test(basename)) return 'B40C256 (超大模型)';
  return basename;
}

// 将文件路径映射为 Analysis Engine 模型名（用于 switchModel）
function getModelKeyFromPath(path: string): string | null {
  const basename = path.split('/').pop() || path;
  if (/kata9x9/.test(basename)) return 'kata9x9';
  if (/b18c384nbt-humanv0/.test(basename)) return 'humanv0';
  if (/rect15-b20c256/.test(basename)) return 'rect15';
  if (/lionffen_b24c64/.test(basename)) return 'b24c64';
  if (/lionffen_b6c64/.test(basename)) return 'b6c64';
  if (/g170-b6c96/.test(basename)) return 'g170';
  if (/b28c512/.test(basename)) return 'b28c512';
  if (/b10c128/.test(basename)) return 'b10c128';
  // b18c384 要放在最后（humanv0 和 kata9x9 已优先匹配）
  if (/b18c384/.test(basename)) return 'b18c384';
  return null;
}

// 将 Analysis Engine 模型名映射为显示用的路径（兼容旧格式）
function getModelPathFromKey(key: string): string | null {
  const map: Record<string, string> = {
    rect15: `${KATAGO_DIR}/rect15-b20c256-s343365760-d96847752.bin.gz`,
    kata9x9: `${KATAGO_DIR}/kata9x9-b18c384nbt-20231025.bin.gz`,
    humanv0: `${KATAGO_DIR}/b18c384nbt-humanv0.bin.gz`,
    g170: `${KATAGO_DIR}/g170-b6c96-s175395328-d26788732.bin.gz`,
    b6c64: `${KATAGO_DIR}/lionffen_b6c64.txt.gz`,
    b24c64: `${KATAGO_DIR}/lionffen_b24c64_3x3_v3_12300.bin.gz`,
    b10c128: `${KATAGO_DIR}/kata1-b10c128-s1141046784-d204142634.txt.gz`,
    b18c384: `${KATAGO_DIR}/kata1-b18c384nbt-s7709731328-d3715293823.bin.gz`,
    b28c512: `${KATAGO_DIR}/kata1-b28c512nbt-s12763923712-d5805955894.bin.gz`,
  };
  return map[key] || null;
}

// KataGo分析结果缓存（LRU + 过期清理，防止内存泄漏）
const analysisCache: Map<string, { data: KataGoAnalysis; timestamp: number }> = new Map();
const ANALYSIS_CACHE_MAX_SIZE = 500;
const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000; // 30分钟过期

function pruneAnalysisCache(): void {
  // 1. 清理过期条目
  const now = Date.now();
  const cutoff = now - ANALYSIS_CACHE_TTL_MS;
  for (const [key, entry] of analysisCache) {
    if (entry.timestamp < cutoff) {
      analysisCache.delete(key);
    }
  }
  // 2. 如果仍超过上限，删除最旧的条目
  if (analysisCache.size > ANALYSIS_CACHE_MAX_SIZE) {
    const sorted = Array.from(analysisCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = sorted.slice(0, analysisCache.size - ANALYSIS_CACHE_MAX_SIZE);
    for (const [key] of toDelete) {
      analysisCache.delete(key);
    }
  }
}

function setAnalysisCache(moves: EngineMove[], data: KataGoAnalysis): void {
  const cacheKey = moves.map(m => `${m.color[0]}${m.row},${m.col}`).join('|');
  pruneAnalysisCache();
  analysisCache.set(cacheKey, { data, timestamp: Date.now() });
}

// 导出查询分析缓存的方法（供go-ai使用）
export function getCachedAnalysis(moves: EngineMove[]): KataGoAnalysis | null {
  const cacheKey = moves.map(m => `${m.color[0]}${m.row},${m.col}`).join('|');
  const cached = analysisCache.get(cacheKey);
  // 检查是否过期
  if (cached && Date.now() - cached.timestamp > ANALYSIS_CACHE_TTL_MS) {
    analysisCache.delete(cacheKey);
    return null;
  }
  return cached?.data || null;
}

function trackActiveSession(userId: number, nickname: string, engine: string, boardSize: number, difficulty: string, moveCount: number) {
  const key = `${userId}-${engine}`;
  activeSessions.set(key, { userId, nickname, engine, boardSize, difficulty, moveCount, lastActive: new Date() });
  // 清理10分钟未活跃的会话
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of activeSessions) {
    if (v.lastActive.getTime() < cutoff) activeSessions.delete(k);
  }
}

// 引擎监控数据导出
export function getEngineMonitorData() {
  const currentInfo = engineQueue.getCurrentEntryInfo();
  const available = getAvailableModels();
  const gameModelPath = getModelPathFromKey(engineConfig.gameModel);
  const analysisModelPath = getModelPathFromKey(engineConfig.analysisModel);
  return {
    kataGo: {
      queueLength: engineQueue.getQueueLength(),
      processing: engineQueue.isProcessing(),
      currentTask: currentInfo ? { id: currentInfo.id, userId: currentInfo.userId, isAnalysis: currentInfo.isAnalysis, engine: currentInfo.engine } : null,
      analysisSeconds,  // 当前分析配置
      queueEntries: engineQueue.getQueueEntries(),  // 队列中每个任务的详情
      gameModel: gameModelPath ? { path: gameModelPath, name: getModelDisplayName(gameModelPath), key: engineConfig.gameModel } : null,
      analysisModel: analysisModelPath ? { path: analysisModelPath, name: getModelDisplayName(analysisModelPath), key: engineConfig.analysisModel } : null,
      engineConfig: {
        ...engineConfig,
        commentaryDebug: getCommentaryDebugShared(),
      },
      availableModels: available.map(m => ({ ...m, displayName: getModelDisplayName(m.path), key: getModelKeyFromPath(m.path) })),
    },
    gnugo: { queueLength: 0, processing: false, note: '独立并行，不走EngineQueue' },
    activeSessions: Array.from(activeSessions.values()).map(s => ({
      player: s.nickname,
      engine: s.engine,
      boardSize: s.boardSize,
      difficulty: s.difficulty,
      totalMoves: s.moveCount,
      lastActive: s.lastActive.toISOString(),
    })),
    activeCount: activeSessions.size,
  };
}

// 自动查找KataGo可用的神经网络模型
// 支持多种模型格式(.bin.gz, .txt.gz)，按优先级返回
function findKataGoModel(): string | null {
  // 如果已指定模型且文件存在，优先使用
  if (currentModelPath && fs.existsSync(currentModelPath)) {
    return currentModelPath;
  }

  // 优先级顺序：lionffen_b24c64(4.8MB,较强) > rect15(87MB,通用最强) > humanv0(99MB,人类风格)
  // > kata9x9(97MB,9x9专用) > g170-b6c96(3.7MB) > lionffen_b6c64(2MB,最快) > 其他
  const priorityPatterns = [
    /lionffen_b24c64/,    // lionffen较大版本(4.8MB)，比b6c64强
    /rect15/,             // rect15通用模型(87MB)，支持所有棋盘，棋力强
    /b18c384nbt-humanv0/, // 人类风格模型(99MB)
    /kata9x9/,            // 9x9专用模型(97MB)
    /g170-b6c96/,         // 官方小模型(3.7MB)，支持所有棋盘
    /lionffen/,           // lionffen最小模型(2MB)，最快
    /b6c96/,              // 通用小模型
    /b20c256/,            // b20系列
  ];

  try {
    const files = fs.readdirSync(KATAGO_DIR);
    const modelFiles = files.filter(f => f.endsWith(".bin.gz") || f.endsWith(".txt.gz"));

    if (modelFiles.length === 0) return null;

    // 按优先级匹配
    for (const pattern of priorityPatterns) {
      const match = modelFiles.find(f => pattern.test(f));
      if (match) return `${KATAGO_DIR}/${match}`;
    }

    // 没有优先匹配，返回第一个可用模型
    return `${KATAGO_DIR}/${modelFiles[0]}`;
  } catch {
    return null;
  }
}

// 检查KataGo是否可用（二进制+模型+配置都存在）
function isKataGoAvailable(): boolean {
  return fs.existsSync(KATAGO_PATH) && findKataGoModel() !== null;
}

// 查找可用的GnuGo路径
function findGnuGoPath(): string | null {
  for (const p of GNUGO_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 检查GnuGo是否可用
function isGnuGoAvailable(): boolean {
  return findGnuGoPath() !== null;
}

// 围棋坐标转GTP坐标
function boardToGTPCoord(row: number, col: number, boardSize: number): string {
  const colChar = col >= 8 ? String.fromCharCode(65 + col + 1) : String.fromCharCode(65 + col);
  const rowNum = boardSize - row;
  return `${colChar}${rowNum}`;
}

// GTP坐标转棋盘坐标
function gtpToBoardCoord(gtpCoord: string, boardSize: number): { row: number; col: number } | null {
  const match = gtpCoord.toUpperCase().match(/^([A-HJ-T])(\d+)$/);
  if (!match) return null;

  const colChar = match[1];
  const rowNum = parseInt(match[2]);

  let col = colChar.charCodeAt(0) - 65;
  if (col >= 8) col -= 1; // 跳过I

  const row = boardSize - rowNum;

  if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) return null;
  return { row, col };
}

// 获取贴目值
// 来源: KataGo 官方 9x9 opening book (katagobooks.org)
// 这些是 fair komi (让黑白均势的贴目值)，偏离会扭曲 KataGo 胜率评估
function getKomi(boardSize: number): number {
  if (boardSize <= 9) return 7;     // 9x9 fair komi = 7
  if (boardSize <= 13) return 7.5;  // 13x13 标准
  return 7.5;                       // 19x19 标准
}

// KataGo 难度映射 - 通过 maxVisits 控制棋力
// gameVisits / analysisVisits 分别配置
function getKataGoVisits(difficulty: string, engineType: 'game' | 'analysis' = 'game'): number {
  const visits = engineType === 'game' ? engineConfig.gameVisits : engineConfig.analysisVisits;
  if (difficulty === "easy") return visits.easy;
  if (difficulty === "medium") return visits.medium;
  return visits.hard;
}

// JS 层超时保护（秒）
function getKataGoMaxTime(difficulty: string): number {
  if (difficulty === "easy") return 15;
  if (difficulty === "medium") return 20;
  return 30;
}

// GnuGo难度映射
function getGnuGoLevel(difficulty: string): number {
  if (difficulty === "easy") return 3;
  if (difficulty === "medium") return 7;
  return 10;
}


// 预热KataGo引擎：服务启动时后台加载模型，避免首个请求冷启动
// 单引擎模式只加载对弈引擎，双引擎模式加载对弈+分析引擎
export async function warmupKataGo(): Promise<void> {
  try {
    if (!isKataGoAvailable()) {
      console.log('[warmup] KataGo not available (binary/model/config missing), skipping warmup');
      return;
    }
    const pool = getEnginePool();
    const start = Date.now();

    // 预热对弈引擎（始终需要）
    console.log(`[warmup] Starting game engine (${engineConfig.gameModel})...`);
    const gameEngine = pool.getEngine(engineConfig.gameModel);
    await gameEngine.start();

    // 双引擎模式下额外预热分析引擎
    if (engineConfig.dualEngine && engineConfig.analysisModel !== engineConfig.gameModel) {
      console.log(`[warmup] Starting analysis engine (${engineConfig.analysisModel})...`);
      const analysisEngine = pool.getEngine(engineConfig.analysisModel);
      await analysisEngine.start();
      console.log(`[warmup] KataGo dual-engine ready in ${Date.now() - start}ms (game=${engineConfig.gameModel}, analysis=${engineConfig.analysisModel})`);
    } else {
      console.log(`[warmup] KataGo single-engine ready in ${Date.now() - start}ms (model=${engineConfig.gameModel})`);
    }
  } catch (err) {
    console.warn('[warmup] KataGo warmup failed:', err instanceof Error ? err.message : String(err));
  }
}

// ============================================================
// KataGo 落子（Analysis Engine JSON 协议）
// 替代 GTP genmove，每请求自带完整局面，无状态污染
// ============================================================
async function getKataGoMove(
  boardSize: number,
  moves: EngineMove[],
  difficulty: string,
  aiColor: 'black' | 'white' = 'white'
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string; engineError?: boolean; actualVisits?: number; modelUsed?: string; warning?: string }> {
  const manager = getGameEngine();
  const maxVisits = getKataGoVisits(difficulty, 'game');
  const maxTime = getKataGoMaxTime(difficulty);
  const modelUsed = engineConfig.gameModel;

  console.log(`[KataGo] getKataGoMove START (game engine): board=${boardSize}, diff=${difficulty}, maxVisits=${maxVisits}, maxTime=${maxTime}s, aiColor=${aiColor}, moves=${moves.length}, model=${modelUsed}`);

  const startTime = Date.now();

  try {
    await manager.start();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[KataGo] Game Engine start failed:`, errMsg);
    return { move: null, engineError: true, engine: 'katago' };
  }

  try {
    const result = await manager.genmove(boardSize, moves as Array<{ row: number; col: number; color: "black" | "white"; isPass?: boolean }>, aiColor, {
      maxVisits,
      maxTime: maxTime + 10, // JS 层超时 = 预期时间 + 10s 缓冲
      komi: getKomi(boardSize),
      rules: 'chinese',
    });

    const elapsed = Date.now() - startTime;
    const common = { engine: 'katago' as const, actualVisits: result.actualVisits, modelUsed };
    if (result.pass) {
      const nonPassCount = moves.filter(m => !m.isPass).length;
      const isEarlyGame = nonPassCount < boardSize * 2;
      if (isEarlyGame) {
        const warning = `AI 在开局第 ${nonPassCount + 1} 手选择了 pass（棋盘还很空），这通常是模型/配置问题！model=${modelUsed}, visits=${result.actualVisits}`;
        console.error(`[KataGo] EARLY PASS BUG: ${warning}`);
        logAiEvent({ type: 'pass_bug', engine: 'katago', model: modelUsed, boardSize, difficulty, coord: 'pass', isPass: true, durationMs: elapsed });
        return { move: null, engineError: true, engine: 'katago', modelUsed, warning };
      }
      console.log(`[KataGo] PASS (game) ${elapsed}ms visits=${result.actualVisits ?? '-'}`);
      return { move: null, pass: true, ...common };
    }
    if (result.resign) {
      console.log(`[KataGo] RESIGN (game) ${elapsed}ms visits=${result.actualVisits ?? '-'}`);
      return { move: null, resign: true, ...common };
    }
    if (!result.move) {
      console.warn(`[KataGo] No move returned (game) ${elapsed}ms`);
      return { move: null, engineError: true, ...common };
    }

    console.log(`[KataGo] MOVE (game): (${result.move.row},${result.move.col}) ${elapsed}ms visits=${result.actualVisits ?? '-'}`);
    return { move: result.move, ...common };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[KataGo] genmove failed after ${elapsed}ms:`, errMsg);
    return { move: null, engineError: true, engine: 'katago', modelUsed };
  }
}

// ============================================================
// KataGo 分析（Analysis Engine JSON 协议）
// 替代 GTP kata-analyze / kata-raw-nn
// ============================================================
async function getKataGoAnalysis(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: "black" | "white"; isPass?: boolean }>,
  overrideSeconds?: number,
  difficulty?: string
): Promise<KataGoAnalysis | null> {
  const manager = getAnalysisEngine();
  const modelUsed = engineConfig.analysisModel;

  try {
    await manager.start();
  } catch (e) {
    console.log('[kata-analysis] Analysis Engine 启动失败:', e instanceof Error ? e.message : String(e));
    return null;
  }

  try {
    // 优先使用 difficulty 映射 visits；兼容旧版 overrideSeconds
    let maxVisits: number;
    if (difficulty) {
      maxVisits = getKataGoVisits(difficulty, 'analysis');
    } else if (overrideSeconds !== undefined) {
      const seconds = overrideSeconds;
      maxVisits = seconds === 0 ? 1 : Math.min(2000, Math.max(30, seconds * 50));
    } else {
      maxVisits = getKataGoVisits('medium', 'analysis');
    }
    console.log(`[kata-analysis] maxVisits=${maxVisits}, difficulty=${difficulty || '-'}, engineConfig.analysisVisits=${JSON.stringify(engineConfig.analysisVisits)}`);
    const jsTimeout = Math.max(30, maxVisits * 0.5) + 10; // JS 层超时保护
    const result = await manager.analyze(boardSize, moves, {
      maxVisits,
      maxTime: jsTimeout,
      komi: getKomi(boardSize),
      rules: 'chinese',
    });
    console.log(`[kata-analysis] Analysis Engine 完成: board=${boardSize}, moves=${moves.length}, difficulty=${difficulty || '-'}, visits=${result?.actualVisits ?? '-'}`);
    return result;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[kata-analysis] 分析失败:', errMsg);
    return null;
  }
}

// ============================================================
// GnuGo落子（每次spawn新进程，GnuGo启动快）
// ============================================================
async function getGnuGoMove(
  boardSize: number,
  moves: EngineMove[],
  difficulty: string,
  aiColor: 'black' | 'white' = 'white'
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engineError?: boolean; engine: string }> {
  const komi = getKomi(boardSize);
  const gnugoLevel = getGnuGoLevel(difficulty);
  console.log(`[GnuGo] getGnuGoMove START: board=${boardSize}, diff=${difficulty}, level=${gnugoLevel}, aiColor=${aiColor}, moves=${moves.length}`);

  const gnugoPath = findGnuGoPath();
  if (!gnugoPath) throw new Error("GnuGo not found");

  const proc = spawn(gnugoPath, [
    "--mode", "gtp",
    "--level", String(gnugoLevel),
    "--boardsize", String(boardSize),
    "--komi", String(komi),
    "--chinese-rules",
  ]);

  await new Promise(r => setTimeout(r, 200));

  const gtpCommands: string[] = [
    `boardsize ${boardSize}`,
    "clear_board",
    `komi ${komi}`,
  ];

  if (moves && Array.isArray(moves)) {
    for (const move of moves) {
      const color = move.color === "black" ? "B" : "W";
      if (move.isPass) {
        gtpCommands.push(`play ${color} pass`);
      } else {
        const coord = boardToGTPCoord(move.row, move.col, boardSize);
        gtpCommands.push(`play ${color} ${coord}`);
      }
    }
  }

  gtpCommands.push(`genmove ${aiColor === 'black' ? 'B' : 'W'}`);
  console.log(`[GnuGo] GTP commands: ${JSON.stringify(gtpCommands)}`);

  // GnuGo用一次性命令发送方式
  try {
    const results: string[] = [];
    for (const cmd of gtpCommands) {
      const resp = await sendOneShotGTP(proc, cmd, 30000);
      results.push(resp);
    }
    console.log(`[GnuGo] GTP responses count=${results.length}, lastResponse="${results[results.length - 1]}"`);

    const lastResponse = results[results.length - 1];
    const moveMatch = lastResponse.match(/=\s*([A-HJ-T]\d+|PASS|resign)/i);

    if (!moveMatch) {
      console.warn(`[GnuGo] Unexpected genmove response: "${lastResponse}"`);
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, pass: false, engineError: true, engine: "gnugo" };
    }

    const moveStr = moveMatch[1].toUpperCase();

    if (moveStr === "PASS") {
      console.log(`[GnuGo] PASS`);
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, pass: true, engine: "gnugo" };
    }

    if (moveStr === "RESIGN") {
      console.log(`[GnuGo] RESIGN`);
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, resign: true, engine: "gnugo" };
    }

    const position = gtpToBoardCoord(moveStr, boardSize);
    proc.stdin?.write("quit\n");
    proc.kill();

    if (!position) {
      console.error(`[GnuGo] Cannot parse coord: ${moveStr}`);
      throw new Error("无法解析GnuGo落子坐标");
    }

    console.log(`[GnuGo] MOVE: ${moveStr} -> (${position.row},${position.col})`);
    return { move: position, engine: "gnugo" };
  } catch (gtpError) {
    console.error(`[GnuGo] GTP error:`, gtpError instanceof Error ? gtpError.message : String(gtpError));
    proc.kill();
    throw gtpError;
  }
}

// 一次性GTP命令（用于GnuGo等临时进程）
function sendOneShotGTP(proc: ChildProcess, command: string, timeoutMs: number = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;

    const cleanup = () => {
      proc.stdout?.removeListener("data", onData);
      clearTimeout(timeout);
    };

    const onData = (data: Buffer) => {
      output += data.toString();
      // GTP 响应以 "\n\n" 结束，且必须以 "= " 或 "? " 开头
      // 某些引擎可能在响应前输出空行或警告，持续读取直到找到有效的 GTP 响应
      while (!settled) {
        const endIdx = output.indexOf("\n\n");
        if (endIdx === -1) break;
        const response = output.substring(0, endIdx).trim();
        output = output.substring(endIdx + 2);
        // 跳过空行或非 GTP 输出的内容（如引擎启动信息、空行等）
        if (response.startsWith("=") || response.startsWith("?")) {
          settled = true;
          cleanup();
          resolve(response);
          return;
        }
        // 跳过空行和无关输出，继续等待
      }
    };

    proc.stdout?.on("data", onData);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`GTP command timeout: ${command}, output="${output.substring(0, 200)}"`));
      }
    }, timeoutMs);

    proc.stdin?.write(command + "\n");
  });
}

// ============================================================
// 积分系统
// ============================================================
const ENGINE_COSTS: Record<string, number> = {
  katago: 5,
  gnugo: 2,
  local: 0,
};

function getEngineCost(engine: string): number {
  return ENGINE_COSTS[engine] ?? 0;
}

// ============================================================
// 引擎排队系统
// ============================================================
interface QueueEntry {
  id: string;
  userId: number;
  resolve: (result: EngineQueueResult) => void;
  reject: (error: Error) => void;
  boardSize: number;
  moves: EngineMove[];
  difficulty: string;
  engine: string;
  aiColor: 'black' | 'white';
  isAnalysis?: boolean; // 分析请求标记
  analysisResolve?: (v: KataGoAnalysis | null) => void; // 分析结果回调
  analysisSeconds?: number; // 单次分析时长覆盖（秒）
}

interface EngineQueueResult {
  move: { row: number; col: number } | null;
  pass?: boolean;
  resign?: boolean;
  engine: string;
  engineError?: boolean;
  errorDetail?: string;
  noEngine?: boolean;
  analysis?: KataGoAnalysis | null; // genmove+analysis时返回
  actualVisits?: number;
  modelUsed?: string;
}

class EngineQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private entryId = 0;
  private currentEntry: QueueEntry | null = null; // 当前正在处理的条目

  /** 取消指定用户排队中的分析请求（下棋请求优先，只影响同一用户的分析） */
  cancelPendingAnalysis(userId: number): number {
    const before = this.queue.length;
    this.queue = this.queue.filter(entry => {
      if (entry.isAnalysis && entry.userId === userId) {
        // 通知等待者分析已被取消
        if (entry.analysisResolve) entry.analysisResolve(null);
        return false;
      }
      return true;
    });
    const cancelled = before - this.queue.length;
    if (cancelled > 0) {
      console.log(`[engine-queue] Cancelled ${cancelled} pending analysis request(s) for user ${userId}`);
    }
    return cancelled;
  }

  async enqueue(
    userId: number,
    engine: string,
    boardSize: number,
    moves: EngineMove[],
    difficulty: string,
    aiColor: 'black' | 'white' = 'white',

  ): Promise<EngineQueueResult> {
    const id = `qe-${++this.entryId}-u${userId}`;
    console.log(`[engine-queue] Enqueued: ${id}, engine=${engine}, aiColor=${aiColor}, queueLen=${this.queue.length}`);

    // 下棋请求优先：取消该用户排队中的分析请求
    this.cancelPendingAnalysis(userId);

    return new Promise<EngineQueueResult>((resolve, reject) => {
      this.queue.push({ id, userId, resolve, reject, boardSize, moves, difficulty, engine, aiColor });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    this.currentEntry = this.queue.shift()!;
    const entry = this.currentEntry;
    console.log(`[engine-queue] Processing: ${entry.id}, engine=${entry.engine}, isAnalysis=${!!entry.isAnalysis}`);

    try {
      // 分析请求：只使用KataGo，不影响下棋结果
      if (entry.isAnalysis) {
        let analysisResult: KataGoAnalysis | null = null;
        if (isKataGoAvailable()) {
          try {
            const entrySeconds = entry.analysisSeconds !== undefined ? entry.analysisSeconds : analysisSeconds;
            // 安全超时：analysisSeconds秒 + 30s缓冲（防止getKataGoAnalysis内部stop失败时无限等待）
            const analysisTimeout = (entrySeconds || 0) * 1000 + 30000;
            let queueTimeoutId: ReturnType<typeof setTimeout> | null = null;

            analysisResult = await Promise.race([
              getKataGoAnalysis(entry.boardSize, entry.moves as Array<{row: number; col: number; color: 'black' | 'white'}>, entrySeconds),
              new Promise<null>(resolve => {
                queueTimeoutId = setTimeout(() => {
                  console.warn(`[engine-queue] Analysis safety timeout (${Math.round(analysisTimeout/1000)}s) for ${entry.id}`);
                  resolve(null);
                }, analysisTimeout);
              }),
            ]);
            // 清除队列超时计时器
            if (queueTimeoutId !== null) clearTimeout(queueTimeoutId);
          } catch (err) {
            console.warn(`[engine-queue] Analysis failed:`, err instanceof Error ? err.message : String(err));
          }
        }
        if (entry.analysisResolve) {
          entry.analysisResolve(analysisResult);
        }
        if (analysisResult && entry.moves) {
          setAnalysisCache(entry.moves, analysisResult);
        }
        console.log(`[engine-queue] Completed: ${entry.id}, type=analysis, hasResult=${!!analysisResult}, winRate=${analysisResult?.winRate ?? '-'}, scoreLead=${analysisResult?.scoreLead ?? '-'}`);
        // 分析请求不走正常resolve
      } else {
        let result: EngineQueueResult;

        if (entry.engine === "katago" && isKataGoAvailable()) {
          console.log(`[engine-queue] Executing KataGo: ${entry.id}, board=${entry.boardSize}, diff=${entry.difficulty}, moves=${entry.moves.length}`);
          try {
            const moveResult = await getKataGoMove(entry.boardSize, entry.moves, entry.difficulty, entry.aiColor);
            result = { ...moveResult };
            console.log(`[engine-queue] KataGo success: ${entry.id}, move=${result.move ? `(${result.move.row},${result.move.col})` : result.pass ? 'PASS' : 'null'}, engineError=${result.engineError}`);
          } catch (katagoError) {
            const errMsg = katagoError instanceof Error ? katagoError.message : String(katagoError);
            console.error(`[engine-queue] KataGo FAILED: ${entry.id}, error=${errMsg}`);
            // Analysis Engine errors are per-request, no crash state to reset
            result = {
              move: null, engine: "katago", engineError: true,
              errorDetail: errMsg,
            };
          }
        } else if (entry.engine === "gnugo" && isGnuGoAvailable()) {
          console.log(`[engine-queue] Executing GnuGo: ${entry.id}, board=${entry.boardSize}, diff=${entry.difficulty}, moves=${entry.moves.length}`);
          try {
            const moveResult = await getGnuGoMove(entry.boardSize, entry.moves, entry.difficulty, entry.aiColor);
            result = { ...moveResult };
            console.log(`[engine-queue] GnuGo success: ${entry.id}, move=${result.move ? `(${result.move.row},${result.move.col})` : result.pass ? 'PASS' : 'null'}, engineError=${result.engineError}`);
          } catch (gtpError) {
            const errMsg = gtpError instanceof Error ? gtpError.message : String(gtpError);
            console.error(`[engine-queue] GnuGo FAILED: ${entry.id}, error=${errMsg}`);
            result = {
              move: null, engine: "gnugo", engineError: true,
              errorDetail: errMsg,
            };
          }
        } else {
          console.log(`[engine-queue] Engine not available: ${entry.id}, engine=${entry.engine}, katagoAvail=${isKataGoAvailable()}, gnugoAvail=${isGnuGoAvailable()}`);
          result = { move: null, engine: entry.engine || "local", noEngine: true };
        }

        console.log(`[engine-queue] Completed: ${entry.id}, engine=${result.engine}, hasMove=${!!result.move}, pass=${!!result.pass}, error=${result.engineError || false}`);
        entry.resolve(result);
      }
    } catch (error) {
      if (entry.isAnalysis && entry.analysisResolve) {
        entry.analysisResolve(null);
      } else {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.processing = false;
      this.currentEntry = null;
      // Process next in queue
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getCurrentEntryInfo(): { id: string; userId: number; isAnalysis: boolean; engine: string } | null {
    if (!this.currentEntry) return null;
    return { id: this.currentEntry.id, userId: this.currentEntry.userId, isAnalysis: !!this.currentEntry.isAnalysis, engine: this.currentEntry.engine };
  }

  /** 获取KataGo局面分析（通过主队列串行执行，避免与genmove命令冲突）
   *  队列保护：排队数 >= ANALYSIS_QUEUE_THRESHOLD(5) 时拒绝新analysis请求
   */
  async enqueueAnalysis(userId: number, moves: Array<{row: number, col: number, color: "black" | "white"; isPass?: boolean}>, boardSize: number, isAITest = false, analysisSeconds?: number): Promise<{ analysis: KataGoAnalysis | null; queueBusy?: boolean; queueLength?: number }> {
    // 检查KataGo是否可用
    if (!isKataGoAvailable()) {
      console.log(`[engine-queue] Analysis rejected: KataGo不可用`);
      return { analysis: null };
    }
    // 队列保护：排队数 >= 5 时拒绝，避免analysis阻塞genmove（AI测试模式不受限制）
    const currentQueueLen = this.queue.length;
    const ANALYSIS_QUEUE_THRESHOLD = 5;
    if (!isAITest && currentQueueLen >= ANALYSIS_QUEUE_THRESHOLD) {
      console.log(`[engine-queue] Analysis rejected: 队列过长(${currentQueueLen} >= ${ANALYSIS_QUEUE_THRESHOLD}), user=${userId}`);
      return { analysis: null, queueBusy: true, queueLength: currentQueueLen };
    }
    const id = `qe-${++this.entryId}-analysis`;
    console.log(`[engine-queue] Enqueued analysis: ${id}, user=${userId}, queueLen=${currentQueueLen}, isAITest=${isAITest}, seconds=${analysisSeconds ?? 'global'}`);
    return new Promise<{ analysis: KataGoAnalysis | null }>((resolve) => {
      this.queue.push({
        id,
        userId,
        resolve: () => {}, // 分析请求不走正常resolve
        reject: () => {},
        boardSize,
        moves,
        difficulty: '',
        engine: 'katago',
        aiColor: 'black',
        isAnalysis: true,
        analysisResolve: (result: KataGoAnalysis | null) => resolve({ analysis: result }),
        analysisSeconds,
      });
      this.processNext();
    });
  }
  /** 获取排队位置（含当前正在处理的任务） */
  getQueuePosition(userId?: number): { queueLength: number; userPosition: number; hasAnalysis: boolean } {
    let userPosition = -1;
    let hasAnalysis = false;

    // 如果当前正在处理的任务是自己的，position=0（正在处理，不需要排队）
    if (userId && this.currentEntry && this.currentEntry.userId === userId) {
      userPosition = 0; // 0 = 正在处理中
    }

    // 在队列中查找该用户的位置
    if (userId && userPosition === -1) {
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].userId === userId) {
          // 前方任务数 = 队列中排在前面的i个 + 正在处理的1个
          // 用户位置编号 = 前方任务数（"你在第x位"，从1开始）
          userPosition = i + (this.processing ? 1 : 0);
          break;
        }
        if (this.queue[i].isAnalysis) hasAnalysis = true;
      }
    }

    // 扫描全部队列是否有分析任务
    if (!hasAnalysis) {
      for (const entry of this.queue) {
        if (entry.isAnalysis) { hasAnalysis = true; break; }
      }
    }

    return { queueLength: this.queue.length, userPosition, hasAnalysis };
  }

  /** 获取队列中每个任务的详情（用于监控面板展示） */
  getQueueEntries(): Array<{ id: string; userId: number; type: string; engine: string; boardSize: number; difficulty: string }> {
    return this.queue.map(e => ({
      id: e.id,
      userId: e.userId,
      type: e.isAnalysis ? 'analysis' : 'genmove',
      engine: e.engine,
      boardSize: e.boardSize,
      difficulty: e.difficulty,
    }));
  }
}

const engineQueue = new EngineQueue();

// ============================================================
// API路由
// ============================================================
export async function POST(request: NextRequest) {
  const reqStart = Date.now();
  try {
    const body = await request.json();
    const { boardSize, moves, difficulty, engine: requestedEngine, aiColor: rawAiColor, action, analysisSeconds: newSeconds } = body;
    const aiColor: 'black' | 'white' = (rawAiColor === 'black' || rawAiColor === 'white') ? rawAiColor : 'white';

    // 内部API调用（AI测试Worker）跳过auth检查
    const internalKey = request.headers.get('X-Internal-Key');
    const isInternal = internalKey === process.env.INTERNAL_API_KEY && !!process.env.INTERNAL_API_KEY;
    const internalUser: JWTPayload | null = isInternal ? { userId: 0, nickname: 'ai-test-worker', isAdmin: true } : null;

    // 配置更新请求：修改引擎配置（支持单引擎/双引擎切换）
    // 时间戳: 2026-04-25 02:50:17
    if (action === 'setConfig') {
      const updates: Record<string, unknown> = {};

      // 更新分析时长（向后兼容）
      if (typeof newSeconds === 'number' && newSeconds >= 0 && newSeconds <= 60) {
        const oldSeconds = analysisSeconds;
        analysisSeconds = newSeconds;
        updates.analysisSeconds = analysisSeconds;
        console.log(`[go-engine] analysisSeconds updated: ${oldSeconds}s → ${analysisSeconds}s`);
      }

      // 辅助函数：验证模型key
      const validateModelKey = (value: string): string | null => {
        const modelKey = getModelKeyFromPath(value) || (MODEL_PATHS[value] ? value : null);
        if (modelKey && MODEL_PATHS[modelKey]) return modelKey;
        return null;
      };

      // === 处理 dualEngine 模式切换 ===
      const newDualEngine = body.dualEngine;
      const isSwitchingToSingle = typeof newDualEngine === 'boolean' && !newDualEngine && engineConfig.dualEngine;
      const isSwitchingToDual = typeof newDualEngine === 'boolean' && newDualEngine && !engineConfig.dualEngine;

      if (isSwitchingToSingle) {
        // 从双引擎切回单引擎：释放分析引擎进程，analysisModel 跟随 gameModel
        const oldAnalysisModel = engineConfig.analysisModel;
        engineConfig.dualEngine = false;
        engineConfig.analysisModel = engineConfig.gameModel;
        updates.dualEngine = false;
        updates.analysisModel = { key: engineConfig.gameModel, name: getModelDisplayName(MODEL_PATHS[engineConfig.gameModel]) };
        console.log(`[go-engine] Switched to single-engine mode (analysis=${oldAnalysisModel} → ${engineConfig.gameModel})`);
        // 异步停止独立的分析引擎进程以释放内存
        if (oldAnalysisModel !== engineConfig.gameModel) {
          getEnginePool().getEngine(oldAnalysisModel).stop().catch((err: Error) => {
            console.warn(`[go-engine] Failed to stop old analysis engine:`, err.message);
          });
        }
      }

      // === 切换对弈引擎模型 ===
      if (typeof body.gameModel === 'string') {
        const gameKey = validateModelKey(body.gameModel);
        if (!gameKey) {
          return NextResponse.json({ error: 'Invalid gameModel', available: Object.keys(MODEL_PATHS) }, { status: 400 });
        }

        // 同步等待对弈引擎启动验证（失败不修改配置）
        try {
          const testEngine = getEnginePool().getEngine(gameKey);
          await testEngine.start();
          engineConfig.gameModel = gameKey;
          updates.gameModel = { key: gameKey, name: getModelDisplayName(MODEL_PATHS[gameKey]) };
          console.log(`[go-engine] Game model updated: ${engineConfig.gameModel}`);
          // 单引擎模式下，analysisModel 同步跟随
          if (!engineConfig.dualEngine) {
            engineConfig.analysisModel = gameKey;
            updates.analysisModel = { key: gameKey, name: getModelDisplayName(MODEL_PATHS[gameKey]) };
          }
        } catch (startErr) {
          const errMsg = startErr instanceof Error ? startErr.message : String(startErr);
          console.error(`[go-engine] Game engine startup failed: ${errMsg}`);
          return NextResponse.json({
            error: `对弈引擎启动失败: ${errMsg}`,
            rollback: true,
            currentConfig: engineConfig,
          }, { status: 500 });
        }
      }

      // === 切换分析引擎模型（仅双引擎模式或切换到双引擎时处理） ===
      if (typeof body.analysisModel === 'string' && body.dualEngine !== false) {
        const analysisKey = validateModelKey(body.analysisModel);
        if (!analysisKey) {
          return NextResponse.json({ error: 'Invalid analysisModel', available: Object.keys(MODEL_PATHS) }, { status: 400 });
        }

        // 如果当前已经是这个分析模型且已在双引擎模式，跳过
        if (engineConfig.dualEngine && engineConfig.analysisModel === analysisKey) {
          console.log(`[go-engine] Analysis model unchanged: ${analysisKey}`);
        } else {
          // 同步等待引擎启动验证（关键：失败不修改配置）
          try {
            const testEngine = getEnginePool().getEngine(analysisKey);
            await testEngine.start();
            // 启动成功，应用配置
            engineConfig.dualEngine = true;
            engineConfig.analysisModel = analysisKey;
            updates.analysisModel = { key: analysisKey, name: getModelDisplayName(MODEL_PATHS[analysisKey]) };
            updates.dualEngine = true;
            console.log(`[go-engine] Analysis model started and updated: ${analysisKey}`);
          } catch (startErr) {
            const errMsg = startErr instanceof Error ? startErr.message : String(startErr);
            console.error(`[go-engine] Analysis engine startup failed: ${errMsg}`);
            return NextResponse.json({
              error: `分析引擎启动失败: ${errMsg}`,
              rollback: true,
              currentConfig: engineConfig,
            }, { status: 500 });
          }
        }
      }

      // 更新对弈引擎 visits
      if (body.gameVisits && typeof body.gameVisits === 'object') {
        const gv = body.gameVisits as Record<string, number>;
        if (typeof gv.easy === 'number') engineConfig.gameVisits.easy = Math.max(1, Math.min(5000, gv.easy));
        if (typeof gv.medium === 'number') engineConfig.gameVisits.medium = Math.max(1, Math.min(5000, gv.medium));
        if (typeof gv.hard === 'number') engineConfig.gameVisits.hard = Math.max(1, Math.min(5000, gv.hard));
        updates.gameVisits = { ...engineConfig.gameVisits };
        console.log(`[go-engine] Game visits updated:`, engineConfig.gameVisits);
      }

      // 更新分析引擎 visits
      if (body.analysisVisits && typeof body.analysisVisits === 'object') {
        const av = body.analysisVisits as Record<string, number>;
        if (typeof av.easy === 'number') engineConfig.analysisVisits.easy = Math.max(1, Math.min(5000, av.easy));
        if (typeof av.medium === 'number') engineConfig.analysisVisits.medium = Math.max(1, Math.min(5000, av.medium));
        if (typeof av.hard === 'number') engineConfig.analysisVisits.hard = Math.max(1, Math.min(5000, av.hard));
        updates.analysisVisits = { ...engineConfig.analysisVisits };
        console.log(`[go-engine] Analysis visits updated:`, engineConfig.analysisVisits);
      }

      // 更新解说调试模式
      if (typeof body.commentaryDebug === 'boolean') {
        setCommentaryDebugShared(body.commentaryDebug);
        engineConfig.commentaryDebug = body.commentaryDebug;
        updates.commentaryDebug = body.commentaryDebug;
        console.log(`[go-engine] Commentary debug mode SAVED: ${body.commentaryDebug}`);
      }

      // 向后兼容：单个 model 字段同时设置两个引擎（过渡期）
      const newModel = body.model;
      if (typeof newModel === 'string') {
        const modelKey = validateModelKey(newModel);
        if (modelKey && MODEL_PATHS[modelKey]) {
          engineConfig.gameModel = modelKey;
          engineConfig.analysisModel = modelKey;
          engineConfig.dualEngine = false;  // 兼容模式默认为单引擎
          updates.legacyModel = { key: modelKey, name: getModelDisplayName(MODEL_PATHS[modelKey]) };
          updates.dualEngine = false;
          console.log(`[go-engine] Both engines set to: ${modelKey} (single-engine mode)`);
          getEnginePool().getEngine(modelKey).start().catch(() => {});
        } else {
          return NextResponse.json({ error: 'Model not found', available: Object.keys(MODEL_PATHS) }, { status: 400 });
        }
      }

      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Invalid config (expected gameModel, analysisModel, gameVisits, analysisVisits, analysisSeconds, dualEngine, or model)' }, { status: 400 });
      }

      return NextResponse.json({ success: true, engineConfig, ...updates });
    }

    // 按需分析请求：提示与教学（消耗20积分）或 解说分析（消耗5积分）
    if (action === 'analyze') {
      const authHeader = request.headers.get('Authorization');
      const user = internalUser || getUserFromAuthHeader(authHeader);
      const isAITest = body.isAITest === true || isInternal;
      const forCommentary = body.forCommentary === true;
      const reqAnalysisSeconds = typeof body.analysisSeconds === 'number' ? body.analysisSeconds : undefined;
      const reqDifficulty = typeof body.difficulty === 'string' ? body.difficulty : undefined;
      const ANALYSIS_COST = forCommentary ? 5 : 10;
      const ANALYSIS_TYPE = forCommentary ? 'commentary' : 'teach';
      const ANALYSIS_DESC = forCommentary ? '解说分析' : '提示与教学';
      console.log(`[go-engine] POST analyze: type=${ANALYSIS_TYPE}, user=${user?.userId || 'unknown'}(${user?.nickname || '?'}), board=${boardSize}, moves=${moves?.length || 0}, isAITest=${isAITest}, difficulty=${reqDifficulty || '-'}, seconds=${reqAnalysisSeconds ?? 'global'}`);
      if (!user || !isKataGoAvailable()) {
        return NextResponse.json({ analysis: null, error: !user ? '请先登录' : 'KataGo不可用' });
      }
      // AI测试模式：跳过积分扣除和队列限制
      if (!isAITest) {
      try {
        const teachSupabase = getSupabaseClient();
        const { data: teachUserData, error: teachUserError } = await teachSupabase
          .from('letsgo_users')
          .select('points')
          .eq('id', user.userId)
          .single();
        if (teachUserError || !teachUserData) {
          return NextResponse.json({ analysis: null, error: '用户信息获取失败' });
        }
        if (teachUserData.points < ANALYSIS_COST) {
          return NextResponse.json({
            analysis: null,
            insufficientPoints: true,
            error: `积分不足（${ANALYSIS_DESC}需要${ANALYSIS_COST}积分，当前${teachUserData.points}积分）`,
            required: ANALYSIS_COST,
            current: teachUserData.points,
          }, { status: 403 });
        }
        // 扣除积分
        const { error: teachUpdateError } = await teachSupabase
          .from('letsgo_users')
          .update({ points: teachUserData.points - ANALYSIS_COST, updated_at: new Date().toISOString() })
          .eq('id', user.userId)
          .gte('points', ANALYSIS_COST);
        if (teachUpdateError) {
          console.error(`[go-engine] ${ANALYSIS_DESC}: Failed to deduct points:`, teachUpdateError);
          return NextResponse.json({ analysis: null, error: '积分扣除失败' }, { status: 500 });
        }
        await teachSupabase.from('letsgo_point_transactions').insert({
          user_id: user.userId,
          amount: -ANALYSIS_COST,
          type: forCommentary ? 'commentary_analyze' : 'teach_use',
          description: ANALYSIS_DESC,
        });
        console.log(`[go-engine] ${ANALYSIS_DESC}: Deducted ${ANALYSIS_COST} points from user ${user.userId}`);
      } catch (pointsErr) {
        console.error(`[go-engine] ${ANALYSIS_DESC} points error:`, pointsErr);
        return NextResponse.json({ analysis: null, error: '积分处理失败' }, { status: 500 });
      }
      } // end non-AI-test logic
      // AI测试模式 或 积分扣除成功后：执行分析（直接调用分析引擎，无队列）
      try {
        const analysisStart = Date.now();
        // 解说分析默认用1秒（较浅），教学默认用全局配置（较深）
        const effectiveSeconds = reqAnalysisSeconds ?? (forCommentary ? 1 : undefined);
        const analysisResult = await getKataGoAnalysis(
          boardSize,
          moves as Array<{row: number, col: number, color: 'black' | 'white'}>,
          effectiveSeconds,
          reqDifficulty
        );
        const analysisElapsed = Date.now() - analysisStart;

        if (!analysisResult) {
          throw new Error('Analysis returned null');
        }

        // 缓存分析结果
        setAnalysisCache(moves as EngineMove[], analysisResult);

        // 分析日志
        const modelName = engineConfig.analysisModel;
        logAiEvent({ type: 'analyze', model: modelName, boardSize, durationMs: analysisElapsed, metadata: { visits: analysisResult.actualVisits, bestMovesCount: analysisResult.bestMoves?.length, forCommentary } });
        return NextResponse.json({
          analysis: analysisResult,
          pointsUsed: isAITest ? 0 : ANALYSIS_COST,
          komi: getKomi(boardSize),
          rules: 'chinese',
          actualVisits: analysisResult.actualVisits,
          modelUsed: modelName,
        });
      } catch (err) {
        console.error('[go-engine] Analysis error:', err);
        logAiEvent({ type: 'engine_error', engine: 'katago', error: err instanceof Error ? err.message : String(err) });
        // 分析失败也退回积分（非AI测试）
        if (!isAITest) {
          try {
            const refundSupabase = getSupabaseClient();
            const { data: refundData } = await refundSupabase.from('letsgo_users').select('points').eq('id', user.userId).single();
            if (refundData) {
              await refundSupabase.from('letsgo_users').update({ points: refundData.points + ANALYSIS_COST }).eq('id', user.userId);
              await refundSupabase.from('letsgo_point_transactions').insert({
                user_id: user.userId, amount: ANALYSIS_COST, type: forCommentary ? 'commentary_refund' : 'teach_refund', description: `${ANALYSIS_DESC}-分析失败退回`
              });
              console.log(`[go-engine] ${ANALYSIS_DESC}: Refunded ${ANALYSIS_COST} points to user ${user.userId} (analysis error)`);
            }
          } catch { /* ignore refund error */ }
        }
        return NextResponse.json({ analysis: null });
      }
    }
    const isAutoRun = body.isAutoRun === true || isInternal;
    const authHeader = request.headers.get('Authorization');
    const user = internalUser || getUserFromAuthHeader(authHeader);

    if (!user) {
      // 未登录用户：仍允许使用本地AI，其他引擎需要登录
      if (requestedEngine === 'local') {
        console.log(`[go-engine] Guest user using local AI`);
        return NextResponse.json({ move: null, engine: "local", noEngine: true });
      }
      return NextResponse.json({ error: '请先登录后再使用AI引擎', needLogin: true }, { status: 401 });
    }

    // 追踪活跃对弈
    trackActiveSession(user.userId, user.nickname, requestedEngine, boardSize, difficulty, moves?.length || 0);
    console.log(`[go-engine] POST genmove: user=${user.userId}(${user.nickname}), engine=${requestedEngine}, board=${boardSize}, diff=${difficulty}, moves=${moves?.length || 0}`);

    // ============================================================
    // GnuGo引擎：直接spawn进程执行
    // （GnuGo每次spawn新进程，天然可并行）
    // ============================================================
    if (requestedEngine === 'gnugo') {
      // GnuGo积分检查和扣除（自动运行模式跳过）
      const gnugoCost = isAutoRun ? 0 : ENGINE_POINT_COSTS.gnugo;
      const gnugoSupabase = getSupabaseClient();
      if (gnugoCost > 0) {
        const { data: gnugoUserData, error: gnugoUserError } = await gnugoSupabase
          .from('letsgo_users')
          .select('points')
          .eq('id', user.userId)
          .single();
        if (gnugoUserError || !gnugoUserData) {
          return NextResponse.json({ error: '用户信息获取失败' }, { status: 500 });
        }
        if (gnugoUserData.points < gnugoCost) {
          return NextResponse.json({
            error: `积分不足（需要${gnugoCost}积分，当前${gnugoUserData.points}积分）`,
            insufficientPoints: true,
            required: gnugoCost,
            current: gnugoUserData.points,
          }, { status: 403 });
        }
        const { error: gnugoUpdateError } = await gnugoSupabase
          .from('letsgo_users')
          .update({ points: gnugoUserData.points - gnugoCost, updated_at: new Date().toISOString() })
          .eq('id', user.userId)
          .gte('points', gnugoCost);
        if (gnugoUpdateError) {
          console.error('[go-engine] GnuGo: Failed to deduct points:', gnugoUpdateError);
          return NextResponse.json({ error: '积分扣除失败' }, { status: 500 });
        }
        await gnugoSupabase.from('letsgo_point_transactions').insert({
          user_id: user.userId,
          amount: -gnugoCost,
          type: 'engine_use',
          description: `gnugo引擎对弈（${difficulty}难度）`,
        });
        console.log(`[go-engine] GnuGo: Deducted ${gnugoCost} points from user ${user.userId}`);
      }
      // 直接执行GnuGo（并行，不阻塞KataGo队列）
      try {
        const gnugoStart = Date.now();
        const gnugoResult = await getGnuGoMove(boardSize, moves, difficulty, aiColor);
        const gnugoElapsed = Date.now() - gnugoStart;
        console.log(`[go-engine] GnuGo完成: user=${user.userId}, move=${gnugoResult.pass ? 'pass' : gnugoResult.move ? `(${gnugoResult.move.row},${gnugoResult.move.col})` : 'null'}, ${gnugoElapsed}ms`);
        // 获取最新积分余额
        let gnugoRemainingPoints: number | undefined;
        if (gnugoCost > 0) {
          const { data: gnugoLatestUser } = await gnugoSupabase
            .from('letsgo_users')
            .select('points')
            .eq('id', user.userId)
            .single();
          gnugoRemainingPoints = gnugoLatestUser?.points;
        }
        return NextResponse.json({
          ...gnugoResult,
          pointsUsed: gnugoCost,
          remainingPoints: gnugoRemainingPoints,
        });
      } catch (gnugoError) {
        console.error(`[go-engine] GnuGo执行失败: user=${user.userId}, ${gnugoError instanceof Error ? gnugoError.message : String(gnugoError)}`);
        return NextResponse.json({
          move: null, engine: "gnugo", engineError: true,
          errorDetail: gnugoError instanceof Error ? gnugoError.message : String(gnugoError),
        });
      }
    }

    // ============================================================
    // KataGo/Local引擎：积分扣除 + 直接调用（双引擎常驻，无需队列）
    // ============================================================
    const cost = isAutoRun ? 0 : getEngineCost(requestedEngine);
    const supabase = getSupabaseClient();
    if (cost > 0) {
      // 读取当前余额
      const { data: userData, error: userError } = await supabase
        .from('letsgo_users')
        .select('points')
        .eq('id', user.userId)
        .single();

      if (userError || !userData) {
        return NextResponse.json({ error: '用户信息获取失败' }, { status: 500 });
      }

      if (userData.points < cost) {
        return NextResponse.json({
          error: `积分不足（需要${cost}积分，当前${userData.points}积分）`,
          insufficientPoints: true,
          required: cost,
          current: userData.points,
        }, { status: 403 });
      }

      // 扣除积分（条件更新：只有余额>=cost时才更新，防止并发超扣）
      const { error: updateError } = await supabase
        .from('letsgo_users')
        .update({ points: userData.points - cost, updated_at: new Date().toISOString() })
        .eq('id', user.userId)
        .gte('points', cost);

      if (updateError) {
        console.error('[go-engine] Failed to deduct points:', updateError);
        return NextResponse.json({ error: '积分扣除失败' }, { status: 500 });
      }

      // 记录积分交易
      await supabase.from('letsgo_point_transactions').insert({
        user_id: user.userId,
        amount: -cost,
        type: 'engine_use',
        description: `${requestedEngine}引擎对弈（${difficulty}难度）`,
      });

      console.log(`[go-engine] Deducted ${cost} points from user ${user.userId} for ${requestedEngine}`);
    }

    // 直接调用引擎（KataGo 双引擎常驻，local 直接返回）
    const callStart = Date.now();
    let result: { move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string; engineError?: boolean; errorDetail?: string; noEngine?: boolean; actualVisits?: number; modelUsed?: string };

    if (requestedEngine === 'katago' && isKataGoAvailable()) {
      try {
        result = await getKataGoMove(boardSize, moves, difficulty, aiColor);
      } catch (katagoError) {
        const errMsg = katagoError instanceof Error ? katagoError.message : String(katagoError);
        console.error(`[go-engine] KataGo direct call failed:`, errMsg);
        result = { move: null, engine: 'katago', engineError: true, errorDetail: errMsg };
      }
    } else if (requestedEngine === 'local') {
      result = { move: null, engine: 'local', noEngine: true };
    } else {
      result = { move: null, engine: requestedEngine || 'local', noEngine: true };
    }

    const callElapsed = Date.now() - callStart;
    console.log(`[go-engine] ${requestedEngine}完成: user=${user.userId}, move=${result.pass ? 'pass' : result.move ? `(${result.move.row},${result.move.col})` : 'null'}, engine=${result.engine}, elapsed=${callElapsed}ms${result.noEngine ? ' [noEngine]' : ''}${result.engineError ? ' [error]' : ''}`);

    // 结构化日志记录
    const modelName = engineConfig.gameModel;
    if (result.engineError || result.noEngine) {
      logAiEvent({ type: 'engine_error', engine: requestedEngine, model: modelName, boardSize, difficulty, error: result.noEngine ? 'noEngine' : 'engineError', durationMs: callElapsed });
    } else {
      logAiEvent({ type: result.pass ? 'pass_bug' : 'genmove', engine: requestedEngine, model: modelName, boardSize, difficulty, coord: result.pass ? 'pass' : result.move ? `${result.move.row},${result.move.col}` : undefined, isPass: result.pass, durationMs: callElapsed });
    }

    // 获取最新积分余额并附加到响应中
    let remainingPoints: number | undefined;
    if (cost > 0) {
      const { data: latestUser } = await supabase
        .from('letsgo_users')
        .select('points')
        .eq('id', user.userId)
        .single();
      remainingPoints = latestUser?.points;
    }

    return NextResponse.json({ ...result, pointsUsed: cost, remainingPoints, komi: getKomi(boardSize), rules: 'chinese' });
  } catch (error) {
    console.error("Go engine API error:", error);
    return NextResponse.json({ error: "引擎错误" }, { status: 500 });
  }
}

// GET端点诊断缓存（避免每次轮询都spawn进程消耗CPU）
let cachedDiagnosis: {
  timestamp: number;
  katagoBinExists: boolean;
  katagoModel: string | null;
  katagoCfgExists: boolean;
  gnugoPath: string | null;
  lddOutput: string;
  katagoTestOutput: string;
} | null = null;
const DIAGNOSIS_TTL = 60000; // 诊断结果缓存60秒

// GET: 返回可用引擎列表（含队列状态）
export async function GET(request: NextRequest) {
  // 队列状态（轻量读取，不消耗CPU）
  const queueLength = engineQueue.getQueueLength();
  const isProcessing = engineQueue.isProcessing();

  // 计算用户的排队位置（通过userId查询参数）
  const userIdParam = request.nextUrl.searchParams.get('userId');
  const userId = userIdParam ? parseInt(userIdParam, 10) : 0;
  const userQueueInfo = engineQueue.getQueuePosition(userId > 0 ? userId : undefined);

  // 诊断信息（缓存，避免每2秒轮询都spawn进程）
  let diag = cachedDiagnosis;
  if (!diag || Date.now() - diag.timestamp > DIAGNOSIS_TTL) {
    const katagoBinExists = fs.existsSync(KATAGO_PATH);
    const katagoModel = findKataGoModel();
    const katagoCfgExists = fs.existsSync(KATAGO_CONFIG);
    const gnugoPath = findGnuGoPath();

    let lddOutput = '';
    let katagoTestOutput = '';
    if (katagoBinExists) {
      try {
        const { execSync } = await import('child_process');
        lddOutput = execSync(`ldd ${KATAGO_PATH}`, { timeout: 5000, encoding: 'utf-8' }).trim();
        katagoTestOutput = execSync(`${KATAGO_PATH} version`, { timeout: 10000, encoding: 'utf-8' }).trim();
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        lddOutput = lddOutput || `ldd failed: ${err.stderr || err.stdout || err.message || String(e)}`;
        katagoTestOutput = katagoTestOutput || `version test failed: ${err.stderr || err.stdout || err.message || String(e)}`;
      }
    }

    console.log(`[go-engine] Diagnosis: katago_bin=${katagoBinExists}, model=${katagoModel}, cfg=${katagoCfgExists}, gnugo=${gnugoPath}, cwd=${process.cwd()}`);
    console.log(`[go-engine] KataGo ldd:\n${lddOutput}`);
    console.log(`[go-engine] KataGo version test:\n${katagoTestOutput}`);

    diag = { timestamp: Date.now(), katagoBinExists, katagoModel, katagoCfgExists, gnugoPath, lddOutput, katagoTestOutput };
    cachedDiagnosis = diag;
  }

  const availableModels = getAvailableModels();
  const gameModelPath = getModelPathFromKey(engineConfig.gameModel);
  const analysisModelPath = getModelPathFromKey(engineConfig.analysisModel);

  return NextResponse.json({
    engines: [
      {
        id: "katago", name: "KataGo", available: isKataGoAvailable(), desc: "深度学习引擎，棋力最强",
        cost: ENGINE_COSTS.katago,
        debug: { binExists: diag.katagoBinExists, model: diag.katagoModel, cfgExists: diag.katagoCfgExists, binPath: KATAGO_PATH, cfgPath: KATAGO_CONFIG, ldd: diag.lddOutput, versionTest: diag.katagoTestOutput },
      },
      {
        id: "gnugo", name: "GnuGo", available: isGnuGoAvailable(), desc: "经典围棋引擎，棋力扎实",
        cost: ENGINE_COSTS.gnugo,
        debug: { path: diag.gnugoPath, searchedPaths: GNUGO_PATHS },
      },
      { id: "local", name: "本地AI", available: true, desc: "内置启发式AI，随时可用", cost: ENGINE_COSTS.local },
    ],
    queueLength,
    isProcessing,
    analysisSeconds,
    userQueuePosition: userQueueInfo.userPosition,
    queue: { length: queueLength, processing: isProcessing },
    availableModels: availableModels.map(m => ({ ...m, displayName: getModelDisplayName(m.path), key: getModelKeyFromPath(m.path) })),
    gameModel: gameModelPath ? { path: gameModelPath, name: getModelDisplayName(gameModelPath), key: engineConfig.gameModel } : null,
    analysisModel: analysisModelPath ? { path: analysisModelPath, name: getModelDisplayName(analysisModelPath), key: engineConfig.analysisModel } : null,
    engineConfig,
  });
}
