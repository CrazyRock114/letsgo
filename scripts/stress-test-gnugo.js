/**
 * GnuGo 压力测试脚本
 * 
 * 20个并发用户，每3秒对GnuGo高级19路随机下棋20步
 * 
 * 用法: node scripts/stress-test-gnugo.js [BASE_URL] [USER_COUNT] [STEPS] [INTERVAL_MS]
 * 
 * 示例:
 *   node scripts/stress-test-gnugo.js http://localhost:5000 20 20 3000
 */

const BASE_URL = process.argv[2] || 'http://localhost:5000';
const USER_COUNT = parseInt(process.argv[3] || '20', 10);
const STEPS = parseInt(process.argv[4] || '20', 10);
const INTERVAL_MS = parseInt(process.argv[5] || '3000', 10);

const BOARD_SIZE = 19;
const DIFFICULTY = 'hard';
const ENGINE = 'gnugo';

// 围棋逻辑（最小实现，仅用于压力测试）
function createEmptyBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function getNeighbors(row, col, size) {
  const neighbors = [];
  if (row > 0) neighbors.push([row - 1, col]);
  if (row < size - 1) neighbors.push([row + 1, col]);
  if (col > 0) neighbors.push([row, col - 1]);
  if (col < size - 1) neighbors.push([row, col + 1]);
  return neighbors;
}

function getGroup(board, row, col, size) {
  const color = board[row][col];
  if (color === 0) return { stones: [], liberties: 0 };
  const visited = new Set();
  const stones = [];
  const liberties = new Set();
  const stack = [[row, col]];
  while (stack.length > 0) {
    const [r, c] = stack.pop();
    const key = `${r},${c}`;
    if (visited.has(key)) continue;
    visited.add(key);
    stones.push([r, c]);
    for (const [nr, nc] of getNeighbors(r, c, size)) {
      const nKey = `${nr},${nc}`;
      if (board[nr][nc] === 0) {
        liberties.add(nKey);
      } else if (board[nr][nc] === color && !visited.has(nKey)) {
        stack.push([nr, nc]);
      }
    }
  }
  return { stones, liberties: liberties.size };
}

function isValidMove(board, row, col, color, size) {
  if (board[row][col] !== 0) return false;
  // Try placing the stone
  const testBoard = board.map(r => [...r]);
  testBoard[row][col] = color;
  const opponent = color === 1 ? 2 : 1;
  // Check if any opponent groups are captured
  let captured = false;
  for (const [nr, nc] of getNeighbors(row, col, size)) {
    if (testBoard[nr][nc] === opponent) {
      const group = getGroup(testBoard, nr, nc, size);
      if (group.liberties === 0) captured = true;
    }
  }
  // Remove captured opponent stones
  if (captured) {
    for (const [nr, nc] of getNeighbors(row, col, size)) {
      if (testBoard[nr][nc] === opponent) {
        const group = getGroup(testBoard, nr, nc, size);
        if (group.liberties === 0) {
          for (const [sr, sc] of group.stones) {
            testBoard[sr][sc] = 0;
          }
        }
      }
    }
  }
  // Check if own group has liberties (suicide check)
  const ownGroup = getGroup(testBoard, row, col, size);
  if (ownGroup.liberties === 0) return false;
  return true;
}

function getRandomValidMove(board, size) {
  const color = 1; // Black (player always black in this test)
  const validMoves = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isValidMove(board, r, c, color, size)) {
        validMoves.push([r, c]);
      }
    }
  }
  if (validMoves.length === 0) return null;
  return validMoves[Math.floor(Math.random() * validMoves.length)];
}

function applyMove(board, row, col, color, size) {
  const newBoard = board.map(r => [...r]);
  newBoard[row][col] = color;
  const opponent = color === 1 ? 2 : 1;
  // Remove captured opponent stones
  for (const [nr, nc] of getNeighbors(row, col, size)) {
    if (newBoard[nr][nc] === opponent) {
      const group = getGroup(newBoard, nr, nc, size);
      if (group.liberties === 0) {
        for (const [sr, sc] of group.stones) {
          newBoard[sr][sc] = 0;
        }
      }
    }
  }
  return newBoard;
}

