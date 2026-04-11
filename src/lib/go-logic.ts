// 围棋游戏核心逻辑

export type Stone = 'black' | 'white' | null;
export type Board = Stone[][];
export type Position = { row: number; col: number };

// 初始化空棋盘
export function createEmptyBoard(size: number = 19): Board {
  return Array(size).fill(null).map(() => Array(size).fill(null));
}

// 复制棋盘
export function copyBoard(board: Board): Board {
  return board.map(row => [...row]);
}

// 获取棋盘大小
export function getBoardSize(board: Board): number {
  return board.length;
}

// 检查位置是否在棋盘内
export function isValidPosition(board: Board, row: number, col: number): boolean {
  const size = getBoardSize(board);
  return row >= 0 && row < size && col >= 0 && col < size;
}

// 获取相邻位置
export function getNeighbors(board: Board, row: number, col: number): Position[] {
  const neighbors: Position[] = [];
  const directions: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  
  for (const [dr, dc] of directions) {
    const newRow = row + dr;
    const newCol = col + dc;
    if (isValidPosition(board, newRow, newCol)) {
      neighbors.push({ row: newRow, col: newCol });
    }
  }
  
  return neighbors;
}

// 获取棋子所在的气
export function getLiberties(board: Board, row: number, col: number): Set<string> {
  const stone = board[row][col];
  if (!stone) return new Set();
  
  const visited = new Set<string>();
  const liberties = new Set<string>();
  const group = new Set<string>();
  const stack: string[] = [`${row},${col}`];
  
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    
    const [r, c] = key.split(',').map(Number);
    
    if (board[r][c] === null) {
      liberties.add(key);
    } else if (board[r][c] === stone) {
      group.add(key);
      const neighbors = getNeighbors(board, r, c);
      for (const neighbor of neighbors) {
        const neighborKey = `${neighbor.row},${neighbor.col}`;
        if (!visited.has(neighborKey)) {
          stack.push(neighborKey);
        }
      }
    }
  }
  
  return liberties;
}

// 获取一组棋子的所有气
export function getGroupLiberties(board: Board, row: number, col: number): number {
  return getLiberties(board, row, col).size;
}

// 移除棋子
export function removeStones(board: Board, positions: Set<string>): void {
  for (const key of positions) {
    const [row, col] = key.split(',').map(Number);
    board[row][col] = null;
  }
}

// 提子
export function captureStones(board: Board, row: number, col: number): number {
  const enemy = board[row][col] === 'black' ? 'white' : 'black';
  const directions: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let captured = 0;
  
  for (const [dr, dc] of directions) {
    const newRow = row + dr;
    const newCol = col + dc;
    
    if (isValidPosition(board, newRow, newCol) && board[newRow][newCol] === enemy) {
      const liberties = getGroupLiberties(board, newRow, newCol);
      if (liberties === 0) {
        const group = getConnectedStones(board, newRow, newCol);
        removeStones(board, group);
        captured += group.size;
      }
    }
  }
  
  return captured;
}

// 获取连接的棋子
export function getConnectedStones(board: Board, row: number, col: number): Set<string> {
  const stone = board[row][col];
  if (!stone) return new Set();
  
  const visited = new Set<string>();
  const group = new Set<string>();
  const stack: string[] = [`${row},${col}`];
  
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    
    const [r, c] = key.split(',').map(Number);
    
    if (board[r][c] === stone) {
      group.add(key);
      const neighbors = getNeighbors(board, r, c);
      for (const neighbor of neighbors) {
        const neighborKey = `${neighbor.row},${neighbor.col}`;
        if (!visited.has(neighborKey)) {
          stack.push(neighborKey);
        }
      }
    }
  }
  
  return group;
}

// 检查是否可以落子
export function isValidMove(board: Board, row: number, col: number, color: Stone): boolean {
  if (!isValidPosition(board, row, col) || board[row][col] !== null) {
    return false;
  }
  
  const testBoard = copyBoard(board);
  testBoard[row][col] = color;
  
  // 检查是否能提对方的子
  const captured = captureStones(testBoard, row, col);
  if (captured > 0) {
    return true;
  }
  
  // 检查自己是否有气
  const liberties = getGroupLiberties(testBoard, row, col);
  return liberties > 0;
}

// 获取所有合法落子位置
export function getValidMoves(board: Board, color: Stone): Position[] {
  const moves: Position[] = [];
  const size = getBoardSize(board);
  
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (isValidMove(board, row, col, color)) {
        moves.push({ row, col });
      }
    }
  }
  
  return moves;
}

// 落子
export function playMove(
  board: Board,
  row: number,
  col: number,
  color: Stone
): { newBoard: Board; captured: number; ko: Position | null } {
  const newBoard = copyBoard(board);
  newBoard[row][col] = color;
  
  const captured = captureStones(newBoard, row, col);
  
  // 检查打劫
  let ko: Position | null = null;
  if (captured === 1) {
    const enemy = color === 'black' ? 'white' : 'black';
    const neighbors = getNeighbors(newBoard, row, col);
    let neighborCount = 0;
    for (const n of neighbors) {
      if (board[n.row][n.col] === enemy) {
        neighborCount++;
      }
    }
    
    if (neighborCount === 1 && getGroupLiberties(newBoard, row, col) === 1) {
      ko = { row, col };
    }
  }
  
  return { newBoard, captured, ko };
}

