/**
 * KataGo Analysis Engine TypeScript 客户端
 *
 * 基于本项目 docs/02-analysis-json-protocol.md 设计
 * 作为从 GTP 迁移到 Analysis Engine 的起点
 *
 * 特性：
 * - 异步 JSON 协议，不需要队列
 * - 按 id 精确匹配响应，永远不会错位
 * - 支持一次 query 分析多个 turn（analyzeTurns）
 * - 支持特殊 action（clear_cache, terminate, query_version）
 * - 正常退出时等待所有 query 完成
 *
 * 对比 GTP 客户端，这套代码消除了：
 * - 启动死锁（无 ensureReady 状态机）
 * - 监听器竞争（一个永久 stdout 监听器，按 id 分发）
 * - 命令/响应错位（每响应自带 id）
 * - 队列管理（天然并发）
 * - boardsize / clear_board / play 系列命令（每 query 独立）
 */

import { ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import { createInterface, Interface } from "readline";

// ============================================================
// 类型定义
// ============================================================

export type GtpVertex = string;      // "D4" / "pass" / "AA1"
export type Player = "B" | "W";
export type RulesShort =
  | "chinese" | "chinese-ogs" | "chinese-kgs"
  | "japanese" | "korean"
  | "tromp-taylor" | "new-zealand"
  | "aga" | "bga" | "aga-button"
  | "stone-scoring";

export interface RulesObject {
  ko?: "SIMPLE" | "POSITIONAL" | "SITUATIONAL";
  scoring?: "AREA" | "TERRITORY";
  tax?: "NONE" | "SEKI" | "ALL";
  suicide?: boolean;
  hasButton?: boolean;
  whiteHandicapBonus?: "0" | "N-1" | "N";
  friendlyPassOk?: boolean;
}

/** 单次分析的 query 完整契约 */
export interface AnalysisQuery {
  id?: string;                                  // 客户端会自动生成
  moves: Array<[Player, GtpVertex]>;
  rules: RulesShort | RulesObject;
  komi?: number;                                // 推荐显式传
  boardXSize: number;
  boardYSize: number;
  
  // 可选
  initialStones?: Array<[Player, GtpVertex]>;
  initialPlayer?: Player;
  analyzeTurns?: number[];
  maxVisits?: number;
  whiteHandicapBonus?: "0" | "N-1" | "N";
  
  // 输出控制
  includePolicy?: boolean;
  includeOwnership?: boolean;
  includeOwnershipStdev?: boolean;
  includeMovesOwnership?: boolean;
  includePVVisits?: boolean;
  
  // 搜索微调
  rootPolicyTemperature?: number;
  rootFpuReductionMax?: number;
  analysisPVLen?: number;
  
  // 黑白名单
  avoidMoves?: Array<{
    player: Player;
    moves: GtpVertex[];
    untilDepth: number;
  }>;
  allowMoves?: Array<{
    player: Player;
    moves: GtpVertex[];
    untilDepth: number;
  }>;
  
  // 配置覆盖
  overrideSettings?: Record<string, unknown>;
  
  // 调度
  priority?: number;
  priorities?: number[];
  reportDuringSearchEvery?: number;
}

export interface MoveInfo {
  move: GtpVertex;
  visits: number;
  edgeVisits?: number;
  winrate: number;                              // [0, 1], 视角受 reportAnalysisWinratesAs 控制
  scoreMean: number;                            // = scoreLead（兼容字段）
  scoreLead: number;                            // 推荐用
  scoreSelfplay?: number;
  scoreStdev?: number;
  prior: number;
  utility: number;
  lcb: number;
  utilityLcb: number;
  weight?: number;
  edgeWeight?: number;
  order: number;
  playSelectionValue?: number;
  isSymmetryOf?: GtpVertex;
  pv: GtpVertex[];
  pvVisits?: number[];
  pvEdgeVisits?: number[];
  ownership?: number[];
  ownershipStdev?: number[];
  humanPrior?: number;
  noResultValue?: number;
}

export interface RootInfo {
  currentPlayer: Player;
  visits: number;
  winrate: number;
  scoreLead: number;
  scoreSelfplay?: number;
  scoreStdev?: number;
  utility: number;
  symHash: string;                              // 对称等价的局面 hash
  thisHash: string;                             // 唯一局面 hash（含 ko）
  rawWinrate?: number;                          // 纯 NN 胜率
  rawLead?: number;
  rawScoreSelfplay?: number;
  rawScoreSelfplayStdev?: number;
  rawNoResultProb?: number;                     // 无胜负概率
  rawStWrError?: number;                        // NN 自报不确定度
  rawStScoreError?: number;
  rawVarTimeLeft?: number;
  humanWinrate?: number;
  humanScoreMean?: number;
  humanScoreStdev?: number;
}

export interface AnalysisResponse {
  id: string;
  turnNumber: number;
  isDuringSearch: false;                        // 客户端已过滤中途响应
  moveInfos: MoveInfo[];
  rootInfo: RootInfo;
  
  // 按 include* 字段返回
  ownership?: number[];
  ownershipStdev?: number[];
  policy?: number[];
  humanPolicy?: number[];
  
  // 客户端附加
  _client?: {
    elapsedMs: number;
    warnings?: Array<{ field: string; warning: string }>;
  };
}

export interface EngineConfig {
  katagoBin: string;
  modelPath: string;
  configPath: string;
  humanModelPath?: string;
  extraArgs?: string[];
  /** 关闭 stdin 时是否立即停止（默认 false：等所有 query 完成） */
  quitWithoutWaiting?: boolean;
  /** 启动超时（默认 120000ms） */
  startupTimeoutMs?: number;
  /** stderr 日志回调 */
  onStderr?: (line: string) => void;
  /** 调试：打印所有 query 和 response */
  debug?: boolean;
}

// ============================================================
// 客户端实现
// ============================================================

interface PendingQuery {
  expectedCount: number;
  received: number;
  responses: AnalysisResponse[];
  warnings: Array<{ field: string; warning: string }>;
  resolve: (value: AnalysisResponse[]) => void;
  reject: (reason: Error) => void;
  timer?: NodeJS.Timeout;
  startTime: number;
}

interface ActionQuery {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

/** KataGo Analysis Engine 客户端 */
export class KataGoAnalysisClient {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pending = new Map<string, PendingQuery>();
  private pendingActions = new Map<string, ActionQuery>();
  private idCounter = 0;
  private stderrBuf: string[] = [];
  private started = false;
  
  constructor(private cfg: EngineConfig) {}
  
  // --------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------
  
  async start(): Promise<void> {
    if (this.started) return;
    
    const args = [
      "analysis",
      "-config", this.cfg.configPath,
      "-model", this.cfg.modelPath,
    ];
    if (this.cfg.humanModelPath) args.push("-human-model", this.cfg.humanModelPath);
    if (this.cfg.quitWithoutWaiting) args.push("-quit-without-waiting");
    if (this.cfg.extraArgs) args.push(...this.cfg.extraArgs);
    
    this.proc = spawn(this.cfg.katagoBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleStdoutLine(line));
    
    // stderr 收集
    createInterface({ input: this.proc.stderr! }).on("line", (line) => {
      this.stderrBuf.push(line);
      this.cfg.onStderr?.(line);
    });
    
    this.proc.on("exit", (code) => {
      this.handleProcessExit(code);
    });
    
    // 等待启动完成（用 query_version 探测）
    const timeout = this.cfg.startupTimeoutMs ?? 120000;
    try {
      await Promise.race([
        this.queryVersion(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`KataGo startup timeout after ${timeout}ms`)), timeout)
        ),
      ]);
      this.started = true;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  
  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.stdin?.end();
      // 给进程 5s 清理，然后 kill
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 5000);
        this.proc!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      this.proc = null;
      this.started = false;
      // 所有未完成 query 失败
      for (const [id, p] of this.pending) {
        p.reject(new Error("KataGo process stopped"));
        if (p.timer) clearTimeout(p.timer);
      }
      this.pending.clear();
      for (const [id, a] of this.pendingActions) {
        a.reject(new Error("KataGo process stopped"));
      }
      this.pendingActions.clear();
    }
  }
  
  // --------------------------------------------------------
  // 公开 API
  // --------------------------------------------------------
  
  async analyze(
    query: AnalysisQuery,
    opts: { timeoutMs?: number } = {}
  ): Promise<AnalysisResponse[]> {
    if (!this.started || !this.proc) throw new Error("Client not started");
    
    const id = query.id ?? this.generateId();
    const expectedCount = query.analyzeTurns?.length ?? 1;
    const line = JSON.stringify({ ...query, id });
    
    if (this.cfg.debug) console.error(`[kata→] ${line}`);
    
    return new Promise<AnalysisResponse[]>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 120000;
      const pending: PendingQuery = {
        expectedCount,
        received: 0,
        responses: [],
        warnings: [],
        resolve,
        reject,
        startTime: Date.now(),
      };
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Query ${id} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      this.pending.set(id, pending);
      this.proc!.stdin!.write(line + "\n");
    });
  }
  
  async queryVersion(): Promise<{ version: string; git_hash: string }> {
    return this.actionQuery("query_version") as Promise<{
      version: string;
      git_hash: string;
    }>;
  }
  
  async queryModels(): Promise<{ models: Array<Record<string, unknown>> }> {
    return this.actionQuery("query_models") as Promise<{
      models: Array<Record<string, unknown>>;
    }>;
  }
  
  async clearCache(): Promise<void> {
    await this.actionQuery("clear_cache");
  }
  
  async terminate(terminateId: string, turnNumbers?: number[]): Promise<void> {
    const id = this.generateId("trm");
    const query: Record<string, unknown> = {
      id,
      action: "terminate",
      terminateId,
    };
    if (turnNumbers) query.turnNumbers = turnNumbers;
    
    return new Promise<void>((resolve, reject) => {
      this.pendingActions.set(id, {
        resolve: () => resolve(),
        reject,
      });
      this.proc!.stdin!.write(JSON.stringify(query) + "\n");
    });
  }
  
  getStderrLog(): string {
    return this.stderrBuf.join("\n");
  }
  
  // --------------------------------------------------------
  // 内部处理
  // --------------------------------------------------------
  
  private generateId(prefix = "q"): string {
    this.idCounter++;
    const rand = randomBytes(4).toString("hex");
    return `${prefix}-${this.idCounter}-${rand}`;
  }
  
  private async actionQuery(
    action: string
  ): Promise<Record<string, unknown>> {
    const id = this.generateId(action.slice(0, 3));
    const query = { id, action };
    
    return new Promise((resolve, reject) => {
      this.pendingActions.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(query) + "\n");
    });
  }
  
  private handleStdoutLine(line: string): void {
    let resp: Record<string, unknown>;
    try {
      resp = JSON.parse(line);
    } catch {
      // 非 JSON 行（通常是 header），忽略
      this.stderrBuf.push(`[non-json-stdout] ${line}`);
      return;
    }
    
    if (this.cfg.debug) console.error(`[kata←] ${line.slice(0, 200)}`);
    
    const id = resp.id as string | undefined;
    if (!id) {
      this.stderrBuf.push(`[no-id-response] ${line}`);
      return;
    }
    
    // action 响应
    if ("action" in resp) {
      const action = this.pendingActions.get(id);
      if (action) {
        this.pendingActions.delete(id);
        action.resolve(resp);
      }
      return;
    }
    
    // error/warning 响应
    if ("error" in resp) {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`KataGo error: ${resp.error}`));
      }
      return;
    }
    
    if ("warning" in resp && !("moveInfos" in resp)) {
      // warning 而已，继续等真响应
      const p = this.pending.get(id);
      if (p) {
        p.warnings.push({
          field: resp.field as string,
          warning: resp.warning as string,
        });
      }
      return;
    }
    
    // 正常分析响应
    if (resp.isDuringSearch === true) {
      // 中途响应，暂不处理
      return;
    }
    
    const p = this.pending.get(id);
    if (!p) return;
    
    const analysisResp = resp as unknown as AnalysisResponse;
    analysisResp._client = {
      elapsedMs: Date.now() - p.startTime,
      warnings: p.warnings.length > 0 ? p.warnings : undefined,
    };
    p.responses.push(analysisResp);
    p.received++;
    
    if (p.received >= p.expectedCount) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(p.responses);
    }
  }
  
  private handleProcessExit(code: number | null): void {
    const err = new Error(
      `KataGo process exited with code ${code}. Stderr tail: ${this.stderrBuf.slice(-20).join("\n")}`
    );
    for (const [id, p] of this.pending) {
      p.reject(err);
      if (p.timer) clearTimeout(p.timer);
    }
    this.pending.clear();
    for (const [id, a] of this.pendingActions) {
      a.reject(err);
    }
    this.pendingActions.clear();
    this.started = false;
    this.proc = null;
  }
}

