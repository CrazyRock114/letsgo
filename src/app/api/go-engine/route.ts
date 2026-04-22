// GTP桥接API - 与KataGo/GnuGo围棋AI引擎通信
// KataGo使用持久化进程（避免每步重新加载模型），GnuGo每次spawn
// 引擎通过GTP(Go Text Protocol)协议交互

import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getUserFromAuthHeader, type JWTPayload } from "@/lib/auth";

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

// 解析kata-raw-nn输出
// 格式: "= whiteWin 0.5432 ... whiteLead 3.5 ... policy D4:0.123 Q16:0.045 ..."
// kata-raw-nn 只需0.04秒，输出标准GTP格式（= ...\n\n），与dispatchResponses完全兼容
function parseKataRawNN(output: string, boardSize: number): KataGoAnalysis | null {
  try {
    const lines = output.trim().split('\n');
    console.log(`[kata-raw-nn] Parsing output, ${lines.length} lines, boardSize=${boardSize}`);
    console.log(`[kata-raw-nn] First 10 lines:`, lines.slice(0, 10).join(' | '));
    
    // Parse whiteWin
    let whiteWin = 0.5;
    const wwLine = lines.find(l => l.trim().startsWith('whiteWin '));
    if (wwLine) {
      whiteWin = parseFloat(wwLine.trim().split(/\s+/)[1]);
    }
    
    // Parse whiteLead
    let whiteLead = 0;
    const wlLine = lines.find(l => l.trim().startsWith('whiteLead '));
    if (wlLine) {
      whiteLead = parseFloat(wlLine.trim().split(/\s+/)[1]);
    }
    
    // Convert to black perspective
    const blackWinRate = (1 - whiteWin) * 100;
    const blackScoreLead = -whiteLead;
    
    // Parse policy grid
    const policyIdx = lines.findIndex(l => l.trim() === 'policy');
    const bestMoves: KataGoAnalysis['bestMoves'] = [];
    
    if (policyIdx !== -1) {
      const policyEntries: { row: number; col: number; prob: number }[] = [];
      
      for (let row = 0; row < boardSize; row++) {
        const lineIdx = policyIdx + 1 + row;
        if (lineIdx >= lines.length) break;
        const values = lines[lineIdx].trim().split(/\s+/);
        for (let col = 0; col < Math.min(values.length, boardSize); col++) {
          const prob = parseFloat(values[col]);
          if (!isNaN(prob) && prob > 0.001) {
            policyEntries.push({ row, col, prob });
          }
        }
      }
      
      // Sort by probability descending, take top 3
      policyEntries.sort((a, b) => b.prob - a.prob);
      const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST';
      
      for (const entry of policyEntries.slice(0, 5)) {
        const move = GTP_LETTERS[entry.col] + (boardSize - entry.row);
        bestMoves.push({
          move,
          winrate: Math.round(blackWinRate * 10) / 10,
          scoreMean: Math.round(blackScoreLead * 10) / 10,
          visits: 0,
        });
      }
    }
    
    console.log(`[kata-raw-nn] Parsed OK: winRate=${Math.round(blackWinRate * 10) / 10}, scoreLead=${Math.round(blackScoreLead * 10) / 10}, bestMoves=${bestMoves.length}`);
    return {
      winRate: Math.round(blackWinRate * 10) / 10,
      scoreLead: Math.round(blackScoreLead * 10) / 10,
      actualVisits: 0,
      bestMoves,
    };
  } catch (e) {
    console.error('[kata-raw-nn] Parse error:', e instanceof Error ? e.message : String(e));
    return null;
  }
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
  if (/lionffen/.test(basename)) return 'Lionffen (小模型, 2MB, 快)';
  if (/rect15-b20c256/.test(basename)) return 'Rect15-B20C256 (中模型, 22MB)';
  if (/b20c256/.test(basename)) return 'B20C256 (中模型)';
  if (/b18c384/.test(basename)) return 'B18C384 (大模型)';
  if (/b40c256/.test(basename)) return 'B40C256 (超大模型)';
  return basename;
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

function setAnalysisCache(moves: Array<{row: number; col: number; color: string}>, data: KataGoAnalysis): void {
  const cacheKey = moves.map(m => `${m.color[0]}${m.row},${m.col}`).join('|');
  pruneAnalysisCache();
  analysisCache.set(cacheKey, { data, timestamp: Date.now() });
}

// 导出查询分析缓存的方法（供go-ai使用）
export function getCachedAnalysis(moves: Array<{row: number; col: number; color: string}>): KataGoAnalysis | null {
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
  const currentModel = persistentKataGo.getCurrentModel();
  return {
    kataGo: {
      queueLength: engineQueue.getQueueLength(),
      processing: engineQueue.isProcessing(),
      currentTask: currentInfo ? { id: currentInfo.id, userId: currentInfo.userId, isAnalysis: currentInfo.isAnalysis, engine: currentInfo.engine } : null,
      analysisSeconds,  // 当前分析配置
      queueEntries: engineQueue.getQueueEntries(),  // 队列中每个任务的详情
      currentModel: currentModel ? { path: currentModel, name: getModelDisplayName(currentModel) } : null,
      availableModels: available.map(m => ({ ...m, displayName: getModelDisplayName(m.path) })),
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

  // 优先级顺序：lionffen(小,快,支持所有棋盘) > g170-b6c96 > rect15(通用,大) > 其他
  const priorityPatterns = [
    /lionffen/,           // lionffen小模型(2MB)，实测支持所有棋盘
    /g170-b6c96/,         // 小模型(3.7MB)，支持所有棋盘
    /b6c96/,              // 通用小模型
    /rect15/,             // rect15通用模型(87MB)，支持所有棋盘
    /b18c384nbt-human/,   // Human SL模型
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
  return fs.existsSync(KATAGO_PATH) && findKataGoModel() !== null && fs.existsSync(KATAGO_CONFIG);
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
function getKomi(boardSize: number): number {
  return boardSize <= 9 ? 2.5 : boardSize <= 13 ? 3.5 : 6.5;
}

// KataGo难度映射 - 通过maxVisits控制
function getKataGoVisits(difficulty: string): number {
  if (difficulty === "easy") return 300;
  if (difficulty === "medium") return 1500;
  return 5000;
}

// GnuGo难度映射
function getGnuGoLevel(difficulty: string): number {
  if (difficulty === "easy") return 3;
  if (difficulty === "medium") return 7;
  return 10;
}

// ============================================================
// 持久化KataGo进程管理器
// 核心思路：进程启动后保持运行，每次落子只发送GTP命令，不再重新加载模型
// ============================================================
class PersistentKataGo {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private starting: Promise<void> | null = null;
  private commandQueue: Array<{
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private crashed = false;
  private lastError = "";
  private procEpoch = 0;  // 进程纪元，用于区分新旧进程
  private currentModel: string | null = null;

  isAvailable(): boolean {
    return !!(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  getProcess(): ChildProcess | null {
    return this.proc;
  }

  getCurrentModel(): string | null {
    return this.currentModel;
  }

  // 切换KataGo模型：杀掉当前进程，用新模型重启
  async switchModel(modelPath: string): Promise<void> {
    if (this.currentModel === modelPath && this.isAvailable()) {
      console.log(`[KataGo] Model already active: ${modelPath}`);
      return;
    }
    console.log(`[KataGo] Switching model: ${this.currentModel ?? 'auto'} -> ${modelPath}`);
    this.killProcess();
    this.currentModel = modelPath;
    // 进程会在下一次 ensureReady 时自动用新模型启动
    await this.ensureReady();
    console.log(`[KataGo] Model switched successfully: ${modelPath}`);
  }

  // 确保进程已启动并就绪
  async ensureReady(): Promise<void> {
    // 进程存活则直接返回
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;

    // 正在启动则等待
    if (this.starting) return this.starting;

    // 开始启动
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startProcess(): Promise<void> {
    const model = findKataGoModel();
    if (!model) throw new Error("KataGo model not found");
    if (!fs.existsSync(KATAGO_PATH)) throw new Error("KataGo binary not found");
    if (!fs.existsSync(KATAGO_CONFIG)) throw new Error("KataGo config not found");

    this.currentModel = model;
    console.log(`[KataGo] Starting persistent process with model: ${model}`);

    // Kill any old process
    this.killProcess();
    this.procEpoch++;  // 递增纪元，旧进程的onData会被忽略

    this.proc = spawn(KATAGO_PATH, [
      "gtp",
      "-model", model,
      "-config", KATAGO_CONFIG,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.buffer = "";
    this.crashed = false;
    this.lastError = "";
    const currentEpoch = this.procEpoch;  // 闭包捕获当前纪元

    // 持续收集stdout数据，按\n\n分割响应并分发到等待的Promise
    // 只处理与当前纪元匹配的进程数据
    this.proc.stdout?.on("data", (data: Buffer) => {
      if (this.procEpoch !== currentEpoch) return;  // 旧进程数据，忽略
      this.buffer += data.toString();
      this.dispatchResponses();
    });

    // 收集stderr用于错误诊断
    this.proc.stderr?.on("data", (data: Buffer) => {
      if (this.procEpoch !== currentEpoch) return;
      const text = data.toString().trim();
      if (text) this.lastError = text;
    });

    // 进程退出处理
    this.proc.on("exit", (code) => {
      console.log(`[KataGo] Process exited with code ${code}, epoch=${currentEpoch}`);
      // 只有当前纪元的进程退出才清理
      if (this.procEpoch === currentEpoch) {
        this.proc = null;
        this.buffer = "";
        // 拒绝所有等待中的命令
        for (const item of this.commandQueue) {
        clearTimeout(item.timeout);
        item.reject(new Error(`KataGo process exited (code=${code}): ${this.lastError}`));
      }
      this.commandQueue = [];
        if (code !== 0) this.crashed = true;
      }  // end if procEpoch === currentEpoch
    });

    // 等待进程就绪：发送name命令，成功则表示GTP握手完成
    // 首次启动需要加载模型，可能较慢（大模型需要30秒+）
    try {
      const nameResp = await this.sendCommand("name", 120000);
      console.log(`[KataGo] Process ready: ${nameResp}`);
    } catch (err) {
      this.killProcess();
      throw new Error(`KataGo startup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 从buffer中提取完整的GTP响应并分发到等待的Promise
  // GTP协议：响应以"= "或"? "开头，以"\n\n"结束
  // kata-analyze特殊：多行info后跟"= "行，整体以"\n\n"结束
  private dispatchResponses(): void {
    while (this.commandQueue.length > 0) {
      const endIdx = this.buffer.indexOf("\n\n");
      if (endIdx === -1) break;

      const response = this.buffer.substring(0, endIdx).trim();
      this.buffer = this.buffer.substring(endIdx + 2);

      const item = this.commandQueue.shift()!;
      clearTimeout(item.timeout);
      item.resolve(response);
    }
  }

  // 发送单条GTP命令并等待响应
  async sendCommand(command: string, timeoutMs: number = 30000): Promise<string> {
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error("KataGo process not available"));
        return;
      }

      const timeout = setTimeout(() => {
        const idx = this.commandQueue.findIndex(i => i.resolve === resolve);
        if (idx !== -1) this.commandQueue.splice(idx, 1);
        reject(new Error(`GTP command timeout: ${command}`));
      }, timeoutMs);

      this.commandQueue.push({ resolve, reject, timeout });
      try {
        this.proc.stdin?.write(command + "\n");
      } catch (writeErr) {
        // 进程已退出，stdin 写入会 EPIPE，清理超时并拒绝
        clearTimeout(timeout);
        const idx = this.commandQueue.findIndex(i => i.resolve === resolve);
        if (idx !== -1) this.commandQueue.splice(idx, 1);
        reject(new Error(`KataGo stdin write failed (process may have exited): ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`));
      }
    });
  }

  // 批量发送GTP命令
  async sendCommands(commands: string[], timeoutMs: number = 30000): Promise<string[]> {
    const results: string[] = [];
    for (const cmd of commands) {
      const resp = await this.sendCommand(cmd, timeoutMs);
      if (resp.trim().startsWith('?')) {
        throw new Error(`GTP command failed: ${cmd} -> ${resp.trim()}`);
      }
      results.push(resp);
    }
    return results;
  }

  // 进程是否曾经崩溃
  hasCrashed(): boolean {
    return this.crashed;
  }

  // 杀掉进程
  private killProcess(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin?.write("quit\n");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try { this.proc?.kill(); } catch { /* ignore */ }
      }, 500);
    }
    this.procEpoch++;  // 递增纪元，旧进程的onData会被忽略
    this.proc = null;
    this.buffer = "";
    this.commandQueue = [];
  }

  /** 中断正在进行的KataGo分析（发送GTP stop命令，不杀进程） */
  async stopAnalysis(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    console.log(`[KataGo] stopAnalysis - sending GTP stop to interrupt analysis`);
    try {
      // 拒绝所有等待中的命令（分析命令的回调会被reject）
      for (const item of this.commandQueue) {
        clearTimeout(item.timeout);
        item.reject(new Error("KataGo analysis interrupted for genmove priority"));
      }
      this.commandQueue = [];
      this.buffer = "";
      
      // 发送GTP stop命令（优雅中断kata-analyze，进程不重启）
      // stop会让kata-analyze立即返回当前分析结果，进程回到空闲状态
      this.proc.stdin?.write('stop\n');
      
      // 彻底清理残留数据，防止影响下一个任务
      await this.thoroughFlush();
    } catch (e) {
      console.log(`[KataGo] stopAnalysis error:`, e);
    }
  }

  // 完全关闭（进程退出时调用）
  /** 清除buffer中可能残留的旧数据 */
  clearBuffer(): void {
    this.buffer = "";
  }

  /** 轻量级清理（仅清buffer，不发送同步命令，用于processNext预处理） */
  async throughFlushLite(): Promise<void> {
    this.buffer = "";
    await new Promise(resolve => setTimeout(resolve, 50));
    this.buffer = "";
  }

  // 彻底清理：清空buffer+commandQueue，发送轻量命令同步进程状态
  async thoroughFlush(): Promise<void> {
    this.commandQueue = [];
    this.buffer = "";
    // 等待KataGo进程输出所有残留数据（stop后的分析结果等）
    await new Promise(resolve => setTimeout(resolve, 500));
    this.buffer = "";
    
    // 用sendCommand发送轻量命令同步：收到响应说明进程已回到空闲状态
    // 使用正常的onData handler（已在startProcess中注册），不需要额外handler
    try {
      if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
        await this.sendCommand("name", 5000);
      }
    } catch {
      // 同步失败不报错，下一个ensureReady会处理
    }
    this.buffer = "";
  }

  shutdown(): void {
    this.killProcess();
  }

  resetCrashState(): void {
    this.killProcess();
  }
}

// 模块级单例 - Node.js进程内共享
const persistentKataGo = new PersistentKataGo();

// 预热KataGo进程：服务启动时后台加载模型，避免首个请求冷启动
export async function warmupKataGo(): Promise<void> {
  try {
    if (!isKataGoAvailable()) {
      console.log('[warmup] KataGo not available (binary/model/config missing), skipping warmup');
      return;
    }
    console.log('[warmup] Starting KataGo warmup...');
    const start = Date.now();
    await persistentKataGo.ensureReady();
    console.log(`[warmup] KataGo ready in ${Date.now() - start}ms`);
  } catch (err) {
    console.warn('[warmup] KataGo warmup failed:', err instanceof Error ? err.message : String(err));
  }
}

// ============================================================
// KataGo落子（使用持久化进程）
// ============================================================
async function getKataGoMove(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: string }>,
  difficulty: string,
  aiColor: 'black' | 'white' = 'white'
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string; engineError?: boolean }> {
  const komi = getKomi(boardSize);
  const maxVisits = getKataGoVisits(difficulty);

  // 构建GTP命令序列：重置棋盘 → 重放落子 → 生成AI落子
  const gtpCommands: string[] = [
    `boardsize ${boardSize}`,
    "clear_board",
    `komi ${komi}`,
    `kata-set-param maxVisits ${maxVisits}`,  // 动态调整难度
  ];

  // 重放所有落子历史
  if (moves && Array.isArray(moves)) {
    for (const move of moves) {
      const color = move.color === "black" ? "B" : "W";
      const coord = boardToGTPCoord(move.row, move.col, boardSize);
      gtpCommands.push(`play ${color} ${coord}`);
    }
  }

  // 请求AI落子
  gtpCommands.push(`genmove ${aiColor === 'black' ? 'B' : 'W'}`);

  // 彻底清理残留数据（stop命令后可能有残余输出，等待并消耗干净）
  await persistentKataGo.thoroughFlush();
  
  // 发送命令，单条超时60秒（CPU竞争时可能较慢）
  const responses = await persistentKataGo.sendCommands(gtpCommands, 60000);

  // 解析genmove响应
  const lastResponse = responses[responses.length - 1];
  const moveMatch = lastResponse.match(/=\s*([A-HJ-T]\d+|PASS|resign)/i);

  if (!moveMatch) {
    console.warn(`[KataGo] Unexpected genmove response: "${lastResponse}"`);
    return { move: null, pass: false, engineError: true, engine: "katago" };
  }

  const moveStr = moveMatch[1].toUpperCase();

  if (moveStr === "PASS") {
    return { move: null, pass: true, engine: "katago" };
  }

  if (moveStr === "RESIGN") {
    return { move: null, resign: true, engine: "katago" };
  }

  const position = gtpToBoardCoord(moveStr, boardSize);

  if (!position) {
    throw new Error("无法解析KataGo落子坐标");
  }

  return { move: position, engine: "katago" };
}

// ============================================================
// KataGo分析（支持两种模式）
// analysisSeconds=0: kata-raw-nn（0.04秒，纯神经网络直出）
// analysisSeconds>0: kata-analyze（MCTS搜索N秒后用GTP stop中断）
// ============================================================
async function getKataGoAnalysis(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: "black" | "white" }>,
  overrideSeconds?: number
): Promise<KataGoAnalysis | null> {
  const seconds = overrideSeconds !== undefined ? overrideSeconds : analysisSeconds;
  try {
    await persistentKataGo.ensureReady();
  } catch {
    console.log('[kata-analysis] KataGo进程未就绪，跳过分析');
    return null;
  }

  // 彻底清理残留数据（前一个任务完成后buffer中可能有残余输出）
  await persistentKataGo.thoroughFlush();

  try {
    // 准备棋盘（boardsize + clear_board + komi + 重放所有落子）
    const setupCommands = [
      `boardsize ${boardSize}`,
      'clear_board',
      `komi ${getKomi(boardSize)}`,
    ];
    for (const m of moves) {
      const colChar = String.fromCharCode(65 + (m.col >= 8 ? m.col + 1 : m.col));
      const coord = `${colChar}${boardSize - m.row}`;
      const color = m.color === "black" ? "B" : "W";
      setupCommands.push(`play ${color} ${coord}`);
    }
    console.log(`[kata-analysis] 准备棋盘: ${moves.length}步, boardSize=${boardSize}, mode=${seconds === 0 ? 'raw-nn' : `analyze(${seconds}s)`}`);
    const setupResponses = await persistentKataGo.sendCommands(setupCommands, 30000);
    const failedSetup = setupResponses.filter((r: string) => r.trim().startsWith('?'));
    if (failedSetup.length > 0) {
      console.error('[kata-analysis] Setup commands failed:', failedSetup);
    }
    // 调试用：打印当前棋盘状态
    try {
      const boardState = await persistentKataGo.sendCommand('showboard', 5000);
      console.log('[kata-analysis] showboard:\n', boardState);
    } catch (e) {
      console.log('[kata-analysis] showboard failed:', e instanceof Error ? e.message : String(e));
    }

    if (seconds === 0) {
      // 模式1: kata-raw-nn all（0.04秒完成，输出标准GTP格式=\n\n）
      // 直接输出神经网络策略，不走MCTS搜索树，极速
      const analyzeResponse = await persistentKataGo.sendCommand('kata-raw-nn all', 10000);
      return parseKataRawNN(analyzeResponse, boardSize);
    } else {
      // 模式2: kata-analyze + GTP stop（定时中断方式）
      // 关键发现：kata-analyze无视maxVisits/maxTime/maxPlayouts，会无限搜索
      // 唯一控制方式：发送GTP stop命令中断，获取当前分析结果
      // seconds直接控制搜索时长（秒）
      const durationMs = seconds * 1000;
      console.log(`[kata-analyze] 开始分析, ${seconds}秒后stop`);

      // 发送kata-analyze命令（超时设长，实际由stop控制终止）
      const analyzePromise = persistentKataGo.sendCommand('kata-analyze 1', durationMs + 30000);

      // 定时发送stop中断分析
      const stopTimer = setTimeout(() => {
        try {
          const proc = persistentKataGo.getProcess();
          if (proc && !proc.killed && proc.stdin?.writable) {
            proc.stdin.write('stop\n');
            console.log(`[kata-analyze] 已发送stop（${seconds}秒后）`);
          }
        } catch (e) {
          console.log('[kata-analyze] 发送stop失败:', e);
        }
      }, durationMs);

      try {
        const analyzeResponse = await analyzePromise;
        clearTimeout(stopTimer);

        const isWhiteToMove = moves.length % 2 === 1;
        return parseKataAnalyze(analyzeResponse, boardSize, isWhiteToMove);
      } catch (err: unknown) {
        clearTimeout(stopTimer);
        throw err;
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('interrupted')) {
      console.log('[kata-analysis] 分析被中断（同一用户落子优先）');
    } else {
      console.error('[kata-analysis] 分析失败:', err);
    }
    return null;
  }
}

// 解析kata-analyze输出（stop后的完整响应）
// 格式: 多轮info行 + "= \n\n"结束
// 每行: "info move D4 visits 50 winrate 0.52 scoreMean 3.5 scoreStdev 1.2 prior 0.08 order 0 pv D4 Q16 C3 ..."
// kata-analyze会持续输出中间结果，每轮info行代表一个搜索深度
// 同一move会出现多次（不同visits），取最后一次（visits最高）
// winrate范围: 0-1，从"side-to-move"（当前行棋方）视角
//   - 黑方行棋时: winrate=黑方胜率（0=黑必输, 1=黑必赢）
//   - 白方行棋时: winrate=白方胜率（0=白必输, 1=白必赢）→ 需反转为黑方胜率
// scoreMean/scoreLead: 始终是黑方视角（正值=黑方领先），无需转换
function parseKataAnalyze(output: string, boardSize: number, isWhiteToMove: boolean = false): KataGoAnalysis | null {
  try {
    // 提取所有info行（以"info move"开头）
    const lines = output.split('\n');
    const infoLines = lines.filter(l => l.trim().startsWith('info move'));
    
    if (infoLines.length === 0) {
      console.log('[kata-analyze] 无info行，原始输出:', output.substring(0, 200));
      return null;
    }

    // kata-analyze每轮搜索都输出所有候选手的info行
    // 同一move会出现多次，后面的visits更高，取最后一次
    const latestMoveInfo = new Map<string, { winrate: number; scoreMean: number; visits: number }>();
    let globalWinRate = 0;
    let globalScoreLead = 0;
    let topMoveVisits = 0;

    for (const line of infoLines) {
      const parts = line.trim().split(/\s+/);
      const moveIdx = parts.indexOf('move') + 1;
      const winrateIdx = parts.indexOf('winrate') + 1;
      const scoreIdx = parts.indexOf('scoreMean') + 1;
      const scoreLeadIdx = parts.indexOf('scoreLead') + 1;
      const visitsIdx = parts.indexOf('visits') + 1;

      if (moveIdx === 0 || !parts[moveIdx]) continue;

      const moveStr = parts[moveIdx];
      const winrate = winrateIdx > 0 ? parseFloat(parts[winrateIdx]) : 0;
      // KataGo不同版本可能用scoreMean或scoreLead
      const scoreValue = scoreLeadIdx > 0 ? parseFloat(parts[scoreLeadIdx]) : (scoreIdx > 0 ? parseFloat(parts[scoreIdx]) : 0);
      const visits = visitsIdx > 0 ? parseInt(parts[visitsIdx]) : 0;

      // 保留每个move的最新数据（后出现的visits更高）
      latestMoveInfo.set(moveStr, { winrate, scoreMean: scoreValue, visits });

      // 全局胜率/目数取最后一条info行（搜索最深的）
      globalWinRate = winrate;
      globalScoreLead = scoreValue;
      topMoveVisits = visits; // 最后一条info的visits就是搜索最深的
    }
    // 诊断：打印第一条info行，看score字段名和值
    if (infoLines.length > 0) {
      const firstLine = infoLines[0];
      const hasScoreMean = firstLine.includes('scoreMean');
      const hasScoreLead = firstLine.includes('scoreLead');
      console.log(`[kata-analyze] 首条info行字段: scoreMean=${hasScoreMean}, scoreLead=${hasScoreLead}, sample=${firstLine.substring(0, 120)}`);
      console.log(`[kata-analyze] 解析结果: globalWinRate=${globalWinRate}, globalScoreLead=${globalScoreLead}, topMoveVisits=${topMoveVisits}`);
    }

    // 按visits降序排列，pass排到最后，取前3个推荐落点
    const sortedMoves = [...latestMoveInfo.entries()]
      .sort((a, b) => {
        // pass排到最后
        if (a[0] === 'pass') return 1;
        if (b[0] === 'pass') return -1;
        return b[1].visits - a[1].visits;
      });

    const bestMoves: KataGoAnalysis['bestMoves'] = sortedMoves.slice(0, 5).map(([move, data]) => {
      // bestMoves的winrate也是side-to-move视角，白方行棋时需反转
      const rawWinrate = isWhiteToMove ? (1 - data.winrate) : data.winrate;
      return {
        move,
        winrate: Math.round(rawWinrate * 1000) / 10, // 0-1 → 0-100（黑方胜率）
        scoreMean: Math.round(data.scoreMean * 10) / 10, // 黑方视角
        visits: data.visits,
      };
    });

    // winrate: KataGo输出0-1范围，从"side-to-move"视角
    // 白方行棋时需反转为黑方胜率，与parseKataRawNN保持一致
    const rawGlobalWinRate = isWhiteToMove ? (1 - globalWinRate) : globalWinRate;
    const blackWinRate = Math.round(rawGlobalWinRate * 1000) / 10;

    // scoreLead: scoreMean/scoreLead为黑方视角（正值=黑方领先）
    // 注意：KataGo在搜索量极少时可能输出0，这是KataGo的行为，不做假估算
    const blackScoreLead = Math.round(globalScoreLead * 10) / 10;

    return {
      winRate: blackWinRate,
      scoreLead: blackScoreLead,
      actualVisits: topMoveVisits,
      bestMoves,
    };
  } catch {
    console.error('[kata-analyze] 解析异常');
    return null;
  }
}

// ============================================================
// GnuGo落子（每次spawn新进程，GnuGo启动快）
// ============================================================
async function getGnuGoMove(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: string }>,
  difficulty: string,
  aiColor: 'black' | 'white' = 'white'
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engineError?: boolean; engine: string }> {
  const komi = getKomi(boardSize);
  const gnugoLevel = getGnuGoLevel(difficulty);

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
      const coord = boardToGTPCoord(move.row, move.col, boardSize);
      gtpCommands.push(`play ${color} ${coord}`);
    }
  }

  gtpCommands.push(`genmove ${aiColor === 'black' ? 'B' : 'W'}`);

  // GnuGo用一次性命令发送方式
  try {
    const results: string[] = [];
    for (const cmd of gtpCommands) {
      const resp = await sendOneShotGTP(proc, cmd, 30000);
      results.push(resp);
    }

    const lastResponse = results[results.length - 1];
    const moveMatch = lastResponse.match(/=\s*([A-HJ-T]\d+|PASS|resign)/i);

    if (!moveMatch) {
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, pass: false, engineError: true, engine: "gnugo" };
    }

    const moveStr = moveMatch[1].toUpperCase();

    if (moveStr === "PASS") {
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, pass: true, engine: "gnugo" };
    }

    if (moveStr === "RESIGN") {
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, resign: true, engine: "gnugo" };
    }

    const position = gtpToBoardCoord(moveStr, boardSize);
    proc.stdin?.write("quit\n");
    proc.kill();

    if (!position) {
      throw new Error("无法解析GnuGo落子坐标");
    }

    return { move: position, engine: "gnugo" };
  } catch (gtpError) {
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
      if (output.includes("\n\n") && !settled) {
        settled = true;
        cleanup();
        resolve(output.trim());
      }
    };

    proc.stdout?.on("data", onData);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`GTP command timeout: ${command}`));
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
  moves: Array<{ row: number; col: number; color: string }>;
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
    moves: Array<{ row: number; col: number; color: string }>,
    difficulty: string,
    aiColor: 'black' | 'white' = 'white',

  ): Promise<EngineQueueResult> {
    const id = `qe-${++this.entryId}-u${userId}`;
    console.log(`[engine-queue] Enqueued: ${id}, engine=${engine}, aiColor=${aiColor}, queueLen=${this.queue.length}`);

    // 下棋请求优先：取消该用户排队中的分析请求
    this.cancelPendingAnalysis(userId);

    // 只有同一用户的genmove可以中断自己的分析（用户隔离原则）
    // 其他用户的genmove需要等待分析完成，按队列排队
    if (this.processing && this.currentEntry?.isAnalysis && this.currentEntry.userId === userId) {
      console.log(`[engine-queue] Genmove arrived while own analysis is running - sending stop`);
      await persistentKataGo.stopAnalysis();
      // stopAnalysis会拒绝当前分析的command，导致processNext结束
      const waitStart = Date.now();
      while (this.processing && Date.now() - waitStart < 5000) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (this.processing) {
        console.warn(`[engine-queue] Analysis still processing after stop, forcing processing=false`);
        this.processing = false;
      }
    }

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
      // 每次处理前先彻底清理 KataGo 进程 buffer 残留，避免响应错位
      if (entry.engine === "katago" && isKataGoAvailable()) {
        await persistentKataGo.throughFlushLite();
      }
      // 分析请求：只使用KataGo，不影响下棋结果
      if (entry.isAnalysis) {
        let analysisResult: KataGoAnalysis | null = null;
        if (isKataGoAvailable()) {
          try {
            const entrySeconds = entry.analysisSeconds !== undefined ? entry.analysisSeconds : analysisSeconds;
            // 安全超时：analysisSeconds秒 + 30s缓冲（防止getKataGoAnalysis内部stop失败时无限等待）
            const analysisTimeout = (entrySeconds || 0) * 1000 + 30000;
            let queueTimeoutId: ReturnType<typeof setTimeout> | null = null;

            // 队列溢出监控：analysis期间每2秒检查队列，>8则提前中断
            const ANALYSIS_INTERRUPT_THRESHOLD = 8;
            let interruptCheckInterval: ReturnType<typeof setInterval> | null = null;
            let interruptedByQueue = false;
            if (entrySeconds && entrySeconds > 0) {
              interruptCheckInterval = setInterval(() => {
                const qLen = this.queue.length;
                if (qLen > ANALYSIS_INTERRUPT_THRESHOLD) {
                  console.warn(`[engine-queue] Analysis interrupted: 队列过长(${qLen} > ${ANALYSIS_INTERRUPT_THRESHOLD}), 中断analysis ${entry.id}`);
                  interruptedByQueue = true;
                  try {
                    const proc = persistentKataGo.getProcess();
                    if (proc && !proc.killed && proc.stdin?.writable) {
                      proc.stdin.write('stop\n');
                      console.log(`[engine-queue] 已发送stop中断analysis（队列溢出保护）`);
                    }
                  } catch (e) {
                    console.log('[engine-queue] 发送interrupt stop失败:', e);
                  }
                  if (interruptCheckInterval) clearInterval(interruptCheckInterval);
                }
              }, 2000);
            }

            analysisResult = await Promise.race([
              getKataGoAnalysis(entry.boardSize, entry.moves as Array<{row: number; col: number; color: 'black' | 'white'}>, entrySeconds),
              new Promise<null>(resolve => {
                queueTimeoutId = setTimeout(() => {
                  console.warn(`[engine-queue] Analysis safety timeout (${Math.round(analysisTimeout/1000)}s) for ${entry.id}`);
                  persistentKataGo.stopAnalysis();
                  resolve(null);
                }, analysisTimeout);
              }),
            ]);
            // 关键：分析完成后立即清除队列超时计时器和中断检查，防止双重stop
            if (queueTimeoutId !== null) clearTimeout(queueTimeoutId);
            if (interruptCheckInterval !== null) clearInterval(interruptCheckInterval);
            if (interruptedByQueue) {
              console.log(`[engine-queue] Analysis ${entry.id} was interrupted by queue overflow, partial results used`);
            }
          } catch (err) {
            console.warn(`[engine-queue] Analysis failed:`, err instanceof Error ? err.message : String(err));
            persistentKataGo.resetCrashState();
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
          try {
            const moveResult = await getKataGoMove(entry.boardSize, entry.moves, entry.difficulty, entry.aiColor);
            result = { ...moveResult };
          } catch (katagoError) {
            persistentKataGo.resetCrashState();
            result = {
              move: null, engine: "katago", engineError: true,
              errorDetail: katagoError instanceof Error ? katagoError.message : String(katagoError),
            };
          }
        } else if (entry.engine === "gnugo" && isGnuGoAvailable()) {
          try {
            const moveResult = await getGnuGoMove(entry.boardSize, entry.moves, entry.difficulty, entry.aiColor);
            result = { ...moveResult };
          } catch (gtpError) {
            result = {
              move: null, engine: "gnugo", engineError: true,
              errorDetail: gtpError instanceof Error ? gtpError.message : String(gtpError),
            };
          }
        } else {
          result = { move: null, engine: entry.engine || "local", noEngine: true };
        }

        console.log(`[engine-queue] Completed: ${entry.id}, engine=${result.engine}`);
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
  async enqueueAnalysis(userId: number, moves: Array<{row: number, col: number, color: "black" | "white"}>, boardSize: number, isAITest = false, analysisSeconds?: number): Promise<{ analysis: KataGoAnalysis | null; queueBusy?: boolean; queueLength?: number }> {
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

    // 配置更新请求：修改分析时长（秒）
    if (action === 'setConfig') {
      const updates: Record<string, unknown> = {};

      // 更新分析时长
      if (typeof newSeconds === 'number' && newSeconds >= 0 && newSeconds <= 60) {
        const oldSeconds = analysisSeconds;
        analysisSeconds = newSeconds;
        updates.analysisSeconds = analysisSeconds;
        console.log(`[go-engine] analysisSeconds updated: ${oldSeconds}s → ${analysisSeconds}s`);
      }

      // 切换KataGo模型
      const newModel = body.model;
      if (typeof newModel === 'string') {
        const available = getAvailableModels();
        const modelEntry = available.find(m => m.path === newModel);
        if (modelEntry) {
          currentModelPath = newModel;
          await persistentKataGo.switchModel(newModel);
          updates.currentModel = { path: newModel, name: getModelDisplayName(newModel) };
          console.log(`[go-engine] Model switched to: ${getModelDisplayName(newModel)}`);
        } else {
          return NextResponse.json({ error: 'Model not found', available: available.map(m => ({ path: m.path, name: getModelDisplayName(m.path) })) }, { status: 400 });
        }
      }

      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Invalid config (expected analysisSeconds or model)' }, { status: 400 });
      }

      return NextResponse.json({ success: true, ...updates });
    }

    // 按需分析请求：仅当用户点击"提示与教学"时触发（消耗20积分）
    if (action === 'analyze') {
      const authHeader = request.headers.get('Authorization');
      const user = internalUser || getUserFromAuthHeader(authHeader);
      const isAITest = body.isAITest === true || isInternal;
      const reqAnalysisSeconds = typeof body.analysisSeconds === 'number' ? body.analysisSeconds : undefined;
      console.log(`[go-engine] POST analyze: user=${user?.userId || 'unknown'}(${user?.nickname || '?'}), board=${boardSize}, moves=${moves?.length || 0}, queue=${engineQueue.getQueueLength()}, isAITest=${isAITest}, seconds=${reqAnalysisSeconds ?? 'global'}`);
      if (!user || !isKataGoAvailable()) {
        return NextResponse.json({ analysis: null, error: !user ? '请先登录' : 'KataGo不可用' });
      }
      // 提示与教学积分消耗：20积分
      const TEACH_COST = 20;
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
        if (teachUserData.points < TEACH_COST) {
          return NextResponse.json({ 
            analysis: null, 
            insufficientPoints: true,
            error: `积分不足（提示与教学需要${TEACH_COST}积分，当前${teachUserData.points}积分）`,
            required: TEACH_COST,
            current: teachUserData.points,
          }, { status: 403 });
        }
        // 扣除积分
        const { error: teachUpdateError } = await teachSupabase
          .from('letsgo_users')
          .update({ points: teachUserData.points - TEACH_COST, updated_at: new Date().toISOString() })
          .eq('id', user.userId)
          .gte('points', TEACH_COST);
        if (teachUpdateError) {
          console.error('[go-engine] Teach: Failed to deduct points:', teachUpdateError);
          return NextResponse.json({ analysis: null, error: '积分扣除失败' }, { status: 500 });
        }
        await teachSupabase.from('letsgo_point_transactions').insert({
          user_id: user.userId,
          amount: -TEACH_COST,
          type: 'teach_use',
          description: '提示与教学',
        });
        console.log(`[go-engine] Teach: Deducted ${TEACH_COST} points from user ${user.userId}`);
      } catch (pointsErr) {
        console.error('[go-engine] Teach points error:', pointsErr);
        return NextResponse.json({ analysis: null, error: '积分处理失败' }, { status: 500 });
      }
      } // end non-AI-test teach logic
      // AI测试模式 或 积分扣除成功后：执行分析
      try {
        const result = await engineQueue.enqueueAnalysis(
          user.userId,
          moves as Array<{row: number, col: number, color: 'black' | 'white'}>,
          boardSize,
          isAITest, // AI测试模式不受队列限制
          reqAnalysisSeconds
        );
        if (result.queueBusy) {
          // 队列繁忙时退回积分（非AI测试）
          if (!isAITest) {
            try {
              const refundSupabase = getSupabaseClient();
              const { data: refundData } = await refundSupabase.from('letsgo_users').select('points').eq('id', user.userId).single();
              if (refundData) {
                await refundSupabase.from('letsgo_users').update({ points: refundData.points + TEACH_COST }).eq('id', user.userId);
                await refundSupabase.from('letsgo_point_transactions').insert({
                  user_id: user.userId, amount: TEACH_COST, type: 'teach_refund', description: '提示与教学-队列繁忙退回'
                });
                console.log(`[go-engine] Teach: Refunded ${TEACH_COST} points to user ${user.userId} (queue busy)`);
              }
            } catch { /* ignore refund error */ }
          }
          return NextResponse.json({ 
            analysis: null, 
            queueBusy: true, 
            queueLength: result.queueLength,
            error: `当前AI任务队列超过5（实际${result.queueLength}），请稍后再试` 
          });
        }
        return NextResponse.json({ analysis: result.analysis, pointsUsed: isAITest ? 0 : TEACH_COST });
      } catch (err) {
        console.error('[go-engine] Analysis error:', err);
        // 分析失败也退回积分（非AI测试）
        if (!isAITest) {
          try {
            const refundSupabase = getSupabaseClient();
            const { data: refundData } = await refundSupabase.from('letsgo_users').select('points').eq('id', user.userId).single();
            if (refundData) {
              await refundSupabase.from('letsgo_users').update({ points: refundData.points + TEACH_COST }).eq('id', user.userId);
              await refundSupabase.from('letsgo_point_transactions').insert({
                user_id: user.userId, amount: TEACH_COST, type: 'teach_refund', description: '提示与教学-分析失败退回'
              });
              console.log(`[go-engine] Teach: Refunded ${TEACH_COST} points to user ${user.userId} (analysis error)`);
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
    console.log(`[go-engine] POST genmove: user=${user.userId}(${user.nickname}), engine=${requestedEngine}, board=${boardSize}, diff=${difficulty}, moves=${moves?.length || 0}, queue=${engineQueue.getQueueLength()}`);

    // ============================================================
    // GnuGo引擎：直接spawn进程执行，不走EngineQueue
    // （GnuGo每次spawn新进程，天然可并行，不阻塞KataGo队列）
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
    // KataGo/Local引擎：积分扣除 + EngineQueue串行处理
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

    // 加入引擎队列（KataGo串行处理，支持多人排队；local也走队列保持一致）
    const queueInfo = engineQueue.getQueuePosition(user.userId);
    const queueStart = Date.now();
    const result = await engineQueue.enqueue(
      user.userId, requestedEngine, boardSize, moves, difficulty, aiColor
    );
    const queueElapsed = Date.now() - queueStart;
    console.log(`[go-engine] ${requestedEngine}完成: user=${user.userId}, move=${result.pass ? 'pass' : result.move ? `(${result.move.row},${result.move.col})` : 'null'}, engine=${result.engine}, queueWait=${queueElapsed}ms${result.noEngine ? ' [noEngine]' : ''}${result.engineError ? ' [error]' : ''}`);

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

    return NextResponse.json({ ...result, pointsUsed: cost, remainingPoints, queueInfo });
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
    queueLength,              // 顶层字段，队列中等待的任务数
    isProcessing,             // 顶层字段，是否有任务正在处理
    analysisSeconds,           // 当前分析配置（0=raw-nn, >0=kata-analyze搜索N秒）
    userQueuePosition: userQueueInfo.userPosition,  // 该用户在队列中的位置（1-based，-1=不在队列中）
    queue: { length: queueLength, processing: isProcessing },
  });
}
