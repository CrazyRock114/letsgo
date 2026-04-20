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

// 获取落子被拒绝的原因（用于给用户提示）
export function getMoveRejectionReason(board: Board, row: number, col: number, color: Stone): string | null {
  if (!isValidPosition(board, row, col)) {
    return '超出棋盘范围';
  }
  if (board[row][col] !== null) {
    return '此处已有棋子';
  }
  
  const testBoard = copyBoard(board);
  testBoard[row][col] = color;
  
  // 检查是否能提对方的子
  const captured = captureStones(testBoard, row, col);
  if (captured > 0) {
    return null; // 可以落子（提子）
  }
  
  // 检查自己是否有气
  const liberties = getGroupLiberties(testBoard, row, col);
  if (liberties === 0) {
    return '禁着点：落子后无气（自杀着）';
  }
  
  return null; // 可以落子
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
  
  // 先统计棋子数，用于判断棋局阶段
  let blackStones = 0;
  let whiteStones = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (board[row][col] === 'black') blackStones++;
      else if (board[row][col] === 'white') whiteStones++;
    }
  }
  
  // 棋子覆盖率：棋盘上棋子越多，领地估算越可靠
  const totalStones = blackStones + whiteStones;
  const totalIntersections = size * size;
  const stoneRatio = totalStones / totalIntersections;
  
  // 开局阶段（覆盖率 < 15%），领地估算极不准确，只显示棋子数
  // 这样避免了"第一手棋就显示361目"的问题
  if (stoneRatio < 0.15) {
    return { black: blackStones, white: whiteStones };
  }
  
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
    // 围棋行号从下往上：视觉顶部(数组第0行)=最大行号
    const rowNum = size - row;
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
  const coord = positionToCoordinate(row, col, size);
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
      const nCoord = positionToCoordinate(nr, nc, size);
      const nColor = neighbor === 'black' ? '黑棋' : neighbor === 'white' ? '白棋' : '空';
      neighborDescs.push(`${name}方${nCoord}=${nColor}`);
    }
  }
  
  // 计算气数（只在打吃状态时标注）
  let libertyInfo = '';
  if (stone) {
    const liberties = getGroupLiberties(board, row, col);
    if (liberties === 1) {
      libertyInfo = '，只剩1口气(打吃状态!)';
    }
    // 2口气及以上不提及，避免解说啰嗦
  }
  
  return `${coord}位置是${colorName}${libertyInfo}；相邻：${neighborDescs.join('、')}`;
}

// 坐标转换（从(row, col)到围棋坐标，跳过I列，行号从下往上）
export function positionToCoordinate(row: number, col: number, boardSize: number = 19): string {
  // 跳过 I 列
  const colChar = col >= 8 ? String.fromCharCode(65 + col + 1) : String.fromCharCode(65 + col);
  // 围棋行号从下往上：数组第0行(视觉顶部) = 最大行号，数组最后一行(视觉底部) = 1
  const rowNum = boardSize - row;
  return colChar + rowNum;
}

// AI简单策略（随机选择合法位置）
export function simpleAIMove(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;
  return validMoves[Math.floor(Math.random() * validMoves.length)];
}

// ==================== AI 围棋引擎 ====================