// ============================================================
// 工具函数
// ============================================================

/** 把 (row, col) 转为 GTP vertex (row=0 是顶行)
 *  假设 boardSize=9：row=0 → "9", row=8 → "1"
 *  col=0 → "A", col=8 → "J"（跳过 I）
 */
export function rowColToVertex(
  row: number,
  col: number,
  boardSize: number
): GtpVertex {
  const cols = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // 跳过 I
  return `${cols[col]}${boardSize - row}`;
}

export function vertexToRowCol(
  vertex: GtpVertex,
  boardSize: number
): { row: number; col: number } | { isPass: true } {
  const v = vertex.trim().toUpperCase();
  if (v === "PASS" || v === "TT") return { isPass: true };
  const cols = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
  const colChar = v.charAt(0);
  const col = cols.indexOf(colChar);
  const row = boardSize - parseInt(v.slice(1), 10);
  if (col < 0 || isNaN(row)) {
    throw new Error(`Invalid vertex: ${vertex}`);
  }
  return { row, col };
}

/** 统一到黑方视角（如果 reportAnalysisWinratesAs 已经是 BLACK，此函数无操作） */
export function normalizeToBlackPerspective(
  resp: AnalysisResponse,
  perspective: "BLACK" | "WHITE" | "SIDETOMOVE"
): AnalysisResponse {
  if (perspective === "BLACK") return resp;
  
  const currentIsWhite = resp.rootInfo.currentPlayer === "W";
  const needFlip =
    perspective === "WHITE" ? true :
    perspective === "SIDETOMOVE" ? currentIsWhite :
    false;
  
  if (!needFlip) return resp;
  
  const flipWr = (wr: number) => 1 - wr;
  const flipScore = (s: number) => -s;
  
  return {
    ...resp,
    rootInfo: {
      ...resp.rootInfo,
      winrate: flipWr(resp.rootInfo.winrate),
      scoreLead: flipScore(resp.rootInfo.scoreLead),
      ...(resp.rootInfo.rawWinrate !== undefined && {
        rawWinrate: flipWr(resp.rootInfo.rawWinrate),
      }),
      ...(resp.rootInfo.rawLead !== undefined && {
        rawLead: flipScore(resp.rootInfo.rawLead),
      }),
    },
    moveInfos: resp.moveInfos.map((m) => ({
      ...m,
      winrate: flipWr(m.winrate),
      scoreLead: flipScore(m.scoreLead),
      scoreMean: flipScore(m.scoreMean),
    })),
  };
}

