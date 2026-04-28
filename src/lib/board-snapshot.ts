import type { Board, Position, Stone } from './go-logic';
import type { BoardSnapshot, MoveFacts, MovePattern, Region, ParsedGame } from './move-facts';
import { getBoardSize, getGroupLiberties, getConnectedStones, playMove, copyBoard } from './go-logic';

// ─── 星位坐标（复用 go-ai/route.ts 中的逻辑）───

function getStarPoints(size: number): [number, number][] {
  if (size === 9) {
    return [[2,2],[2,6],[4,4],[6,2],[6,6]];
  }
  if (size === 13) {
    return [[3,3],[3,6],[3,9],[6,3],[6,6],[6,9],[9,3],[9,6],[9,9]];
  }
  if (size === 19) {
    return [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
  }
  return [];
}

// ─── 区域判断 ───

function getRegion(row: number, col: number, size: number): Region {
  const cornerZone = size <= 9 ? 3 : 4; // 角部范围：9路3线以内，13/19路4线以内
  const rowInCornerRange = row < cornerZone || row >= size - cornerZone;
  const colInCornerRange = col < cornerZone || col >= size - cornerZone;
  const isCorner = rowInCornerRange && colInCornerRange;
  if (isCorner) return 'corner';

  const isEdge = (rowInCornerRange || colInCornerRange) && !isCorner;
  if (isEdge) return 'edge';

  return 'center';
}

function getSubRegion(row: number, col: number, size: number): string {
  const region = getRegion(row, col, size);
  if (region === 'center') return '中腹';

  const v = row < size / 2 ? '上' : '下';
  const h = col < size / 2 ? '左' : '右';

  if (region === 'corner') {
    return `${v}${h}角`;
  }
  // edge
  if (row < 2 || row >= size - 2) return `${v}边`;
  return `${h}边`;
}

function distanceToCorner(row: number, col: number, size: number): number {
  const corners: [number, number][] = [[0, 0], [0, size - 1], [size - 1, 0], [size - 1, size - 1]];
  return Math.min(...corners.map(([cr, cc]) => Math.abs(row - cr) + Math.abs(col - cc)));
}

// ─── 棋盘统计 ───

function countStones(board: Board): { total: number; black: number; white: number } {
  const size = getBoardSize(board);
  let black = 0;
  let white = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === 'black') black++;
      else if (board[r][c] === 'white') white++;
    }
  }
  return { total: black + white, black, white };
}

// ─── 邻接信息 ───

interface AdjacentInfo {
  friendly: number;
  opponent: number;
  connectedGroups: number;
  separatedGroups: number;
  liberties: number;
}

function getAdjacentInfo(board: Board, row: number, col: number, color: Stone): AdjacentInfo {
  const size = getBoardSize(board);
  const directions = [[-1,0],[1,0],[0,-1],[0,1]];
  let friendly = 0;
  let opponent = 0;
  const friendlyGroups = new Set<string>();
  const opponentGroups = new Set<string>();

  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    const stone = board[nr][nc];
    if (stone === color) {
      friendly++;
      friendlyGroups.add(`${nr},${nc}`);
    } else if (stone !== null) {
      opponent++;
      opponentGroups.add(`${nr},${nc}`);
    }
  }

  // 计算连接的己方棋块数（去重）
  const connectedGroupKeys = new Set<string>();
  for (const key of friendlyGroups) {
    const [r, c] = key.split(',').map(Number);
    const group = getConnectedStones(board, r, c);
    // 用排序后的第一个位置作为棋块标识
    const sorted = Array.from(group).sort();
    connectedGroupKeys.add(sorted[0]);
  }

  // 计算切断的对方棋块数（去重）
  const separatedGroupKeys = new Set<string>();
  for (const key of opponentGroups) {
    const [r, c] = key.split(',').map(Number);
    const group = getConnectedStones(board, r, c);
    const sorted = Array.from(group).sort();
    separatedGroupKeys.add(sorted[0]);
  }

  // 计算落子后的气数（需要模拟落子）
  const testBoard = copyBoard(board);
  testBoard[row][col] = color;
  const liberties = getGroupLiberties(testBoard, row, col);

  return {
    friendly,
    opponent,
    connectedGroups: connectedGroupKeys.size,
    separatedGroups: separatedGroupKeys.size,
    liberties,
  };
}