// 评估一个落子的分数（正值对color方有利）
function evaluateMove(board: Board, row: number, col: number, color: Stone): number {
  const size = board.length;
  const enemy: Stone = color === 'black' ? 'white' : 'black';
  let score = 0;

  // 1. 模拟落子
  const testBoard = copyBoard(board);
  testBoard[row][col] = color;
  const captured = captureStones(testBoard, row, col);

  // 2. 提子奖励（高优先级）
  score += captured * 15;

  // 3. 检查落子后自己的气数
  const myLiberties = getGroupLiberties(testBoard, row, col);
  if (myLiberties === 1 && captured === 0) {
    score -= 20; // 自填一气，危险
  } else if (myLiberties === 2) {
    score -= 3;
  } else if (myLiberties >= 4) {
    score += 2;
  }

  // 4. 攻击对方：检查是否让对方棋组气数减少
  const directions: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const checkedGroups = new Set<string>();
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && testBoard[nr][nc] === enemy) {
      const groupKey = getGroupKey(testBoard, nr, nc);
      if (!checkedGroups.has(groupKey)) {
        checkedGroups.add(groupKey);
        const enemyLibs = getGroupLiberties(testBoard, nr, nc);
        if (enemyLibs === 1) {
          score += 12; // 打吃对方
        } else if (enemyLibs === 2) {
          score += 5; // 给对方施加压力
        }
      }
    }
  }

  // 5. 防守：如果己方相邻棋组气少，连接/长气有价值
  const checkedMyGroups = new Set<string>();
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === color) {
      const groupKey = getGroupKey(board, nr, nc);
      if (!checkedMyGroups.has(groupKey)) {
        checkedMyGroups.add(groupKey);
        const myGroupLibs = getGroupLiberties(board, nr, nc);
        if (myGroupLibs === 1) {
          score += 14; // 救自己的棋（紧急）
        } else if (myGroupLibs === 2) {
          score += 4; // 加固
        }
      }
    }
  }

  // 6. 位置价值（金角银边草肚皮）
  const cornerDist = Math.min(row, size - 1 - row);
  const edgeDist = Math.min(col, size - 1 - col);
  const minDist = Math.min(cornerDist, edgeDist);
  if (minDist === 0) {
    score -= 2; // 一线一般不好
  } else if (minDist === 1) {
    score += 1; // 二线
  } else if (minDist === 2) {
    score += 3; // 三线（实地线）
  } else if (minDist === 3) {
    score += 4; // 四线（势力线）
  }

  // 7. 星位和重要点位奖励
  const starPoints = getStarPoints(size);
  for (const [sr, sc] of starPoints) {
    if (row === sr && col === sc) {
      score += 5;
      break;
    }
  }

  // 8. 连接奖励：与己方棋子相邻
  let friendlyNeighbors = 0;
  for (const [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
      if (board[nr][nc] === color) friendlyNeighbors++;
    }
  }
  // 有一两个己方邻居好（连接），太多不好（密集）
  if (friendlyNeighbors === 1) score += 2;
  else if (friendlyNeighbors === 2) score += 1;
  else if (friendlyNeighbors >= 3) score -= 3; // 太密集

  // 9. 断点：在对方棋子之间下，切断对方连接
  const neighborEnemies = directions.filter(([dr, dc]) => {
    const nr = row + dr;
    const nc = col + dc;
    return nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === enemy;
  }).length;
  if (neighborEnemies >= 2) {
    score += 6; // 切断对方
  }

  // 10. 影响力评估：周围2格内己方/对方棋子数
  let influence = 0;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
        const dist = Math.abs(dr) + Math.abs(dc);
        const weight = dist === 1 ? 3 : dist === 2 ? 2 : 1;
        if (board[nr][nc] === color) influence += weight;
        else if (board[nr][nc] === enemy) influence -= weight;
      }
    }
  }
  // 正影响力说明在己方势力范围内，好；负影响力说明在对方势力内，需要更多考虑
  if (influence > 0) score += 2;
  else if (influence < -3) score -= 2;

  // 11. 开局特殊走法：前几手优先占角部星位附近
  let totalStones = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== null) totalStones++;
    }
  }
  if (totalStones < size) {
    // 开局阶段：鼓励占角（三三点、四四点、三五点等）
    const isCornerArea = minDist <= 4 && minDist >= 2;
    if (isCornerArea) score += 6;

    // 四个角的区域
    const corners = [
      { rMin: 0, rMax: Math.floor(size/3), cMin: 0, cMax: Math.floor(size/3) },
      { rMin: 0, rMax: Math.floor(size/3), cMin: size - Math.floor(size/3), cMax: size },
      { rMin: size - Math.floor(size/3), rMax: size, cMin: 0, cMax: Math.floor(size/3) },
      { rMin: size - Math.floor(size/3), rMax: size, cMin: size - Math.floor(size/3), cMax: size },
    ];
    for (const corner of corners) {
      if (row >= corner.rMin && row < corner.rMax && col >= corner.cMin && col < corner.cMax) {
        // 检查这个角是否还没被占据
        let cornerOccupied = false;
        for (let r = corner.rMin; r < corner.rMax; r++) {
          for (let c = corner.cMin; c < corner.cMax; c++) {
            if (board[r][c] !== null) cornerOccupied = true;
          }
        }
        if (!cornerOccupied) score += 4; // 空角优先
      }
    }
  }

  // 12. 避免眼位被填（自己不要填自己的眼）
  if (friendlyNeighbors >= 3 && captured === 0) {
    // 检查是否真的是眼：四面都是己方棋子或边界
    let isEye = true;
    for (const [dr, dc] of directions) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
        if (board[nr][nc] !== color) isEye = false;
      }
    }
    if (isEye) score -= 25; // 不要填自己的眼
  }

  return score;
}