// 全局唯一标识，避免重复注册冲突（短后缀确保昵称不超20字符）
const RUN_ID = (Date.now() % 100000).toString(36);

// API 调用
async function registerUser(nickname, password) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });
  if (res.ok) {
    return res.json();
  }
  // 注册失败（可能已存在），尝试登录
  return loginUser(nickname, password);
}

async function loginUser(nickname, password) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password }),
  });
  if (!res.ok) {
    // 登录也失败，放弃此用户
    const data = await res.json();
    throw new Error(`Login failed: ${data.error}`);
  }
  return res.json();
}

async function getAIMove(token, moves, boardSize, difficulty, engine) {
  const res = await fetch(`${BASE_URL}/api/go-engine`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ boardSize, difficulty, engine, moves }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(`Engine failed: ${data.error} (status ${res.status})`);
  }
  return res.json();
}

// 创建棋局记录
async function createGame(token, boardSize, difficulty, engine) {
  const res = await fetch(`${BASE_URL}/api/games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      board_size: boardSize,
      difficulty,
      engine,
      moves: [],
      status: 'playing',
      title: `${boardSize}路 ${difficulty} ${engine} 压力测试`,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.log(`  创建棋局记录失败: ${data.error || res.status}（不影响对弈）`);
    return null;
  }
  const data = await res.json();
  return data.game?.id || null;
}

// 更新棋局记录
async function updateGame(token, gameId, moves, board, status) {
  if (!gameId) return;
  const res = await fetch(`${BASE_URL}/api/games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: gameId,
      moves,
      final_board: board,
      status,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.log(`  更新棋局记录失败: ${data.error || res.status}（不影响对弈）`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 统计
const stats = {
  totalMoves: 0,
  totalErrors: 0,
  totalPasses: 0,
  startTime: Date.now(),
  userResults: [],
};

// 单个用户对弈流程
async function runUser(userId) {
  const nickname = `st_${userId}_${RUN_ID}`;
  const password = 'stress123';
  const userLog = (msg) => console.log(`[User${userId}] ${msg}`);

  try {
    // 注册/登录
    const authData = await registerUser(nickname, password);
    const token = authData.token;
    userLog(`登录成功 (${nickname}), 积分: ${authData.user.points}`);

    let board = createEmptyBoard(BOARD_SIZE);
    const moves = []; // {row, col, color}
    let step = 0;
    let playerColor = 1; // black
    let aiColor = 2; // white

    // 创建棋局记录（让Monitor页面能看到活跃对弈）
    const gameId = await createGame(token, BOARD_SIZE, DIFFICULTY, ENGINE);
    if (gameId) {
      userLog(`棋局已创建 (id:${gameId})`);
    }

    while (step < STEPS) {
      step++;
      
      // 玩家落子（随机）
      const playerMove = getRandomValidMove(board, BOARD_SIZE);
      if (!playerMove) {
        userLog(`第${step}步: 无合法落子，停手`);
        moves.push({ row: -1, col: -1, color: playerColor === 1 ? 'black' : 'white' });
        break;
      }

      const [pr, pc] = playerMove;
      board = applyMove(board, pr, pc, playerColor, BOARD_SIZE);
      moves.push({ row: pr, col: pc, color: playerColor === 1 ? 'black' : 'white' });
      userLog(`第${step}步: 落子 ${String.fromCharCode(65 + (pc >= 8 ? pc + 1 : pc))}${BOARD_SIZE - pr}`);

      // 请求AI落子
      const aiStartTime = Date.now();
      try {
        const aiResult = await getAIMove(token, moves, BOARD_SIZE, DIFFICULTY, ENGINE);
        const aiDuration = Date.now() - aiStartTime;
        stats.totalMoves++;

        if (aiResult.pass) {
          userLog(`  AI停手 (${aiDuration}ms)`);
          stats.totalPasses++;
          break;
        }

        if (aiResult.move) {
          const { row, col } = aiResult.move;
          board = applyMove(board, row, col, aiColor, BOARD_SIZE);
          moves.push({ row, col, color: aiColor === 1 ? 'black' : 'white' });
          const moveCoord = `${String.fromCharCode(65 + (col >= 8 ? col + 1 : col))}${BOARD_SIZE - row}`;
          userLog(`  AI落子 ${moveCoord} (${aiDuration}ms, 引擎:${aiResult.engine || ENGINE}, 剩余积分:${aiResult.remainingPoints ?? '?'})`);
        }

        if (aiResult.noEngine) {
          userLog(`  引擎不可用，回退本地AI`);
        }
      } catch (err) {
        stats.totalErrors++;
        userLog(`  AI请求失败: ${err.message} (${aiDuration}ms)`);
      }

      // 每步更新棋局记录（让Monitor看到活跃对弈）
      if (gameId && step % 3 === 0) {
        await updateGame(token, gameId, moves, board, 'playing');
      }

      // 等待间隔
      if (step < STEPS) {
        await sleep(INTERVAL_MS);
      }
    }

    // 标记棋局结束
    await updateGame(token, gameId, moves, board, 'finished');

    userLog(`完成! 共${step}步`);
    stats.userResults.push({ userId, steps: step, success: true });
  } catch (err) {
    stats.totalErrors++;
    userLog(`失败: ${err.message}`);
    stats.userResults.push({ userId, steps: 0, success: false, error: err.message });
  }
}

// 主函数
async function main() {
  console.log('='.repeat(60));
  console.log('GnuGo 压力测试');
  console.log('='.repeat(60));
  console.log(`目标: ${BASE_URL}`);
  console.log(`用户数: ${USER_COUNT}`);
  console.log(`每用户步数: ${STEPS}`);
  console.log(`间隔: ${INTERVAL_MS}ms`);
  console.log(`棋盘: ${BOARD_SIZE}路`);
  console.log(`难度: ${DIFFICULTY}`);
  console.log(`引擎: ${ENGINE}`);
  console.log('='.repeat(60));

  // 检查服务是否可用
  try {
    const healthRes = await fetch(`${BASE_URL}/api/go-engine`, { signal: AbortSignal.timeout(5000) });
    const healthData = await healthRes.json();
    console.log(`引擎状态: KataGo=${healthData.engines?.find(e => e.id === 'katago')?.available ? '可用' : '不可用'}, GnuGo=${healthData.engines?.find(e => e.id === 'gnugo')?.available ? '可用' : '不可用'}`);
    console.log(`当前队列: ${healthData.queueLength ?? 0}, 正在处理: ${healthData.isProcessing ?? false}`);
  } catch (err) {
    console.error(`无法连接到 ${BASE_URL}: ${err.message}`);
    process.exit(1);
  }

  console.log('\n开始压力测试...\n');
  stats.startTime = Date.now();

  // 并发启动所有用户
  const userPromises = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    userPromises.push(runUser(i));
  }

  await Promise.all(userPromises);

  // 输出统计
  const duration = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const successCount = stats.userResults.filter(r => r.success).length;
  const failCount = stats.userResults.filter(r => !r.success).length;

  console.log('\n' + '='.repeat(60));
  console.log('压力测试完成');
  console.log('='.repeat(60));
  console.log(`总耗时: ${duration}s`);
  console.log(`用户数: ${USER_COUNT} (成功: ${successCount}, 失败: ${failCount})`);
  console.log(`总落子请求: ${stats.totalMoves}`);
  console.log(`总错误数: ${stats.totalErrors}`);
  console.log(`总停手数: ${stats.totalPasses}`);
  console.log(`平均每步耗时: ${stats.totalMoves > 0 ? ((Date.now() - stats.startTime) / stats.totalMoves / 1000).toFixed(2) : 'N/A'}s`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