// ─── 棋型识别（从 recognizePatterns 中提取的结构化逻辑）───

function detectPatterns(
  board: Board,
  row: number,
  col: number,
  color: Stone,
  size: number
): MovePattern[] {
  const patterns: MovePattern[] = [];
  if (!color) return patterns;

  const opponentColor = color === 'black' ? 'white' : 'black';
  const starPoints = getStarPoints(size);

  // 1. 星位
  const isStar = starPoints.some(([r, c]) => r === row && c === col);
  if (isStar) {
    patterns.push({ type: 'star', confidence: 1.0, description: '落在星位' });
  }

  // 2. 挂角（必须是斜对角相邻对方星位棋子）
  const diagonalDirections = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr, dc] of diagonalDirections) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === opponentColor) {
      const isOppStar = starPoints.some(([r, c]) => r === nr && c === nc);
      if (isOppStar) {
        patterns.push({ type: 'approach', confidence: 0.9, description: '挂角' });
        break;
      }
    }
  }

  // 2b. 碰/压（正交相邻对方棋子）
  const orthogonalDirections = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr, dc] of orthogonalDirections) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === opponentColor) {
      patterns.push({ type: 'approach', confidence: 0.7, description: '靠近对方棋子' });
      break;
    }
  }

  // 3. 连接
  let friendlyNeighbors = 0;
  for (const [dr, dc] of orthogonalDirections) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === color) {
      friendlyNeighbors++;
    }
  }
  if (friendlyNeighbors >= 2) {
    patterns.push({ type: 'connect', confidence: 0.85, description: '连接己方棋子' });
  }

  // 4. 切断
  const checkedOppGroups = new Set<string>();
  let adjacentOppGroups = 0;
  for (const [dr, dc] of orthogonalDirections) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === opponentColor) {
      const group = getConnectedStones(board, nr, nc);
      const key = Array.from(group).sort()[0] as string;
      if (!checkedOppGroups.has(key)) {
        checkedOppGroups.add(key);
        adjacentOppGroups++;
      }
    }
  }
  if (adjacentOppGroups >= 2) {
    patterns.push({ type: 'cut', confidence: 0.9, description: '切断对方棋子' });
  }

  // 5. 做眼
  const emptyNeighbors: [number, number][] = [];
  for (const [dr, dc] of orthogonalDirections) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === null) {
      emptyNeighbors.push([nr, nc]);
    }
  }
  const surrounded = emptyNeighbors.length <= 1 && friendlyNeighbors >= 2;
  if (surrounded && emptyNeighbors.length === 1) {
    const [er, ec] = emptyNeighbors[0];
    let fullySurrounded = true;
    for (const [dr, dc] of orthogonalDirections) {
      const nr = er + dr;
      const nc = ec + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
        if (board[nr][nc] !== color && !(nr === row && nc === col)) {
          fullySurrounded = false;
          break;
        }
      }
    }
    if (fullySurrounded) {
      patterns.push({ type: 'eye', confidence: 0.8, description: '做眼' });
    }
  }

  // 6. 边角占位
  const region = getRegion(row, col, size);
  if (region === 'corner' && !patterns.some(p => p.type === 'star' || p.type === 'approach')) {
    patterns.push({ type: 'corner', confidence: 0.9, description: '占角' });
  } else if (region === 'edge' && !patterns.some(p => p.type === 'approach')) {
    patterns.push({ type: 'edge', confidence: 0.8, description: '拆边' });
  }

  return patterns;
}

