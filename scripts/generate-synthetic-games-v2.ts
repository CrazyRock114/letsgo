#!/usr/bin/env tsx
/**
 * 生成合成 9x9 / 13x13 SGF 棋谱 v2 —— 加权随机策略
 *
 * 改进点：
 * 1. 后续着法使用加权随机而非纯随机
 * 2. 权重考虑：靠近棋子 > 角落/边 > 中腹，连接己方加分，切断对方加分
 * 3. 避免自杀（不填自己最后一口气）
 *
 * 运行：npx tsx scripts/generate-synthetic-games-v2.ts
 */

import fs from 'fs';
import path from 'path';
import { createEmptyBoard, playMove, getBoardSize, getConnectedStones, getGroupLiberties, type Stone } from '../src/lib/go-logic';

interface GameConfig {
  boardSize: number;
  moveCount: number;
  count: number;
}

const CONFIGS: GameConfig[] = [
  { boardSize: 9, moveCount: 40, count: 50 },
  { boardSize: 13, moveCount: 60, count: 50 },
];

const OUT_DIR = './data/sgf/synthetic';

/** 标准开局 */
const OPENINGS_9x9: Array<Array<[number, number]>> = [
  [[4, 4]],
  [[2, 2]], [[2, 6]], [[6, 2]], [[6, 6]],
  [[4, 4], [3, 3]],
  [[4, 4], [5, 5]],
  [[2, 2], [6, 6]],
  [[2, 6], [6, 2]],
  [[4, 2]], [[2, 4]], [[6, 4]], [[4, 6]],
];

const OPENINGS_13x13: Array<Array<[number, number]>> = [
  [[3, 3]], [[3, 9]], [[9, 3]], [[9, 9]],
  [[6, 6]],
  [[3, 3], [9, 9]],
  [[3, 9], [9, 3]],
  [[3, 3], [3, 9]],
  [[9, 3], [9, 9]],
  [[3, 3], [6, 6]],
  [[2, 5]], [[5, 2]], [[9, 5]], [[5, 9]],
  [[3, 6]], [[6, 3]], [[9, 6]], [[6, 9]],
];

function getRandomOpening(boardSize: number): Array<[number, number]> {
  const openings = boardSize === 9 ? OPENINGS_9x9 : OPENINGS_13x13;
  return openings[Math.floor(Math.random() * openings.length)];
}

function formatSgfCoord(row: number, col: number): string {
  const colChar = String.fromCharCode('a'.charCodeAt(0) + col);
  const rowChar = String.fromCharCode('a'.charCodeAt(0) + row);
  return colChar + rowChar;
}

/** 计算位置权重（越高越可能被选中） */
function computeMoveWeight(
  board: ReturnType<typeof createEmptyBoard>,
  row: number,
  col: number,
  color: Stone,
  size: number
): number {
  let weight = 1.0;

  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  // 1. 区域偏好：角落 > 边 > 中腹
  const cornerDist = Math.min(
    row + col,
    row + (size - 1 - col),
    (size - 1 - row) + col,
    (size - 1 - row) + (size - 1 - col)
  );
  if (cornerDist <= 2) weight += 3.0;
  else if (cornerDist <= 4) weight += 1.5;
  else if (row === 0 || row === size - 1 || col === 0 || col === size - 1) weight += 0.5;

  // 2. 靠近已有棋子加分
  let nearStones = 0;
  let friendlyNeighbors = 0;
  let opponentNeighbors = 0;
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] !== null) {
      nearStones++;
      if (board[nr][nc] === color) friendlyNeighbors++;
      else opponentNeighbors++;
    }
  }
  weight += nearStones * 1.5;

  // 3. 连接己方棋子加分
  weight += friendlyNeighbors * 2.0;

  // 4. 靠近对方棋子（有战斗机会）加分
  weight += opponentNeighbors * 0.8;

  // 5. 中心附近（小棋盘中心重要）
  const centerDist = Math.abs(row - (size - 1) / 2) + Math.abs(col - (size - 1) / 2);
  if (centerDist <= 2) weight += 1.0;

  // 6. 避免太远的随机落子（保持局部战斗）
  if (nearStones === 0) weight *= 0.3;

  return weight;
}

