// GTP桥接API - 与KataGo/GnuGo围棋AI引擎通信
// KataGo使用持久化进程（避免每步重新加载模型），GnuGo每次spawn
// 引擎通过GTP(Go Text Protocol)协议交互

import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getUserFromAuthHeader } from "@/lib/auth";

// KataGo分析结果类型
interface KataGoAnalysis {
  winRate: number;       // 黑方胜率 0-100
  scoreLead: number;     // 黑方领先目数（负数=白方领先）
  bestMoves: {           // 推荐落点（前3）
    move: string;        // GTP坐标 如 "D4"
    winrate: number;     // 该点黑方胜率
    scoreMean: number;   // 该点目数领先
  }[];
}

// 解析kata-analyze输出
// 格式: "info move D4 visits 500 winrate 5234 scoreMean 2.1 scoreStdev 1.5 ... info move Q16 visits 480 ..."
function parseKataAnalyze(output: string): KataGoAnalysis | null {
  try {
    const infos = output.split('info ').filter(s => s.trim());
    if (infos.length === 0) return null;

    const moves: KataGoAnalysis['bestMoves'] = [];
    let overallWinRate = 50;
    let overallScoreLead = 0;

    for (const info of infos) {
      const parts = info.trim().split(/\s+/);
      let move = '', visits = 0, winrate = 0, scoreMean = 0;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'move' && parts[i + 1]) move = parts[i + 1];
        if (parts[i] === 'visits' && parts[i + 1]) visits = parseInt(parts[i + 1]);
        if (parts[i] === 'winrate' && parts[i + 1]) winrate = parseFloat(parts[i + 1]) / 100; // 转为0-100
        if (parts[i] === 'scoreMean' && parts[i + 1]) scoreMean = parseFloat(parts[i + 1]);
      }

      if (move && visits > 0) {
        moves.push({ move, winrate, scoreMean });
      }
    }

    // 取第一个（最佳）move的数据作为整体形势
    if (moves.length > 0) {
      overallWinRate = moves[0].winrate;
      overallScoreLead = moves[0].scoreMean;
    }

    return {
      winRate: Math.round(overallWinRate * 10) / 10,
      scoreLead: Math.round(overallScoreLead * 10) / 10,
      bestMoves: moves.slice(0, 3)
    };
  } catch {
    return null;
  }
}

// 防止 EPIPE 等管道错误导致进程崩溃
process.on('uncaughtException', (err: unknown) => {
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'EPIPE') {
    // KataGo 进程退出后 stdin 写入会触发 EPIPE，忽略即可
    console.warn('[go-engine] Ignored EPIPE error (KataGo process likely exited)');
    return;
  }
  throw err;
});

// 引擎路径
const KATAGO_PATH = "/usr/local/katago/katago";
const KATAGO_DIR = "/usr/local/katago";
const KATAGO_CONFIG = "/usr/local/katago/gtp.cfg";
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

// KataGo排队系统：串行处理请求，避免并发冲突
interface QueueItem {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  task: () => Promise<unknown>;
  enqueuedAt: number;
}
const kataGoQueue: QueueItem[] = [];
let isKataGoBusy = false;

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

// KataGo分析结果缓存（后台异步分析完成后存储，go-ai API可直接读取）
const analysisCache: Map<string, { data: KataGoAnalysis; timestamp: number }> = new Map();