// ─── 打吃检测 ───

function checkAtari(board: Board, row: number, col: number, color: Stone): boolean {
  if (!color) return false;
  const size = getBoardSize(board);
  const opponent = color === 'black' ? 'white' : 'black';
  const directions = [[-1,0],[1,0],[0,-1],[0,1]];

  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === opponent) {
      // 模拟落子后检查对方棋块的气数
      const testBoard = copyBoard(board);
      testBoard[row][col] = color;
      const libs = getGroupLiberties(testBoard, nr, nc);
      if (libs === 1) {
        return true;
      }
    }
  }
  return false;
}

// ─── 战术棋型检测 ───

/**
 * 检测：这步棋是否解救了被打吃（只剩1气）的己方棋子
 * 思路：把当前落子移除，检查邻接的己方棋子组是否只剩1气；
 *       如果只剩1气，说明落子前被打吃，落子后解救了
 */
function checkEscapedAtari(board: Board, row: number, col: number, color: Stone): boolean {
  if (!color) return false;
  const size = getBoardSize(board);
  const { getConnectedStones, getGroupLiberties } = require('./go-logic');

  // 构建落子前的棋盘（移除当前落子）
  const beforeBoard = copyBoard(board);
  beforeBoard[row][col] = null;

  const directions = [[-1,0],[1,0],[0,-1],[0,1]];
  const checkedGroups = new Set<string>();

  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    if (beforeBoard[nr][nc] !== color) continue;

    const group = getConnectedStones(beforeBoard, nr, nc);
    const key = Array.from(group).sort()[0] as string;
    if (checkedGroups.has(key)) continue;
    checkedGroups.add(key);

    const libsBefore = getGroupLiberties(beforeBoard, nr, nc);
    if (libsBefore <= 1) {
      // 落子前只剩1气，说明这步棋解救了这个组
      return true;
    }
  }
  return false;
}

/**
 * 检测：这步棋是否把自己新落的棋子放入了打吃（只剩1气）
 */
function checkSelfAtari(board: Board, row: number, col: number, color: Stone): boolean {
  if (!color) return false;
  const libs = getGroupLiberties(board, row, col);
  return libs <= 1;
}

/**
 * 检测：这步棋是否造成双打吃（同时让两个不同的对方棋子组各只剩1气）
 */
function checkDoubleAtari(board: Board, row: number, col: number, color: Stone): boolean {
  if (!color) return false;
  const size = getBoardSize(board);
  const opponent = color === 'black' ? 'white' : 'black';
  const { getConnectedStones, getGroupLiberties } = require('./go-logic');

  const directions = [[-1,0],[1,0],[0,-1],[0,1]];
  const checkedGroups = new Set<string>();
  let atariCount = 0;

  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    if (board[nr][nc] !== opponent) continue;

    const group = getConnectedStones(board, nr, nc);
    const key = Array.from(group).sort()[0] as string;
    if (checkedGroups.has(key)) continue;
    checkedGroups.add(key);

    const libs = getGroupLiberties(board, nr, nc);
    if (libs <= 1) {
      atariCount++;
    }
  }
  return atariCount >= 2;
}

/**
 * 检测：是否倒扑
 * 简化判断：当前落子紧邻对方棋子，且落子后当前棋子只剩1气，
 * 但对方吃子后会被反吃更多（需要检查对方提子后，是否有邻接的己方棋子组可以反提）
 * 这是一个简化版，只检查最基本的倒扑形态
 */