// 获取星位
function getStarPoints(size: number): [number, number][] {
  if (size === 9) return [[2, 2], [2, 6], [4, 4], [6, 2], [6, 6]];
  if (size === 13) return [[3, 3], [3, 9], [6, 6], [9, 3], [9, 9], [3, 6], [6, 3], [6, 9], [9, 6]];
  if (size === 19) return [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]];
  return [];
}

// 获取棋组唯一标识
function getGroupKey(board: Board, row: number, col: number): string {
  const stone = board[row][col];
  if (!stone) return '';
  const visited = new Set<string>();
  const stack = [`${row},${col}`];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const [r, c] = key.split(',').map(Number);
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr;
      const nc = c + dc;
      const nk = `${nr},${nc}`;
      if (nr >= 0 && nr < board.length && nc >= 0 && nc < board.length && !visited.has(nk) && board[nr][nc] === stone) {
        stack.push(nk);
      }
    }
  }
  return Array.from(visited).sort().join(';');
}

// 智能AI落子 - 初级（随机+避傻）
export function easyAIMove(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;

  // 初级AI：评分过滤 + 大范围随机，不是纯随机
  const scored = validMoves.map(m => ({
    position: m,
    score: evaluateMove(board, m.row, m.col, color),
  }));

  // 过滤掉明显不好的走法
  const safeMoves = scored.filter(m => m.score > -15);
  const pool = safeMoves.length > 0 ? safeMoves : scored;

  // 从前40%中随机选，保持变化性但不会太傻
  const topCount = Math.max(1, Math.ceil(pool.length * 0.4));
  const sorted = pool.sort((a, b) => b.score - a.score);
  const candidates = sorted.slice(0, topCount);
  return candidates[Math.floor(Math.random() * candidates.length)].position;
}

// 智能AI落子 - 中级（评分选择，偶尔随机）
export function mediumAIMove(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;

  // 评分所有走法
  const scored = validMoves.map(m => ({
    position: m,
    score: evaluateMove(board, m.row, m.col, color),
  }));

  // 按分数排序
  scored.sort((a, b) => b.score - a.score);

  // 从前3个中加权随机（提高选择最高分的概率）
  const topN = Math.min(3, scored.length);
  const weights = scored.slice(0, topN).map((_, i) => (topN - i) * (topN - i + 1) / 2);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < topN; i++) {
    rand -= weights[i];
    if (rand <= 0) return scored[i].position;
  }
  return scored[0].position;
}

