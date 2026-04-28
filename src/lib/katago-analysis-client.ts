/**
 * KataGo Analysis Engine 管理器
 *
 * 多引擎常驻架构（方案B）
 * - 按功能区分 2 个常驻进程：对弈专用 + 分析专用
 * - 每个实例绑定单一模型，启动后不再切换
 * - 按 id 匹配响应，天然防错位
 * - 每请求自带完整局面，无状态污染
 * - 支持 analyze 和 genmove（从分析结果取最佳手）
 *
 * 时间戳: 2026-04-25 02:45:47
 */

import { ChildProcess, spawn } from "child_process";
import { createInterface } from "readline";
import fs from "fs";
import https from "https";
import path from "path";

// ============================================================
// 类型定义（与现有 KataGoAnalysis 兼容）
// ============================================================

export interface KataGoAnalysis {
  winRate: number;
  scoreLead: number;
  actualVisits: number;
  bestMoves: {
    move: string;
    winrate: number;
    scoreMean: number;
    visits: number;
  }[];
}

interface AnalysisQuery {
  id: string;
  moves: Array<[string, string]>;
  rules: string;
  komi: number;
  boardXSize: number;
  boardYSize: number;
  maxVisits?: number;
  includePolicy?: boolean;
  includeOwnership?: boolean;
  analysisPVLen?: number;
}

interface MoveInfo {
  move: string;
  visits: number;
  winrate: number;
  scoreLead: number;
  scoreMean: number;
  prior: number;
  order: number;
  pv: string[];
}

interface RootInfo {
  currentPlayer: string;
  visits: number;
  winrate: number;
  scoreLead: number;
}

interface AnalysisResponse {
  id: string;
  turnNumber: number;
  isDuringSearch: boolean;
  moveInfos: MoveInfo[];
  rootInfo: RootInfo;
}