function checkSnapback(board: Board, row: number, col: number, color: Stone): boolean {
  if (!color) return false;
  const size = getBoardSize(board);
  const opponent = color === 'black' ? 'white' : 'black';
  const { getConnectedStones, getGroupLiberties, copyBoard } = require('./go-logic');

  // 条件1：落子后自己只剩1气（诱敌来吃）
  const selfLibs = getGroupLiberties(board, row, col);
  if (selfLibs > 1) return false;

  const directions = [[-1,0],[1,0],[0,-1],[0,1]];

  // 条件2：紧邻恰好1个对方的棋子组（且该组也只剩1气，即可以被提）
  let targetGroup: string[] | null = null;
  const checkedGroups = new Set<string>();

  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    if (board[nr][nc] !== opponent) continue;

    const group = getConnectedStones(board, nr, nc);
    const key = Array.from(group).sort()[0] as string;
    if (checkedGroups.has(key)) continue;
    checkedGroups.add(key);

    const oppLibs = getGroupLiberties(board, nr, nc);
    if (oppLibs <= 1) {
      if (targetGroup !== null) return false; // 多于1个目标，不是标准倒扑
      targetGroup = (Array.from(group) as string[]).map(k => {
        const [r, c] = k.split(',').map(Number);
        return `${r},${c}`;
      });
    }
  }

  if (!targetGroup || targetGroup.length === 0) return false;

  // 条件3：对方提掉这1个子后，会有邻接的己方棋子组可以反提对方更多子
  // 模拟对方提子后的棋盘
  const simBoard = copyBoard(board);
  for (const key of targetGroup) {
    const [r, c] = key.split(',').map(Number);
    simBoard[r][c] = null;
  }
  // 同时移除自己那颗诱敌的棋子（被提）
  simBoard[row][col] = null;

  // 检查是否有邻接的己方棋子组在新棋盘上可以吃掉对方更多子
  // 简化：检查是否有己方棋子组在提子后气数增加，可以反提
  // 实际上倒扑的核心是：对方吃掉1个子后，自己可以通过打吃对方更大的组来获利
  // 这里简化检查：看是否有邻接的己方棋子在模拟后可以对对方形成威胁

  // 检查落子位置周围的己方棋子组在模拟后的气数
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
    if (simBoard[nr][nc] !== color) continue;

    const group = getConnectedStones(simBoard, nr, nc);
    const libs = getGroupLiberties(simBoard, nr, nc);
    // 如果己方棋子组气数>=2，且能接触到对方棋子，认为倒扑成立
    if (libs >= 2) {
      return true;
    }
  }

  return false;
}

// ─── 公共 API ───

/**
 * 生成单步棋盘快照
 * @param board 落子后的棋盘状态
 * @param history 截至当前的全部落子历史（用于统计提子数）
 * @param moveIndex 当前手数（0-based）
 * @param gameMeta 对局元数据（可选）
 * @param kataGoData KataGo 分析数据（可选）
 */
