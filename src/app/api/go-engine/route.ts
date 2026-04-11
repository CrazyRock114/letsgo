// GTP桥接API - 与GnuGo围棋AI引擎通信
// GnuGo通过GTP(Go Text Protocol)协议交互，spawn子进程通信

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

// GnuGo可执行文件路径
const GNUGO_PATH = "/usr/games/gnugo";

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
function sendGTPCommand(proc: ReturnType<typeof spawn>, command: string): Promise<string> {
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
    }, 30000);

    proc.stdin?.write(command + "\n");
  });
}

// 批量发送GTP命令
async function sendMultipleGTP(
  proc: ReturnType<typeof spawn>,
  commands: string[]
): Promise<string[]> {
  const results: string[] = [];
  for (const cmd of commands) {
    const resp = await sendGTPCommand(proc, cmd);
    results.push(resp);
  }
  return results;
}

export async function POST(request: NextRequest) {
  try {
    const { boardSize, moves, difficulty } = await request.json();

    // GnuGo难度映射
    // GnuGo level 1-10，1最弱10最强
    let gnugoLevel: number;
    if (difficulty === "easy") {
      gnugoLevel = 3;
    } else if (difficulty === "medium") {
      gnugoLevel = 7;
    } else {
      gnugoLevel = 10;
    }

    // 启动GnuGo进程
    const proc = spawn(GNUGO_PATH, [
      "--mode", "gtp",
      "--level", String(gnugoLevel),
      "--boardsize", String(boardSize),
      "--komi", String(boardSize <= 9 ? 2.5 : boardSize <= 13 ? 3.5 : 6.5),
      "--chinese-rules", // 中国规则
    ]);

    // 等待进程启动
    await new Promise(r => setTimeout(r, 200));

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
      const responses = await sendMultipleGTP(proc, gtpCommands);

      // 解析genmove响应
      const lastResponse = responses[responses.length - 1];
      // GTP响应格式: "= G4" 或 "= PASS" 或 "= resign"
      const moveMatch = lastResponse.match(/=\s*([A-HJ-T]\d+|PASS|resign)/i);

      if (!moveMatch) {
        // GnuGo无法落子
        proc.stdin?.write("quit\n");
        proc.kill();
        return NextResponse.json({ move: null, pass: true });
      }

      const moveStr = moveMatch[1].toUpperCase();

      if (moveStr === "PASS") {
        proc.stdin?.write("quit\n");
        proc.kill();
        return NextResponse.json({ move: null, pass: true });
      }

      if (moveStr === "RESIGN") {
        proc.stdin?.write("quit\n");
        proc.kill();
        return NextResponse.json({ move: null, resign: true });
      }

      const position = gtpToBoardCoord(moveStr, boardSize);

      proc.stdin?.write("quit\n");
      proc.kill();

      if (!position) {
        return NextResponse.json({ error: "无法解析AI落子" }, { status: 500 });
      }

      return NextResponse.json({ move: position });
    } catch (gtpError) {
      proc.kill();
      console.error("GTP error:", gtpError);
      return NextResponse.json({ error: "GnuGo通信失败" }, { status: 500 });
    }
  } catch (error) {
    console.error("Go engine API error:", error);
    return NextResponse.json({ error: "引擎错误" }, { status: 500 });
  }
}
