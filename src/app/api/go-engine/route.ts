// GTP桥接API - 与KataGo/GnuGo围棋AI引擎通信
// 优先使用KataGo（深度学习+MCTS，远强于GnuGo），GnuGo作为回退
// 引擎通过GTP(Go Text Protocol)协议交互，spawn子进程通信

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";

// 引擎路径
const KATAGO_PATH = "/usr/local/katago/katago";
const KATAGO_MODEL = "/usr/local/katago/g170-b6c96-s175395328-d26788732.bin.gz";
const KATAGO_CONFIG = "/usr/local/katago/gtp.cfg";
const GNUGO_PATH = "/usr/games/gnugo";

// 检查KataGo是否可用
function isKataGoAvailable(): boolean {
  return fs.existsSync(KATAGO_PATH) && fs.existsSync(KATAGO_MODEL);
}

// 围棋坐标转GTP坐标
// row=0,col=0 -> A1 (左上角，视觉顶部)
// 但围棋坐标是行号从下往上，所以row=0是视觉顶部=最大行号
function boardToGTPCoord(row: number, col: number, boardSize: number): string {
  // 跳过I列
  const colChar = col >= 8 ? String.fromCharCode(65 + col + 1) : String.fromCharCode(65 + col);
  // 行号从下往上：row=0是视觉顶部=boardSize
  const rowNum = boardSize - row;
  return `${colChar}${rowNum}`;
}

// GTP坐标转棋盘坐标
function gtpToBoardCoord(gtpCoord: string, boardSize: number): { row: number; col: number } | null {
  const match = gtpCoord.toUpperCase().match(/^([A-HJ-T])(\d+)$/);
  if (!match) return null;

  const colChar = match[1];
  const rowNum = parseInt(match[2]);

  // 列：A=0,B=1,...,H=7,J=8,K=9,...
  let col = colChar.charCodeAt(0) - 65;
  if (col >= 8) col -= 1; // 跳过I

  // 行号从下往上：行1=数组最后一行，行N=数组第0行
  const row = boardSize - rowNum;

  if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) return null;
  return { row, col };
}

// 发送GTP命令并获取响应
function sendGTPCommand(proc: ReturnType<typeof spawn>, command: string, timeoutMs: number = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;

    const cleanup = () => {
      proc.stdout?.removeListener("data", onData);
      proc.stderr?.removeListener("data", onError);
      clearTimeout(timeout);
    };

    const onData = (data: Buffer) => {
      output += data.toString();
      // GTP响应以双换行结束
      if (output.includes("\n\n") && !settled) {
        settled = true;
        cleanup();
        resolve(output.trim());
      }
    };

    const onError = () => {
      // Ignore stderr
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onError);

    // 设置超时
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

// 批量发送GTP命令
async function sendMultipleGTP(
  proc: ReturnType<typeof spawn>,
  commands: string[],
  timeoutMs: number = 30000
): Promise<string[]> {
  const results: string[] = [];
  for (const cmd of commands) {
    const resp = await sendGTPCommand(proc, cmd, timeoutMs);
    results.push(resp);
  }
  return results;
}

// 获取贴目值
function getKomi(boardSize: number): number {
  return boardSize <= 9 ? 2.5 : boardSize <= 13 ? 3.5 : 6.5;
}

// KataGo难度映射 - 通过maxVisits控制
// visits越少越弱，越多越强（CPU模式下需要平衡速度）
function getKataGoVisits(difficulty: string): number {
  if (difficulty === "easy") return 30;     // 很少搜索，类似业余初学
  if (difficulty === "medium") return 100;   // 中等搜索，有基本战术
  return 300;                                // 大量搜索，有深度计算
}

// GnuGo难度映射
function getGnuGoLevel(difficulty: string): number {
  if (difficulty === "easy") return 3;
  if (difficulty === "medium") return 7;
  return 10;
}

// 使用KataGo引擎获取AI落子
async function getKataGoMove(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: string }>,
  difficulty: string
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string }> {
  const komi = getKomi(boardSize);
  const maxVisits = getKataGoVisits(difficulty);

  // 启动KataGo进程
  const proc = spawn(KATAGO_PATH, [
    "gtp",
    "-model", KATAGO_MODEL,
    "-config", KATAGO_CONFIG,
    "-override-config", `maxVisits=${maxVisits},komi=${komi}`,
  ]);

  // KataGo启动较慢，需要更长等待时间
  await new Promise(r => setTimeout(r, 500));

  const gtpCommands: string[] = [
    `boardsize ${boardSize}`,
    "clear_board",
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
  gtpCommands.push("genmove W");

  try {
    // KataGo CPU模式下可能较慢，给予更长超时
    const responses = await sendMultipleGTP(proc, gtpCommands, 60000);

    // 解析genmove响应
    const lastResponse = responses[responses.length - 1];
    const moveMatch = lastResponse.match(/=\s*([A-HJ-T]\d+|PASS|resign)/i);

    if (!moveMatch) {
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, pass: true, engine: "katago" };
    }

    const moveStr = moveMatch[1].toUpperCase();

    if (moveStr === "PASS") {
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, pass: true, engine: "katago" };
    }

    if (moveStr === "RESIGN") {
      proc.stdin?.write("quit\n");
      proc.kill();
      return { move: null, resign: true, engine: "katago" };
    }

    const position = gtpToBoardCoord(moveStr, boardSize);
    proc.stdin?.write("quit\n");
    proc.kill();

    if (!position) {
      throw new Error("无法解析KataGo落子坐标");
    }

    return { move: position, engine: "katago" };
  } catch (gtpError) {
    proc.kill();
    throw gtpError;
  }
}

// 使用GnuGo引擎获取AI落子（回退方案）
async function getGnuGoMove(
  boardSize: number,
  moves: Array<{ row: number; col: number; color: string }>,
  difficulty: string
): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine: string }> {
  const komi = getKomi(boardSize);
  const gnugoLevel = getGnuGoLevel(difficulty);

  const proc = spawn(GNUGO_PATH, [
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

  gtpCommands.push("genmove W");

  try {
    const responses = await sendMultipleGTP(proc, gtpCommands);

    const lastResponse = responses[responses.length - 1];
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

export async function POST(request: NextRequest) {
  try {
    const { boardSize, moves, difficulty } = await request.json();

    // 优先使用KataGo（强得多），不可用时回退GnuGo
    if (isKataGoAvailable()) {
      try {
        const result = await getKataGoMove(boardSize, moves, difficulty);
        return NextResponse.json(result);
      } catch (katagoError) {
        console.error("KataGo failed, falling back to GnuGo:", katagoError);
        // KataGo失败，回退GnuGo
      }
    }

    // 回退到GnuGo
    try {
      const result = await getGnuGoMove(boardSize, moves, difficulty);
      return NextResponse.json(result);
    } catch (gtpError) {
      console.error("GTP error:", gtpError);
      return NextResponse.json({ error: "所有引擎通信失败" }, { status: 500 });
    }
  } catch (error) {
    console.error("Go engine API error:", error);
    return NextResponse.json({ error: "引擎错误" }, { status: 500 });
  }
}