export function generateSnapshot(
  board: Board,
  history: { position: Position; color: Stone; captured: number }[],
  moveIndex: number,
  gameMeta?: BoardSnapshot['gameMeta'],
  kataGoData?: { winRate?: number; scoreLead?: number; bestMoves?: BoardSnapshot['bestMoves'] }
): BoardSnapshot {
  const move = history[moveIndex];
  if (!move || !move.color) {
    throw new Error(`Invalid move at index ${moveIndex}`);
  }

  const size = getBoardSize(board);
  const { row, col } = move.position;
  const color = move.color;
  const isPass = row < 0 || row >= size || col < 0 || col >= size;

  // 棋盘统计（基于落子后的棋盘）
  const stones = countStones(board);

  // 累积提子数
  let blackCaptures = 0;
  let whiteCaptures = 0;
  for (let i = 0; i <= moveIndex; i++) {
    const m = history[i];
    if (m.color === 'black') blackCaptures += m.captured;
    else if (m.color === 'white') whiteCaptures += m.captured;
  }

  // 邻接信息与棋型（pass 时不计算）
  let adjInfo: AdjacentInfo | undefined;
  let patterns: MovePattern[] = [];
  let isAtari = false;

  if (!isPass) {
    adjInfo = getAdjacentInfo(board, row, col, color);
    patterns = detectPatterns(board, row, col, color, size);
    isAtari = checkAtari(board, row, col, color);
  }

  const region = isPass ? 'center' : getRegion(row, col, size);
  const subRegion = isPass ? '停一手' : getSubRegion(row, col, size);
  const isStarPoint = !isPass && getStarPoints(size).some(([r, c]) => r === row && c === col);

  const snapshot: BoardSnapshot = {
    boardSize: size,
    moveNumber: moveIndex + 1,
    color,
    coordinate: move.position,
    isPass,
    region,
    subRegion,
    isStarPoint,
    distanceToCorner: isPass ? 0 : distanceToCorner(row, col, size),
    totalStones: stones.total,
    blackStones: stones.black,
    whiteStones: stones.white,
    blackCaptures,
    whiteCaptures,
    patterns,
    liberties: adjInfo?.liberties ?? 0,
    captured: move.captured,
    isAtari,
    isCapture: move.captured > 0,
    adjacentFriendlyStones: adjInfo?.friendly ?? 0,
    adjacentOpponentStones: adjInfo?.opponent ?? 0,
    connectedGroups: adjInfo?.connectedGroups ?? 0,
    separatedGroups: adjInfo?.separatedGroups ?? 0,
    description: '', // 稍后生成
    winRate: kataGoData?.winRate,
    scoreLead: kataGoData?.scoreLead,
    bestMoves: kataGoData?.bestMoves,
    gameMeta,
  };

  snapshot.description = generateDescription(snapshot);
  return snapshot;
}

/**
 * 从当前棋盘状态提取单步 MoveFacts（用于 go-ai 解说）
 * 复用内部检测逻辑，返回结构化事实骨架
 */
export function extractMoveFacts(
  board: Board,
  row: number,
  col: number,
  color: 'black' | 'white',
  captured: number,
  kataGoData?: { winRate?: number; scoreLead?: number; bestMoves?: BoardSnapshot['bestMoves'] }
): MoveFacts {
  const size = getBoardSize(board);
  const isPass = row < 0 || row >= size || col < 0 || col >= size;

  // Pass move：返回最小化的事实骨架
  if (isPass) {
    return {
      coordinate: { row, col },
      color,
      isPass: true,
      region: 'center',
      isStarPoint: false,
      distanceToCorner: 0,
      liberties: 0,
      captured: 0,
      isAtari: false,
      isCapture: false,
      patterns: [],
      adjacentFriendlyStones: 0,
      adjacentOpponentStones: 0,
      connectedGroups: 0,
      separatedGroups: 0,
      winRate: kataGoData?.winRate,
      scoreLead: kataGoData?.scoreLead,
      bestMoves: kataGoData?.bestMoves,
    };
  }

  const adjInfo = getAdjacentInfo(board, row, col, color);
  const patterns = detectPatterns(board, row, col, color, size);
  const isAtari = checkAtari(board, row, col, color);

  // 战术棋型检测
  const escapedAtari = checkEscapedAtari(board, row, col, color);
  const selfAtari = checkSelfAtari(board, row, col, color);
  const doubleAtari = checkDoubleAtari(board, row, col, color);
  const isSnapback = checkSnapback(board, row, col, color);

  return {
    coordinate: { row, col },
    color,
    isPass: false,
    region: getRegion(row, col, size),
    isStarPoint: getStarPoints(size).some(([r, c]) => r === row && c === col),
    distanceToCorner: distanceToCorner(row, col, size),
    liberties: adjInfo.liberties,
    captured: captured || 0,
    isAtari,
    isCapture: (captured || 0) > 0,
    patterns,
    adjacentFriendlyStones: adjInfo.friendly,
    adjacentOpponentStones: adjInfo.opponent,
    connectedGroups: adjInfo.connectedGroups,
    separatedGroups: adjInfo.separatedGroups,
    escapedAtari,
    selfAtari,
    doubleAtari,
    isSnapback,
    winRate: kataGoData?.winRate,
    scoreLead: kataGoData?.scoreLead,
    bestMoves: kataGoData?.bestMoves,
  };
}