/** 检查是否合法且不自杀 */
function isValidMove(
  board: ReturnType<typeof createEmptyBoard>,
  row: number,
  col: number,
  color: Stone
): boolean {
  const size = getBoardSize(board);
  if (row < 0 || row >= size || col < 0 || col >= size) return false;
  if (board[row][col] !== null) return false;

  // 尝试落子，检查是否自杀
  try {
    const result = playMove(board, row, col, color);
    // 如果提子数为0且落子后该棋块只有1气，可能是自杀（但打吃是合法的）
    // 更简单的：如果 playMove 成功（提子或正常落子），就接受
    // playMove 在完全自杀时会返回原棋盘（没有变化）
    // 但我们的 playMove 实现可能不检测自杀...
    // 这里用 liberties 来判断
    if (result.captured === 0) {
      const libs = getGroupLiberties(result.newBoard, row, col);
      if (libs === 0) return false; // 自杀
    }
    return true;
  } catch {
    return false;
  }
}

function generateGame(boardSize: number, targetMoves: number): string {
  let board = createEmptyBoard(boardSize);
  const moves: Array<{ color: Stone; row: number; col: number }> = [];

  // 先下开局
  const opening = getRandomOpening(boardSize);
  let currentColor: Stone = 'black';

  for (const [r, c] of opening) {
    if (r >= 0 && r < boardSize && c >= 0 && c < boardSize && board[r][c] === null) {
      const result = playMove(board, r, c, currentColor);
      board = result.newBoard;
      moves.push({ color: currentColor, row: r, col: c });
      currentColor = currentColor === 'black' ? 'white' : 'black';
    }
  }

  // 加权随机后续着法
  while (moves.length < targetMoves) {
    const candidates: Array<{ r: number; c: number; weight: number }> = [];

    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        if (board[r][c] === null && isValidMove(board, r, c, currentColor)) {
          const weight = computeMoveWeight(board, r, c, currentColor, boardSize);
          candidates.push({ r, c, weight });
        }
      }
    }

    if (candidates.length === 0) break;

    // 加权随机选择
    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    let random = Math.random() * totalWeight;
    let selected = candidates[0];
    for (const cand of candidates) {
      random -= cand.weight;
      if (random <= 0) {
        selected = cand;
        break;
      }
    }

    const result = playMove(board, selected.r, selected.c, currentColor);
    board = result.newBoard;
    moves.push({ color: currentColor, row: selected.r, col: selected.c });
    currentColor = currentColor === 'black' ? 'white' : 'black';
  }

  // 生成 SGF
  const sgfMoves = moves.map(m => {
    const coord = formatSgfCoord(m.row, m.col);
    const prop = m.color === 'black' ? 'B' : 'W';
    return `;${prop}[${coord}]`;
  }).join('');

  return `(;GM[1]FF[4]SZ[${boardSize}]KM[${boardSize === 9 ? 7.0 : 7.5}]PB[Synthetic]PW[Synthetic]RE[?]\n${sgfMoves})`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const config of CONFIGS) {
    console.log(`[gen-v2] Generating ${config.count} ${config.boardSize}x${config.boardSize} games (weighted random)...`);
    for (let i = 0; i < config.count; i++) {
      const sgf = generateGame(config.boardSize, config.moveCount);
      const fileName = `synthetic_v2_${config.boardSize}x${config.boardSize}_${i}.sgf`;
      fs.writeFileSync(path.join(OUT_DIR, fileName), sgf, 'utf-8');
    }
    console.log(`[gen-v2] Done: ${config.count} games`);
  }

  console.log(`[gen-v2] All synthetic games saved to ${OUT_DIR}`);
}

main();