// 导出查询分析缓存的方法（供go-ai使用）
export function getCachedAnalysis(moves: Array<{row: number; col: number; color: string}>): KataGoAnalysis | null {
  const cacheKey = moves.map(m => `${m.color[0]}${m.row},${m.col}`).join('|');
  const cached = analysisCache.get(cacheKey);
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
  return {
    kataGo: { queueLength: kataGoQueue.length, processing: isKataGoBusy },
    gnugo: { queueLength: 0, processing: false },
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

function enqueueKataGoTask<T>(task: () => Promise<T>): Promise<{ result: T; waitMs: number }> {
  const enqueuedAt = Date.now();
  return new Promise((resolve, reject) => {
    kataGoQueue.push({
      resolve: (r: unknown) => resolve(r as { result: T; waitMs: number }),
      reject,
      task: async () => {
        const result = await task();
        return { result, waitMs: Date.now() - enqueuedAt };
      },
      enqueuedAt,
    });
    processKataGoQueue();
  });
}

async function processKataGoQueue() {
  if (isKataGoBusy || kataGoQueue.length === 0) return;
  isKataGoBusy = true;

  while (kataGoQueue.length > 0) {
    const item = kataGoQueue.shift()!;
    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  isKataGoBusy = false;
}

// 自动查找KataGo可用的神经网络模型
// 支持多种模型格式(.bin.gz, .txt.gz)，按优先级返回
function findKataGoModel(): string | null {
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
  if (difficulty === "easy") return 15;
  if (difficulty === "medium") return 50;
  return 150;
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

  isAvailable(): boolean {
    return !!(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  getProcess(): ChildProcess | null {
    return this.proc;
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

    console.log(`[KataGo] Starting persistent process with model: ${model}`);

    // Kill any old process
    this.killProcess();
    this.procEpoch++;  // 递增纪元，旧进程的onData会被忽略

    this.proc = spawn(KATAGO_PATH, [
      "gtp",
      "-model", model,
      "-config", KATAGO_CONFIG,
      "-override-config", "maxVisits=50",  // 默认中等难度，后续动态调整
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
      results.push(await this.sendCommand(cmd, timeoutMs));
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

  /** 中断正在进行的KataGo分析（杀掉进程重启，下棋优先） */
  async stopAnalysis(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    console.log(`[KataGo] stopAnalysis - killing process to interrupt analysis for genmove priority`);
    try {
      // 拒绝所有等待中的命令
      for (const item of this.commandQueue) {
        clearTimeout(item.timeout);
        item.reject(new Error("KataGo analysis interrupted for genmove priority"));
      }
      this.commandQueue = [];
      this.procEpoch++;  // 递增纪元，旧进程的onData会被忽略
      this.buffer = "";
      // 杀掉进程（下次getProcess()会自动重启）
      try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
      this.proc = null;
    } catch (e) {
      console.log(`[KataGo] stopAnalysis error:`, e);
    }
  }

  // 完全关闭（进程退出时调用）
  shutdown(): void {
    this.killProcess();
  }

  resetCrashState(): void {
    this.killProcess();
  }
}

// 模块级单例 - Node.js进程内共享
const persistentKataGo = new PersistentKataGo();

// ============================================================
// KataGo落子（使用持久化进程）
// ============================================================
async function getKataGoMove(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: string }>,
  difficulty: string,
  aiColor: 'black' | 'white' = 'white'
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string }> {
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

  // 发送命令，单条超时30秒（总超时由Next.js request timeout控制）
  const responses = await persistentKataGo.sendCommands(gtpCommands, 30000);

  // 解析genmove响应
  const lastResponse = responses[responses.length - 1];
  const moveMatch = lastResponse.match(/=\s*([A-HJ-T]\d+|PASS|resign)/i);

  if (!moveMatch) {
    console.warn(`[KataGo] Unexpected genmove response: "${lastResponse}"`);
    return { move: null, pass: true, engine: "katago" };
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
// KataGo分析（kata-analyze命令，固定maxVisits=500）
// ============================================================
async function getKataGoAnalysis(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: "black" | "white" }>
): Promise<KataGoAnalysis | null> {
  try {
    await persistentKataGo.ensureReady();
  } catch {
    console.log('[kata-analyze] KataGo进程未就绪，跳过分析');
    return null;
  }

  try {
    // 设置分析用的maxVisits（固定500，不受游戏难度影响）
    await persistentKataGo.sendCommand('kata-set-param maxVisits 500');

    // 准备棋盘并重放落子
    const gtpCommands = [
      `boardsize ${boardSize}`,
      'clear_board',
    ];

    for (const m of moves) {
      const colChar = String.fromCharCode(65 + (m.col >= 8 ? m.col + 1 : m.col));
      const coord = `${colChar}${boardSize - m.row}`;
      const color = m.color === "black" ? "B" : "W";
      gtpCommands.push(`play ${color} ${coord}`);
    }

    // 执行分析（kata-analyze interval=10 表示每10次visit输出一次）
    gtpCommands.push('kata-analyze 10');

    // 恢复游戏难度的maxVisits
    gtpCommands.push('kata-set-param maxVisits 150');

    const responses = await persistentKataGo.sendCommands(gtpCommands, 120000);

    // kata-analyze的响应是倒数第二个（最后一个是我们恢复maxVisits的响应）
    const analyzeResponse = responses[responses.length - 2] || '';

    return parseKataAnalyze(analyzeResponse);
  } catch (err) {
    console.error('[kata-analyze] 分析失败:', err);
    try {
      // 恢复maxVisits
      await persistentKataGo.sendCommand('kata-set-param maxVisits 150');
    } catch { /* ignore */ }
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
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string }> {
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
      return { move: null, pass: true, engine: "gnugo" };
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
}

interface EngineQueueResult {
  move: { row: number; col: number } | null;
  pass?: boolean;
  resign?: boolean;
  engine: string;
  engineError?: boolean;
  errorDetail?: string;
  noEngine?: boolean;
}

class EngineQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private entryId = 0;
  private currentEntry: QueueEntry | null = null; // 当前正在处理的条目

  /** 取消所有排队中的分析请求（下棋请求优先） */
  cancelPendingAnalysis(): number {
    const before = this.queue.length;
    this.queue = this.queue.filter(entry => {
      if (entry.isAnalysis) {
        // 通知等待者分析已被取消
        if (entry.analysisResolve) entry.analysisResolve(null);
        return false;
      }
      return true;
    });
    const cancelled = before - this.queue.length;
    if (cancelled > 0) {
      console.log(`[engine-queue] Cancelled ${cancelled} pending analysis request(s)`);
    }
    return cancelled;
  }

  async enqueue(
    userId: number,
    engine: string,
    boardSize: number,
    moves: Array<{ row: number; col: number; color: string }>,
    difficulty: string,
    aiColor: 'black' | 'white' = 'white'
  ): Promise<EngineQueueResult> {
    const id = `qe-${++this.entryId}-u${userId}`;
    console.log(`[engine-queue] Enqueued: ${id}, engine=${engine}, aiColor=${aiColor}, queueLen=${this.queue.length}`);

    // 下棋请求优先：取消排队中的分析请求
    this.cancelPendingAnalysis();

    // 下棋请求优先：如果当前正在运行分析，用GTP stop中断
    if (this.processing && this.currentEntry?.isAnalysis) {
      console.log(`[engine-queue] Genmove arrived while analysis is running - sending stop`);
      await persistentKataGo.stopAnalysis();
      // stopAnalysis会拒绝当前分析的command，导致processNext结束
      // 等待processing变false（最多3秒）
      const waitStart = Date.now();
      while (this.processing && Date.now() - waitStart < 3000) {
        await new Promise(r => setTimeout(r, 50));
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
      // 分析请求：只使用KataGo，不影响下棋结果
      if (entry.isAnalysis) {
        let analysisResult: KataGoAnalysis | null = null;
        if (isKataGoAvailable()) {
          try {
            analysisResult = await getKataGoAnalysis(entry.boardSize, entry.moves as Array<{row: number; col: number; color: 'black' | 'white'}>);
          } catch (err) {
            console.warn(`[engine-queue] Analysis failed:`, err instanceof Error ? err.message : String(err));
            persistentKataGo.resetCrashState();
          }
        }
        if (entry.analysisResolve) {
          entry.analysisResolve(analysisResult);
        }
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

  /** 获取KataGo局面分析（通过主队列串行执行，避免与genmove命令冲突） */
  async enqueueAnalysis(moves: Array<{row: number, col: number, color: "black" | "white"}>, boardSize: number): Promise<KataGoAnalysis | null> {
    // 检查KataGo是否可用
    if (!isKataGoAvailable()) {
      return null;
    }
    const id = `qe-${++this.entryId}-analysis`;
    console.log(`[engine-queue] Enqueued analysis: ${id}, queueLen=${this.queue.length}`);
    return new Promise((resolve) => {
      this.queue.push({
        id,
        userId: 0,
        resolve: () => {}, // 分析请求不走正常resolve
        reject: () => {},
        boardSize,
        moves,
        difficulty: '',
        engine: 'katago',
        aiColor: 'black',
        isAnalysis: true,
        analysisResolve: resolve,
      });
      this.processNext();
    });
  }
}

const engineQueue = new EngineQueue();

// ============================================================
// API路由
// ============================================================
export async function POST(request: NextRequest) {
  try {
    const { boardSize, moves, difficulty, engine: requestedEngine, aiColor: rawAiColor, action } = await request.json();
    const aiColor: 'black' | 'white' = (rawAiColor === 'black' || rawAiColor === 'white') ? rawAiColor : 'white';

    // 按需分析请求：仅当用户点击"提示与教学"时触发
    if (action === 'analyze') {
      const authHeader = request.headers.get('Authorization');
      const user = getUserFromAuthHeader(authHeader);
      if (!user || !isKataGoAvailable()) {
        return NextResponse.json({ analysis: null });
      }
      try {
        const analysisResult = await engineQueue.enqueueAnalysis(
          moves as Array<{row: number, col: number, color: 'black' | 'white'}>,
          boardSize
        );
        return NextResponse.json({ analysis: analysisResult });
      } catch {
        return NextResponse.json({ analysis: null });
      }
    }

    // 认证：从请求头获取用户
    const authHeader = request.headers.get('Authorization');
    const user = getUserFromAuthHeader(authHeader);
    
    if (!user) {
      // 未登录用户：仍允许使用本地AI，其他引擎需要登录
      if (requestedEngine === 'local') {
        console.log(`[go-engine] Guest user using local AI`);
        return NextResponse.json({ move: null, engine: "local", noEngine: true });
      }
      return NextResponse.json({ error: '请先登录后再使用AI引擎', needLogin: true }, { status: 401 });
    }

    // 积分检查和扣除
    const cost = getEngineCost(requestedEngine);
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

    // 追踪活跃对弈
    if (user) {
      trackActiveSession(user.userId, user.nickname, requestedEngine, boardSize, difficulty, moves.length);
    }

    // 加入引擎队列（串行处理，支持多人排队）
    const result = await engineQueue.enqueue(
      user.userId, requestedEngine, boardSize, moves, difficulty, aiColor
    );
    
    // 获取最新积分余额并附加到响应中
    let remainingPoints: number | undefined;
    if (cost > 0 && user) {
      const { data: latestUser } = await supabase
        .from('letsgo_users')
        .select('points')
        .eq('id', user.userId)
        .single();
      remainingPoints = latestUser?.points;
    }

    return NextResponse.json({ ...result, pointsUsed: cost, remainingPoints });
  } catch (error) {
    console.error("Go engine API error:", error);
    return NextResponse.json({ error: "引擎错误" }, { status: 500 });
  }
}

// GET: 返回可用引擎列表（含诊断信息）
export async function GET() {
  // 详细诊断：帮助定位 Railway 上引擎不生效的原因
  const katagoBinExists = fs.existsSync(KATAGO_PATH);
  const katagoModel = findKataGoModel();
  const katagoCfgExists = fs.existsSync(KATAGO_CONFIG);
  const gnugoPath = findGnuGoPath();

  // 运行时诊断：检查 KataGo 动态链接库和启动测试
  let lddOutput = '';
  let katagoTestOutput = '';
  const { execSync } = await import('child_process');
  if (katagoBinExists) {
    try {
      lddOutput = execSync(`ldd ${KATAGO_PATH}`, { timeout: 5000, encoding: 'utf-8' }).trim();
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      lddOutput = `ldd failed: ${err.stderr || err.stdout || err.message || String(e)}`;
    }
    try {
      katagoTestOutput = execSync(`${KATAGO_PATH} version`, { timeout: 10000, encoding: 'utf-8' }).trim();
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      katagoTestOutput = `version test failed: ${err.stderr || err.stdout || err.message || String(e)}`;
    }
  }

  console.log(`[go-engine] Diagnosis: katago_bin=${katagoBinExists}, model=${katagoModel}, cfg=${katagoCfgExists}, gnugo=${gnugoPath}, cwd=${process.cwd()}`);
  console.log(`[go-engine] KataGo ldd:\n${lddOutput}`);
  console.log(`[go-engine] KataGo version test:\n${katagoTestOutput}`);

  return NextResponse.json({
    engines: [
      {
        id: "katago", name: "KataGo", available: isKataGoAvailable(), desc: "深度学习引擎，棋力最强",
        cost: ENGINE_COSTS.katago,
        debug: { binExists: katagoBinExists, model: katagoModel, cfgExists: katagoCfgExists, binPath: KATAGO_PATH, cfgPath: KATAGO_CONFIG, ldd: lddOutput, versionTest: katagoTestOutput },
      },
      {
        id: "gnugo", name: "GnuGo", available: isGnuGoAvailable(), desc: "经典围棋引擎，棋力扎实",
        cost: ENGINE_COSTS.gnugo,
        debug: { path: gnugoPath, searchedPaths: GNUGO_PATHS },
      },
      { id: "local", name: "本地AI", available: true, desc: "内置启发式AI，随时可用", cost: ENGINE_COSTS.local },
    ],
    queue: { length: engineQueue.getQueueLength(), processing: engineQueue.isProcessing() },
  });
}
