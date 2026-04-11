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

  // 过滤掉明显不好的走法
  const safeMoves = validMoves.filter(m => {
    const score = evaluateMove(board, m.row, m.col, color);
    return score > -15; // 不走明显自杀的
  });

  const pool = safeMoves.length > 0 ? safeMoves : validMoves;
  // 简单随机，但稍微偏向角部
  const corners = pool.filter(m => (m.row <= 2 || m.row >= board.length - 3) && (m.col <= 2 || m.col >= board.length - 3));
  if (corners.length > 0 && Math.random() < 0.3) {
    return corners[Math.floor(Math.random() * corners.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
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

  // 从前5个中随机选（增加变化性）
  const topN = Math.min(5, scored.length);
  // 加权随机：前面的概率更大
  const weights = scored.slice(0, topN).map((_, i) => topN - i);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < topN; i++) {
    rand -= weights[i];
    if (rand <= 0) return scored[i].position;
  }
  return scored[0].position;
}

// 智能AI落子 - 高级（深度评估+1步前瞻）
export function hardAIMove(board: Board, color: Stone): Position | null {
  const validMoves = getValidMoves(board, color);
  if (validMoves.length === 0) return null;
  const size = board.length;
  const enemy: Stone = color === 'black' ? 'white' : 'black';

  // 评分所有走法（含1步前瞻）
  const scored = validMoves.map(m => {
    let score = evaluateMove(board, m.row, m.col, color);

    // 1步前瞻：模拟对方最佳应对
    const testBoard = copyBoard(board);
    testBoard[m.row][m.col] = color;
    captureStones(testBoard, m.row, m.col);

    // 检查对方有没有好反击
    const enemyMoves = getValidMoves(testBoard, enemy);
    if (enemyMoves.length > 0) {
      let bestEnemyScore = -Infinity;
      // 采样部分对方走法（不全算，避免太慢）
      const sampleSize = Math.min(enemyMoves.length, size <= 9 ? 20 : 10);
      const sampled = enemyMoves.slice(0, sampleSize);
      for (const em of sampled) {
        const enemyScore = evaluateMove(testBoard, em.row, em.col, enemy);
        bestEnemyScore = Math.max(bestEnemyScore, enemyScore);
      }
      // 对方好反击越多，这步越差
      score -= bestEnemyScore * 0.5;
    }

    return { position: m, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 从前3个中加权随机（保持变化性）
  const topN = Math.min(3, scored.length);
  const weights = scored.slice(0, topN).map((_, i) => topN - i + 1);
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

// 判断游戏是否应该结束（双方连续停手、或大比分差距）
export function checkGameEnd(
  board: Board,
  consecutivePasses: number,
  moveCount: number
): { ended: boolean; reason: string } {
  // 双方连续停手
  if (consecutivePasses >= 2) {
    return { ended: true, reason: '双方连续停手，棋局结束' };
  }

  // 棋盘下满
  const size = board.length;
  let emptyCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === null) emptyCount++;
    }
  }
  if (emptyCount === 0) {
    return { ended: true, reason: '棋盘已满，棋局结束' };
  }

  // 步数过多自动结束（9路60步、13路100步、19路200步）
  const maxMoves = size <= 9 ? 60 : size <= 13 ? 100 : 200;
  if (moveCount >= maxMoves) {
    return { ended: true, reason: `已下${moveCount}手，棋局结束` };
  }

  return { ended: false, reason: '' };
}

// 计算最终得分（含贴目）
export function calculateFinalScore(board: Board): { black: number; white: number; winner: string; detail: string } {
  const evaluation = evaluateBoard(board);
  // 贴目：白方额外加6.5目（中国规则简化）
  const komi = 6.5;
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