// 局面评估（简单版）
export function evaluateBoard(board: Board): { black: number; white: number } {
  const size = getBoardSize(board);
  let black = 0;
  let white = 0;
  
  const visited = new Set<string>();
  
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const key = `${row},${col}`;
      if (visited.has(key)) continue;
      
      const stone = board[row][col];
      if (stone === 'black') {
        black++;
      } else if (stone === 'white') {
        white++;
      } else {
        // 空点，检查归属
        const territory = getTerritory(board, row, col, visited);
        if (territory.owner === 'black') {
          black += territory.size;
        } else if (territory.owner === 'white') {
          white += territory.size;
        }
      }
      visited.add(key);
    }
  }
  
  return { black, white };
}

// 获取空地的领地
function getTerritory(
  board: Board,
  startRow: number,
  startCol: number,
  visited: Set<string>
): { size: number; owner: Stone } {
  const emptySpots: Position[] = [];
  const bordering = new Set<Stone>();
  const stack: Position[] = [{ row: startRow, col: startCol }];
  
  while (stack.length > 0) {
    const pos = stack.pop()!;
    const key = `${pos.row},${pos.col}`;
    
    if (visited.has(key)) continue;
    visited.add(key);
    
    if (board[pos.row][pos.col] === null) {
      emptySpots.push(pos);
      const neighbors = getNeighbors(board, pos.row, pos.col);
      for (const neighbor of neighbors) {
        const nKey = `${neighbor.row},${neighbor.col}`;
        if (!visited.has(nKey)) {
          const neighborStone = board[neighbor.row][neighbor.col];
          if (neighborStone === null) {
            stack.push(neighbor);
          } else {
            bordering.add(neighborStone);
          }
        }
      }
    }
  }
  
  let owner: Stone = null;
  if (bordering.size === 1) {
    owner = Array.from(bordering)[0];
  }
  
  return { size: emptySpots.length, owner };
}

// 列标签（跳过I，符合围棋规范）
function getColLabels(size: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < size; i++) {
    // 跳过 I
    const code = i >= 8 ? 65 + i + 1 : 65 + i;
    labels.push(String.fromCharCode(code));
  }
  return labels;
}

// 棋盘状态转字符串（带行列标签，用于AI精确理解）
export function boardToString(board: Board): string {
  const size = getBoardSize(board);
  const colLabels = getColLabels(size);
  const lines: string[] = [];
  
  // 列标签行
  lines.push('   ' + colLabels.join(''));
  
  for (let row = 0; row < size; row++) {
    const rowNum = row + 1;
    const line = board[row].map(stone => {
      if (stone === 'black') return 'X';
      if (stone === 'white') return 'O';
      return '.';
    }).join('');
    lines.push(`${rowNum.toString().padStart(2)} ${line}`);
  }
  
  return lines.join('\n');
}

// 获取某个位置周围棋子的详细描述（供LLM精确理解局面）
export function getMoveContext(board: Board, row: number, col: number): string {
  const size = getBoardSize(board);
  const coord = positionToCoordinate(row, col);
  const stone = board[row][col];
  const colorName = stone === 'black' ? '黑棋' : stone === 'white' ? '白棋' : '空';
  
  const directions: { dr: number; dc: number; name: string }[] = [
    { dr: -1, dc: 0, name: '上' },
    { dr: 1, dc: 0, name: '下' },
    { dr: 0, dc: -1, name: '左' },
    { dr: 0, dc: 1, name: '右' },
  ];
  
  const neighborDescs: string[] = [];
  for (const { dr, dc, name } of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
      const neighbor = board[nr][nc];
      const nCoord = positionToCoordinate(nr, nc);
      const nColor = neighbor === 'black' ? '黑棋' : neighbor === 'white' ? '白棋' : '空';
      neighborDescs.push(`${name}方${nCoord}=${nColor}`);
    }
  }
  
  // 计算气数（如果是棋子）
  let libertyInfo = '';
  if (stone) {
    const liberties = getGroupLiberties(board, row, col);
    const libertyDesc = liberties === 1 ? '只剩1口气(打吃状态!)' : liberties === 2 ? '有2口气' : `有${liberties}口气`;
    libertyInfo = `，${libertyDesc}`;
  }
  
  return `${coord}位置是${colorName}${libertyInfo}；相邻：${neighborDescs.join('、')}`;
}

// 坐标转换（从(row, col)到围棋坐标，跳过I列）
export function positionToCoordinate(row: number, col: number): string {
  // 跳过 I 列
  const colChar = col >= 8 ? String.fromCharCode(65 + col + 1) : String.fromCharCode(65 + col);
  return colChar + (row + 1);
}

// AI简单策略（随机选择合法位置）
export function simpleAIMove(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;
  return validMoves[Math.floor(Math.random() * validMoves.length)];
}