// 智能AI落子 - 高级（深度评估+2步前瞻）
export function hardAIMove(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;
  const size = board.length;
  const enemy: Stone = color === 'black' ? 'white' : 'black';

  // 评分所有走法（含2步前瞻）
  const scored = validMoves.map(m => {
    let score = evaluateMove(board, m.row, m.col, color);

    // 第1步前瞻：模拟对方最佳应对
    const testBoard = copyBoard(board);
    testBoard[m.row][m.col] = color;
    captureStones(testBoard, m.row, m.col);

    // 检查对方有没有好反击
    const enemyMoves = getValidMoves(testBoard, enemy);
    if (enemyMoves.length > 0) {
      // 采样部分对方走法
      const sampleSize = Math.min(enemyMoves.length, size <= 9 ? 30 : 15);
      let bestEnemyScore = -Infinity;
      let bestEnemyMove: Position | null = null;

      for (let i = 0; i < sampleSize; i++) {
        const em = enemyMoves[i];
        const enemyScore = evaluateMove(testBoard, em.row, em.col, enemy);
        if (enemyScore > bestEnemyScore) {
          bestEnemyScore = enemyScore;
          bestEnemyMove = em;
        }
      }
      // 对方好反击越多，这步越差
      score -= bestEnemyScore * 0.5;

      // 第2步前瞻：我方再应对对方最佳走法
      if (bestEnemyMove) {
        const testBoard2 = copyBoard(testBoard);
        testBoard2[bestEnemyMove.row][bestEnemyMove.col] = enemy;
        captureStones(testBoard2, bestEnemyMove.row, bestEnemyMove.col);

        const myMoves2 = getValidMoves(testBoard2, color);
        if (myMoves2.length > 0) {
          let bestMyScore2 = -Infinity;
          const sampleSize2 = Math.min(myMoves2.length, size <= 9 ? 15 : 8);
          for (let i = 0; i < sampleSize2; i++) {
            const mm = myMoves2[i];
            bestMyScore2 = Math.max(bestMyScore2, evaluateMove(testBoard2, mm.row, mm.col, color));
          }
          score += bestMyScore2 * 0.3;
        }
      }
    }

    return { position: m, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 从前3个中加权随机（保持变化性）
  const topN = Math.min(3, scored.length);
  const weights = scored.slice(0, topN).map((_, i) => (topN - i) * (topN - i + 1) / 2);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < topN; i++) {
    rand -= weights[i];
    if (rand <= 0) return scored[i].position;
  }
  return scored[0].position;
}

// 智能提示：找到最佳落子建议
export function findBestHint(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;

  const scored = validMoves.map(m => ({
    position: m,
    score: evaluateMove(board, m.row, m.col, color),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0].position;
}

// 判断游戏是否应该结束（严格条件：宁愿晚结束也不要早结束）
export function checkGameEnd(
  board: Board,
  consecutivePasses: number,
  moveCount: number
): { ended: boolean; reason: string } {
  const size = board.length;
  
  // 统计空位和棋子
  let emptyCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === null) emptyCount++;
    }
  }
  
  // 棋盘下满
  if (emptyCount === 0) {
    return { ended: true, reason: '棋盘已满，棋局结束' };
  }

  // 步数上限（大幅提高，避免过早结束）
  // 9路81个交叉点→150步, 13路169→300步, 19路361→500步
  const maxMoves = size <= 9 ? 150 : size <= 13 ? 300 : 500;
  if (moveCount >= maxMoves) {
    return { ended: true, reason: `已下${moveCount}手，棋局结束` };
  }

  // 最低步数门槛：总步数少于上限的30%时，不允许连续停手结束游戏
  // 这防止AI在中局停手导致过早结束
  const minMovesForPass = Math.floor(maxMoves * 0.3);
  if (consecutivePasses >= 2 && moveCount >= minMovesForPass) {
    return { ended: true, reason: '双方连续停手，棋局结束' };
  }

  // 领地优势绝对判定：即使劣势方占满所有剩余空地也无法翻盘
  // 只在棋局中后期（步数 >= 最低门槛）才启用此判断
  if (moveCount >= minMovesForPass && emptyCount > 0) {
    const evaluation = evaluateBoard(board);
    const komi = getKomi(size);
    const whiteWithKomi = evaluation.white + komi;
    const blackLead = evaluation.black - whiteWithKomi;
    // 优势方领先目数 > 剩余空交叉点数 → 劣势方即使占满所有空地也追不上
    if (Math.abs(blackLead) > emptyCount) {
      return { ended: true, reason: `领地差距悬殊（${Math.abs(blackLead).toFixed(1)}目 vs ${emptyCount}空位），棋局结束` };
    }
  }

  return { ended: false, reason: '' };
}

// 获取贴目值（根据棋盘大小）
export function getKomi(boardSize: number): number {
  return boardSize <= 9 ? 2.5 : boardSize <= 13 ? 3.5 : 6.5;
}

// 计算最终得分（含贴目，根据棋盘大小调整）
export function calculateFinalScore(board: Board): { black: number; white: number; winner: string; detail: string } {
  const evaluation = evaluateBoard(board);
  // 贴目根据棋盘大小：9路2.5目、13路3.5目、19路6.5目
  const size = board.length;
  const komi = getKomi(size);
  const whiteWithKomi = evaluation.white + komi;

  const winner = evaluation.black > whiteWithKomi ? 'black' : 'white';
  const margin = Math.abs(evaluation.black - whiteWithKomi);
  const detail = `黑方${evaluation.black}目 vs 白方${evaluation.white}目+贴目${komi}=${whiteWithKomi.toFixed(1)}目，${winner === 'black' ? '黑方' : '白方'}胜${margin.toFixed(1)}目`;

  return {
    black: evaluation.black,
    white: Math.round(whiteWithKomi * 10) / 10,
    winner,
    detail,
  };
}
