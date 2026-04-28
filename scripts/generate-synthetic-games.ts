#!/usr/bin/env tsx
/**
 * 生成合成 9x9 / 13x13 SGF 棋谱，用于填充小棋盘向量知识库
 *
 * 策略：基于标准开局 + 随机合法后续着法，生成看起来像真实对局的序列
 * 运行：npx tsx scripts/generate-synthetic-games.ts
 */

import fs from 'fs';
import path from 'path';
import { createEmptyBoard, playMove, getBoardSize, type Stone } from '../src/lib/go-logic';

interface GameConfig {
  boardSize: number;
  moveCount: number; // 目标手数
  count: number;     // 生成局数
}

const CONFIGS: GameConfig[] = [
  { boardSize: 9, moveCount: 40, count: 50 },
  { boardSize: 13, moveCount: 60, count: 50 },
];

const OUT_DIR = './data/sgf/synthetic';

/** 标准开局（增加真实感） */
const OPENINGS_9x9: Array<Array<[number, number]>> = [
  [[4, 4]], // 天元
  [[2, 2]], // 3-3
  [[2, 6]], // 3-3
  [[6, 2]], // 3-3
  [[6, 6]], // 3-3
  [[4, 4], [3, 3]], // 天元 + 小目
  [[4, 4], [5, 5]], // 天元 + 小目
  [[2, 2], [6, 6]], // 双三三
  [[2, 6], [6, 2]], // 双三三
  [[4, 2]], // 高目
  [[2, 4]], // 高目
];

const OPENINGS_13x13: Array<Array<[number, number]>> = [
  [[3, 3]], // 星位
  [[3, 9]], // 星位
  [[9, 3]], // 星位
  [[9, 9]], // 星位
  [[6, 6]], // 天元
  [[3, 3], [9, 9]], // 对角星
  [[3, 9], [9, 3]], // 对角星
  [[3, 3], [3, 9]], // 二连星
  [[9, 3], [9, 9]], // 二连星
  [[3, 3], [6, 6]], // 星 + 天元
  [[2, 5]], // 小目
  [[5, 2]], // 小目
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

  // 随机后续着法：收集所有空点再随机选择
  while (moves.length < targetMoves) {
    const emptyPoints: Array<[number, number]> = [];
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        if (board[r][c] === null) {
          emptyPoints.push([r, c]);
        }
      }
    }

    if (emptyPoints.length === 0) break;

    const [r, c] = emptyPoints[Math.floor(Math.random() * emptyPoints.length)];
    const result = playMove(board, r, c, currentColor);
    board = result.newBoard;
    moves.push({ color: currentColor, row: r, col: c });
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
    console.log(`[gen] Generating ${config.count} ${config.boardSize}x${config.boardSize} games...`);
    for (let i = 0; i < config.count; i++) {
      const sgf = generateGame(config.boardSize, config.moveCount);
      const fileName = `synthetic_${config.boardSize}x${config.boardSize}_${i}.sgf`;
      fs.writeFileSync(path.join(OUT_DIR, fileName), sgf, 'utf-8');
    }
    console.log(`[gen] Done: ${config.count} games`);
  }

  console.log(`[gen] All synthetic games saved to ${OUT_DIR}`);
}

main();
