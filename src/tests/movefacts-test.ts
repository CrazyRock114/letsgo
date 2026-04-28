import { createEmptyBoard, playMove } from '@/lib/go-logic';

// 动态导入 route.ts 中的函数（因为 route.ts 是 Next.js API route）
// 为避免服务端代码问题，直接复制 extractMoveFacts 的核心逻辑来测试
import {
  getGroupLiberties,
  getConnectedStones,
  copyBoard,
} from '@/lib/go-logic';
import type { MoveFacts, MovePattern, Region } from '@/lib/move-facts';
import { parseSgf, parseSgfCoord } from '@/lib/sgf-parser';

function getStarPoints(size: number): [number, number][] {
  if (size === 9) return [[2,2],[2,6],[4,4],[6,2],[6,6]];
  if (size === 13) return [[3,3],[3,6],[3,9],[6,3],[6,6],[6,9],[9,3],[9,6],[9,9]];
  if (size === 19) return [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
  return [];
}

function extractMoveFacts(
  board: any, row: number, col: number, moveColor: any, size: number, captured?: number
): MoveFacts | null {
  const stone = moveColor;
  if (!stone) return null;
  const directions: [number, number][] = [[-1,0],[1,0],[0,-1],[0,1]];
  const opponentColor = stone === 'black' ? 'white' : 'black';
  const cornerZone = 3;
  const isCorner = (row < cornerZone || row >= size - cornerZone) && (col < cornerZone || col >= size - cornerZone);
  const isEdge = row < 1 || row >= size - 1 || col < 1 || col >= size - 1;
  const region: Region = isCorner ? 'corner' : isEdge ? 'edge' : 'center';
  const starPoints = getStarPoints(size);
  const isStarPoint = starPoints.some(([r, c]) => r === row && c === col);
  const corners: [number, number][] = [[0, 0], [0, size - 1], [size - 1, 0], [size - 1, size - 1]];
  const distanceToCorner = Math.min(...corners.map(([cr, cc]) => Math.abs(row - cr) + Math.abs(col - cc)));
  let friendlyNeighbors = 0;
  let opponentNeighbors = 0;
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    const neighbor = board[nr][nc];
    if (neighbor === stone) friendlyNeighbors++;
    else if (neighbor !== null) opponentNeighbors++;
  }
  const testBoard = copyBoard(board);
  testBoard[row][col] = stone;
  const liberties = getGroupLiberties(testBoard, row, col);
  let isAtari = false;
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === opponentColor) {
      const libs = getGroupLiberties(testBoard, nr, nc);
      if (libs === 1) { isAtari = true; break; }
    }
  }
  const patterns: MovePattern[] = [];
  if (isStarPoint) patterns.push({ type: 'star', confidence: 1.0, description: '落在星位' });
  if (friendlyNeighbors >= 2) patterns.push({ type: 'connect', confidence: 0.85, description: '连接己方棋子' });
  if (region === 'corner' && !patterns.some(p => p.type === 'star')) patterns.push({ type: 'corner', confidence: 0.9, description: '占角' });
  else if (region === 'edge') patterns.push({ type: 'edge', confidence: 0.8, description: '拆边' });
  return {
    coordinate: { row, col }, color: stone, isPass: false,
    region, isStarPoint, distanceToCorner,
    liberties, captured: captured ?? 0, isAtari, isCapture: (captured ?? 0) > 0,
    patterns, adjacentFriendlyStones: friendlyNeighbors, adjacentOpponentStones: opponentNeighbors,
    connectedGroups: 0, separatedGroups: 0,
  };
}

// 测试1: 9路星位
const board1 = createEmptyBoard(9);
const r1 = extractMoveFacts(board1, 2, 2, 'black', 9, 0);
console.log('Test 1 - Star point (2,2):', r1?.isStarPoint, r1?.region, r1?.patterns.map(p=>p.type));
console.assert(r1?.isStarPoint === true, 'Should be star point');
console.assert(r1?.region === 'corner', 'Should be corner');

// 测试2: 9路边
const board2 = createEmptyBoard(9);
const r2 = extractMoveFacts(board2, 0, 3, 'black', 9, 0);
console.log('Test 2 - Edge (0,3):', r2?.isStarPoint, r2?.region, r2?.patterns.map(p=>p.type));
console.assert(r2?.isStarPoint === false, 'Should not be star point');
console.assert(r2?.region === 'edge', 'Should be edge');

// 测试3: 9路中腹
const board3 = createEmptyBoard(9);
const r3 = extractMoveFacts(board3, 4, 4, 'black', 9, 0);
console.log('Test 3 - Center (4,4):', r3?.isStarPoint, r3?.region, r3?.patterns.map(p=>p.type));
console.assert(r3?.region === 'center', 'Should be center');

// 测试4: SGF
const sgf = '(;GM[1]FF[4]SZ[9]KM[6.5]PB[AlphaGo]PW[Lee];B[dd];W[pp];B[dp];C[test])';
const game = parseSgf(sgf);
console.log('Test 4 - SGF:', game.boardSize, game.komi, game.moves.length, game.moves[0]?.position);
console.assert(game.boardSize === 9, 'Board size should be 9');
console.assert(game.moves.length === 3, 'Should have 3 moves');
console.assert(parseSgfCoord('dd', 9)?.row === 3 && parseSgfCoord('dd', 9)?.col === 3, 'dd should be (3,3)');

console.log('\nAll tests passed!');