/**
 * 生成整局棋的快照序列
 * @param history 落子历史
 * @param boardSize 棋盘大小
 * @param gameMeta 对局元数据（可选）
 */
export function generateSnapshotSeries(
  history: { position: Position; color: Stone; captured: number }[],
  boardSize: number,
  gameMeta?: BoardSnapshot['gameMeta']
): BoardSnapshot[] {
  const snapshots: BoardSnapshot[] = [];
  const { createEmptyBoard } = require('./go-logic');
  let board = createEmptyBoard(boardSize);

  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    if (!move.color) continue;

    // 模拟落子更新棋盘
    const size = getBoardSize(board);
    if (move.position.row >= 0 && move.position.row < size &&
        move.position.col >= 0 && move.position.col < size) {
      const result = playMove(board, move.position.row, move.position.col, move.color);
      board = result.newBoard;
    }

    const snapshot = generateSnapshot(board, history, i, gameMeta);
    snapshots.push(snapshot);
  }

  return snapshots;
}

/**
 * 从 SGF 解析结果生成快照序列
 */
export function generateSnapshotsFromSgf(
  parsed: ParsedGame
): BoardSnapshot[] {
  const { createEmptyBoard } = require('./go-logic');
  let board = createEmptyBoard(parsed.boardSize);

  const history = parsed.moves.map(m => ({
    position: m.position ?? { row: -1, col: -1 },
    color: m.color as Stone,
    captured: 0, // 需要模拟落子才能计算
  }));

  // 重新模拟落子以计算提子数
  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    if (!move.color || move.position.row < 0) continue;
    const result = playMove(board, move.position.row, move.position.col, move.color);
    board = result.newBoard;
    history[i].captured = result.captured;
  }

  const gameMeta = {
    blackPlayer: parsed.blackPlayer?.name,
    whitePlayer: parsed.whitePlayer?.name,
    komi: parsed.komi,
    result: parsed.result,
  };

  return generateSnapshotSeries(history, parsed.boardSize, gameMeta);
}

// ─── 描述生成 ───

/** 将棋盘坐标转为人类可读（如 "3-3" 或 "C4"） */
function formatCoordinate(row: number, col: number, size: number): string {
  const letters = 'ABCDEFGHJKLMNOPQRST';
  if (col >= letters.length) return `${col + 1},${row + 1}`;
  return `${letters[col]}${size - row}`;
}

export function generateDescription(snapshot: BoardSnapshot): string {
  if (snapshot.isPass) {
    return `第${snapshot.moveNumber}手，${snapshot.color === 'black' ? '黑方' : '白方'}选择停一手。`;
  }

  const coord = formatCoordinate(snapshot.coordinate.row, snapshot.coordinate.col, snapshot.boardSize);
  const colorText = snapshot.color === 'black' ? '黑方' : '白方';

  let desc = `第${snapshot.moveNumber}手，${colorText}落在${snapshot.subRegion}的${coord}。`;

  desc += `当前棋盘有${snapshot.blackStones}颗黑子和${snapshot.whiteStones}颗白子。`;

  if (snapshot.isCapture) {
    desc += `这手提掉了${snapshot.captured}颗子。`;
  }

  if (snapshot.isAtari) {
    desc += `这是一手打吃。`;
  }

  if (snapshot.patterns.length > 0) {
    const patternDesc = snapshot.patterns
      .filter(p => p.confidence >= 0.8)
      .map(p => p.description)
      .join('、');
    if (patternDesc) {
      desc += `棋型识别：${patternDesc}。`;
    }
  }

  if (snapshot.winRate !== undefined) {
    desc += `黑方胜率${(snapshot.winRate * 100).toFixed(1)}%。`;
  }

  return desc;
}