interface PendingQuery {
  resolve: (value: AnalysisResponse[]) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================
// 配置常量
// ============================================================

const KATAGO_HOME = process.env.HOME || process.env.USERPROFILE || '';
const KATAGO_DIR = process.env.KATAGO_DIR || (fs.existsSync(`${KATAGO_HOME}/katago/katago`) ? `${KATAGO_HOME}/katago` : "/usr/local/katago");
export const MODEL_PATHS: Record<string, string> = {
  rect15: `${KATAGO_DIR}/rect15-b20c256-s343365760-d96847752.bin.gz`,
  kata9x9: `${KATAGO_DIR}/kata9x9-b18c384nbt-20231025.bin.gz`,
  humanv0: `${KATAGO_DIR}/b18c384nbt-humanv0.bin.gz`,
  g170: `${KATAGO_DIR}/g170-b6c96-s175395328-d26788732.bin.gz`,
  b10c128: `${KATAGO_DIR}/kata1-b10c128-s1141046784-d204142634.txt.gz`,
  b18c384: `${KATAGO_DIR}/kata1-b18c384nbt-s7709731328-d3715293823.bin.gz`,
  b28c512: `${KATAGO_DIR}/kata1-b28c512nbt-s12763923712-d5805955894.bin.gz`,
};

// 模型下载地址（用于 Railway/新环境自动下载）
const MODEL_DOWNLOAD_URLS: Record<string, string> = {
  b10c128: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz',
  b18c384: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s7709731328-d3715293823.bin.gz',
  b28c512: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b28c512nbt-s12763923712-d5805955894.bin.gz',
};

/** 下载单个文件 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) { reject(new Error('Redirect without location')); return; }
        downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`Download failed: ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

/** 自动下载缺失的 KataGo 模型（用于 Railway 部署等无模型环境） */
export async function downloadMissingModels(): Promise<void> {
  for (const [key, filePath] of Object.entries(MODEL_PATHS)) {
    if (fs.existsSync(filePath)) continue;
    const url = MODEL_DOWNLOAD_URLS[key];
    if (!url) continue;
    const fileName = path.basename(filePath);
    console.log(`[ModelDownload] Downloading ${key}: ${fileName}...`);
    try {
      await downloadFile(url, filePath);
      const sizeMB = Math.round(fs.statSync(filePath).size / 1024 / 1024 * 10) / 10;
      console.log(`[ModelDownload] ${key} downloaded (${sizeMB}MB)`);
    } catch (err) {
      console.error(`[ModelDownload] Failed to download ${key}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

function findKataGoConfig(): string {
  if (process.env.KATAGO_ANALYSIS_CONFIG && fs.existsSync(process.env.KATAGO_ANALYSIS_CONFIG)) {
    return process.env.KATAGO_ANALYSIS_CONFIG;
  }
  const candidates = [
    `${KATAGO_DIR}/analysis.cfg`,
    `${KATAGO_HOME}/katago/analysis.cfg`,
    "/usr/local/katago/analysis.cfg",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]; // fallback
}

const KATAGO_BIN = process.env.KATAGO_PATH || `${KATAGO_DIR}/katago`;
const CONFIG_PATH = findKataGoConfig();

let idCounter = 0;
function generateId(): string {
  return `q-${++idCounter}-${Date.now().toString(36)}`;
}

// ============================================================
// KataGo Analysis Engine 管理器（单模型绑定）
// ============================================================

export class KataGoAnalysisManager {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<string, PendingQuery>();
  private started = false;
  private starting = false;
  private startPromise: Promise<void> | null = null;
  private stderrBuf: string[] = [];

  constructor(private readonly model: string) {}

  isAvailable(): boolean {
    return this.started && !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  getCurrentModel(): string {
    return this.model;
  }

  // 启动绑定的模型
  async start(): Promise<void> {
    if (this.started && this.isAvailable()) {
      return;
    }

    // 防止并发启动：如果已经有启动在进行中，等待它完成
    if (this.starting && this.startPromise) {
      return this.startPromise;
    }

    this.starting = true;
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.starting = false;
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    // 二次检查：可能在等待锁期间其他调用已经启动成功
    if (this.started && this.isAvailable()) {
      return;
    }

    // 清空上次启动残留的 stderr，避免 checkReady 误判
    this.stderrBuf = [];

    // 优雅关闭旧进程
    await this.stop();

    const modelPath = MODEL_PATHS[this.model];
    if (!modelPath) throw new Error(`Unknown model: ${this.model}`);

    console.log(`[AnalysisEngine] Starting with model: ${this.model} (${modelPath})`);
    console.log(`[AnalysisEngine] Using config: ${CONFIG_PATH} (exists=${fs.existsSync(CONFIG_PATH)})`);

    const proc = spawn(KATAGO_BIN, [
      "analysis",
      "-config", CONFIG_PATH,
      "-model", modelPath,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));

    createInterface({ input: proc.stderr! }).on("line", (line) => {
      this.stderrBuf.push(line);
    });

    proc.on("exit", (code) => {
      // 只有当前进程退出时才清理状态，防止旧进程的 exit 事件覆盖新进程
      if (this.proc !== proc) {
        console.log(`[AnalysisEngine] Old process exited with code ${code} (ignored, new process already running)`);
        return;
      }
      console.log(`[AnalysisEngine] Process exited with code ${code}`);
      this.cleanupPending(new Error(`KataGo exited with code ${code}`));
      this.started = false;
      this.proc = null;
    });

    // 等待第一个响应（任何 JSON 行都表示引擎已就绪）
    await this.waitForReady(120000);
    this.started = true;
    console.log(`[AnalysisEngine] Ready: model=${this.model}`);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // 只有当前进程仍是我们要停止的那个时才 kill，防止误杀新进程
          if (this.proc === proc) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, 5000);
        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      // 只有当前进程仍是我们要停止的那个时才清理状态
      if (this.proc === proc) {
        this.proc = null;
        this.rl?.close();
        this.rl = null;
        this.started = false;
      }
      this.cleanupPending(new Error("Engine stopped"));
    }
  }

  // 分析局面
  async analyze(
    boardSize: number,
    moves: Array<{ row: number; col: number; color: "black" | "white"; isPass?: boolean }>,
    options: {
      maxVisits?: number;
      maxTime?: number;
      komi?: number;
      rules?: string;
    } = {}
  ): Promise<KataGoAnalysis | null> {
    if (!this.started || !this.proc) throw new Error("Engine not started");

    const id = generateId();
    const gtpMoves = moves.map((m): [string, string] => {
      const player = m.color === "black" ? "B" : "W";
      if (m.isPass) return [player, "pass"];
      const cols = "ABCDEFGHJKLMNOPQRST";
      const colChar = cols[m.col];
      const coord = `${colChar}${boardSize - m.row}`;
      return [player, coord];
    });

    const query: AnalysisQuery = {
      id,
      moves: gtpMoves,
      rules: options.rules || "chinese",
      komi: options.komi ?? (boardSize <= 9 ? 7 : 7.5),
      boardXSize: boardSize,
      boardYSize: boardSize,
      maxVisits: options.maxVisits,
      analysisPVLen: 15,
    };

    const line = JSON.stringify(query);
    console.log(`[AnalysisEngine] Query: ${line}`);

    return new Promise<KataGoAnalysis | null>((resolve, reject) => {
      const timeoutMs = (options.maxTime || 15) * 1000 + 10000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Analysis timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve: (resps) => {
        clearTimeout(timer);
        const resp = resps[0];
        if (!resp) { resolve(null); return; }
        resolve(this.toKataGoAnalysis(resp));
      }, reject: (err) => {
        clearTimeout(timer);
        reject(err);
      }, timer });

      this.proc!.stdin!.write(line + "\n");
    });
  }

  // genmove：分析后取最佳手
  async genmove(
    boardSize: number,
    moves: Array<{ row: number; col: number; color: "black" | "white"; isPass?: boolean }>,
    aiColor: "black" | "white",
    options: {
      maxVisits?: number;
      maxTime?: number;
      komi?: number;
      rules?: string;
    } = {}
  ): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; actualVisits?: number }> {
    const result = await this.analyze(boardSize, moves, options);
    if (!result || result.bestMoves.length === 0) {
      return { move: null, engineError: true } as any;
    }

    const best = result.bestMoves[0];
    if (best.move === "pass") return { move: null, pass: true, actualVisits: result.actualVisits };
    if (best.move === "resign") return { move: null, resign: true, actualVisits: result.actualVisits };

    const pos = this.gtpToPosition(best.move, boardSize);
    return { move: pos, actualVisits: result.actualVisits };
  }

  // --------------------------------------------------------
  // 内部处理
  // --------------------------------------------------------

  private handleLine(line: string): void {
    let resp: Record<string, unknown>;
    try {
      resp = JSON.parse(line);
    } catch {
      return; // 非 JSON 行，忽略
    }

    const id = resp.id as string | undefined;
    if (!id) return;

    if ("error" in resp) {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`KataGo error: ${resp.error}`));
      }
      return;
    }

    if (resp.isDuringSearch === true) return; // 忽略中途响应

    // 忽略只有 warning 的响应（如未知字段警告），等待带 rootInfo 的最终响应
    if (!resp.rootInfo) return;

    const p = this.pending.get(id);
    if (!p) return;

    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve([resp as unknown as AnalysisResponse]);
  }

  private cleanupPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout after ${timeoutMs}ms`)), timeoutMs);

      // 监听进程异常退出
      const onExit = (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        const stderr = this.stderrBuf.slice(-30).join('\n');
        reject(new Error(`KataGo exited with code ${code}, signal ${signal} during startup. Stderr:\n${stderr}`));
      };
      const onError = (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`KataGo process error: ${err.message}`));
      };
      this.proc!.on("exit", onExit);
      this.proc!.on("error", onError);

      let interval: ReturnType<typeof setInterval> | undefined;

      const checkReady = () => {
        // 进程已退出，停止检查
        if (!this.proc) {
          if (interval) clearInterval(interval);
          clearTimeout(timer);
          return;
        }
        // KataGo Analysis Engine 输出 "Started, ready to begin handling requests" 表示就绪
        if (this.stderrBuf.some(l => l.includes("Started, ready to begin handling requests"))) {
          this.proc.removeListener("exit", onExit);
          this.proc.removeListener("error", onError);
          clearTimeout(timer);
          if (interval) clearInterval(interval);
          resolve();
          return;
        }
      };

      // 立即检查一次
      checkReady();

      // 每 200ms 检查 stderr 是否有新内容
      interval = setInterval(() => {
        checkReady();
      }, 200);

      // 达到 timeout 时清理
      timer.unref?.(); // 允许 Node 事件循环在 timer 前退出（如果已经 resolve）
    });
  }

  private toKataGoAnalysis(resp: AnalysisResponse): KataGoAnalysis {
    const root = resp.rootInfo;

    // analysis.cfg 中设置了 reportAnalysisWinratesAs = BLACK
    // KataGo 返回的 winrate / scoreLead / moveInfos[].winrate / moveInfos[].scoreLead
    // 全部已经是黑方视角，无需按 currentPlayer 转换
    const winRate = Math.round(root.winrate * 1000) / 10;
    const scoreLead = Math.round(root.scoreLead * 10) / 10;

    // 保持 KataGo 原始 order（基于 visits + 引擎置信度）
    // 低 visits 下按胜率重排序会导致 visit 极少的手因偶然波动排到前面，
    // 给用户造成"分析质量差/visits 很少"的错觉。
    const bestMoves = resp.moveInfos
      .slice(0, 5)
      .map((m) => ({
        move: m.move,
        winrate: Math.round(m.winrate * 1000) / 10,
        scoreMean: Math.round(m.scoreLead * 10) / 10,
        visits: m.visits,
      }));

    return {
      winRate,
      scoreLead,
      actualVisits: root.visits,
      bestMoves,
    };
  }

  private gtpToPosition(coord: string, boardSize: number): { row: number; col: number } | null {
    if (coord === "pass" || coord === "resign") return null;
    const cols = "ABCDEFGHJKLMNOPQRST";
    const colChar = coord.charAt(0).toUpperCase();
    const col = cols.indexOf(colChar);
    const rowNum = parseInt(coord.slice(1));
    if (col < 0 || isNaN(rowNum)) return null;
    const row = boardSize - rowNum;
    return { row, col };
  }
}