// ============================================================
// 使用示例
// ============================================================

export async function example() {
  const client = new KataGoAnalysisClient({
    katagoBin: "/usr/local/katago/katago",
    modelPath: "/usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz",
    configPath: "/usr/local/katago/analysis.cfg",
    debug: true,
  });
  
  await client.start();
  
  // 1. 简单分析
  const [resp1] = await client.analyze({
    moves: [["B", "E5"]],
    rules: "chinese",
    komi: 7,
    boardXSize: 9,
    boardYSize: 9,
    maxVisits: 500,
  });
  console.log("winrate:", resp1.rootInfo.winrate);
  console.log("best move:", resp1.moveInfos[0].move);
  
  // 2. 批量分析 10 手棋的每个回合
  const responses = await client.analyze({
    moves: generateTenMoves(),  // 略
    rules: "chinese",
    komi: 7,
    boardXSize: 9,
    boardYSize: 9,
    analyzeTurns: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    maxVisits: 200,
  });
  console.log(`Got ${responses.length} turn analyses`);
  
  // 3. 通过 includePolicy 拿到 NN 原始 policy
  const [respWithPolicy] = await client.analyze({
    moves: [],
    rules: "chinese",
    komi: 7,
    boardXSize: 9,
    boardYSize: 9,
    maxVisits: 100,
    includePolicy: true,
  });
  console.log("policy length:", respWithPolicy.policy?.length); // 82 (9*9+1 for pass)
  
  await client.stop();
}

function generateTenMoves(): Array<[Player, GtpVertex]> {
  return [
    ["B", "E5"], ["W", "E3"], ["B", "G3"], ["W", "C5"],
    ["B", "E7"], ["W", "G5"], ["B", "C3"], ["W", "G7"],
    ["B", "H4"], ["W", "H5"],
  ];
}