// ============================================================
// 多引擎池（按功能区分：对弈专用 + 分析专用）
// ============================================================

export class KataGoAnalysisEnginePool {
  private engines = new Map<string, KataGoAnalysisManager>();

  getEngine(model: string): KataGoAnalysisManager {
    if (!this.engines.has(model)) {
      this.engines.set(model, new KataGoAnalysisManager(model));
    }
    return this.engines.get(model)!;
  }

  /** 启动所有已创建的引擎（服务预热） */
  async warmupAll(): Promise<void> {
    for (const [model, engine] of this.engines) {
      try {
        console.log(`[EnginePool] Warming up ${model}...`);
        await engine.start();
      } catch (err) {
        console.warn(`[EnginePool] Warmup failed for ${model}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** 获取所有活跃引擎信息 */
  getStatus(): Array<{ model: string; available: boolean }> {
    return Array.from(this.engines.entries()).map(([model, engine]) => ({
      model,
      available: engine.isAvailable(),
    }));
  }
}

// 全局引擎池单例
let enginePool: KataGoAnalysisEnginePool | null = null;

export function getEnginePool(): KataGoAnalysisEnginePool {
  if (!enginePool) {
    enginePool = new KataGoAnalysisEnginePool();
  }
  return enginePool;
}

// ============================================================
// 向后兼容：旧 getAnalysisManager() 保留但标记为 deprecated
// 由调用方迁移到 getEnginePool().getEngine(model)
// ============================================================

/** @deprecated 请使用 getEnginePool().getEngine(model) */
export function getAnalysisManager(): KataGoAnalysisManager {
  return getEnginePool().getEngine("rect15");
}
