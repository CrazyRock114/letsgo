/**
 * 双引擎压力测试脚本 v2
 * 
 * 50个GnuGo用户 + 50个KataGo用户
 * 每个用户每10秒随机下一步棋（19路高级难度）
 * 并发控制：等待AI响应时如果超过10秒，延迟一个周期
 * 统计每个用户的延迟次数
 * 
 * 用法: node scripts/stress-test.js [BASE_URL]
 */

const BASE_URL = process.argv[2] || 'https://letusgoa.cn';
const GNUGO_USERS = 50;
const KATAGO_USERS = 50;
const STEP_INTERVAL_MS = 10000; // 每10秒下一步
const MAX_STEPS = 20;           // 最多20步
const BOARD_SIZE = 19;
const DIFFICULTY = 'hard';
const STAGGER_DELAY_MS = 500;   // 用户之间错开启动间隔

// ---- 围棋最小逻辑 ----
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

function removeGroup(board, stones) {
  for (const [r, c] of stones) board[r][c] = 0;
}

function isValidMove(board, row, col, color, size) {
  if (board[row][col] !== 0) return false;
  const testBoard = board.map(r => [...r]);
  testBoard[row][col] = color;
  const opponent = color === 1 ? 2 : 1;
  for (const [nr, nc] of getNeighbors(row, col, size)) {
    if (testBoard[nr][nc] === opponent) {
      const group = getGroup(testBoard, nr, nc, size);
      if (group.liberties === 0) removeGroup(testBoard, group.stones);
    }
  }
  const selfGroup = getGroup(testBoard, row, col, size);
  return selfGroup.liberties > 0;
}

function findRandomValidMove(board, color, size) {
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
  let captured = 0;
  for (const [nr, nc] of getNeighbors(row, col, size)) {
    if (newBoard[nr][nc] === opponent) {
      const group = getGroup(newBoard, nr, nc, size);
      if (group.liberties === 0) {
        captured += group.stones.length;
        removeGroup(newBoard, group.stones);
      }
    }
  }
  return { board: newBoard, captured };
}

// ---- API 工具 ----
async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers, signal: AbortSignal.timeout(120000) }; // 2分钟超时
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  return res.json();
}

// ---- 全局统计 ----
const stats = {
  gnugo: { users: 0, moves: 0, errors: 0, passes: 0, totalTime: 0, delays: 0, delayUsers: [] },
  katago: { users: 0, moves: 0, errors: 0, passes: 0, totalTime: 0, delays: 0, delayUsers: [] },
  startTime: Date.now(),
};

// 实时进度计数器
let completedUsers = 0;
let activeGames = 0;

function printProgress() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  console.log(`[${elapsed}s] 活跃对弈: ${activeGames} | GnuGo: ${stats.gnugo.moves}步 ${stats.gnugo.errors}错 ${stats.gnugo.delays}延迟 | KataGo: ${stats.katago.moves}步 ${stats.katago.errors}错 ${stats.katago.delays}延迟 | 完成: ${completedUsers}/${GNUGO_USERS + KATAGO_USERS}`);
}

// ---- 单用户对弈 ----
async function runUser(engine, userId) {
  const tag = `[${engine === 'gnugo' ? 'G' : 'K'}${userId}]`;
  const userDelays = { count: 0 }; // 该用户延迟次数
  const userIdx = engine === 'gnugo' ? userId : userId + 100; // 确保不重叠

  let gameStarted = false;
  try {
    // 注册
    const rid = Math.random().toString(36).slice(2, 5);
    const nickname = `t${userIdx}_${rid}`;
    let token;
    let regResult = await api('POST', '/api/auth/register', { nickname, password: 'test1234' });
    if (regResult.token) {
      token = regResult.token;
    } else {
      // 换名重试
      const rid2 = Math.random().toString(36).slice(2, 5);
      const nick2 = `t${userIdx}_${rid2}`;
      regResult = await api('POST', '/api/auth/register', { nickname: nick2, password: 'test1234' });
      if (!regResult.token) throw new Error(`注册失败: ${regResult.error}`);
      token = regResult.token;
    }

    stats[engine].users++;
    activeGames++;
    gameStarted = true;
    console.log(`${tag} ✓ 已注册，开始对弈`);

    // 创建棋局
    const gameResult = await api('POST', '/api/games', {
      boardSize: BOARD_SIZE,
      difficulty: DIFFICULTY,
      engine,
      title: `${BOARD_SIZE}路 ${DIFFICULTY} ${engine} 压测`,
      moves: [],
      status: 'playing',
    }, token);
    const gameId = gameResult.game?.id || gameResult.id;

    let board = createEmptyBoard(BOARD_SIZE);
    let moves = [];
    let playerColor = 1; // 黑先

    for (let step = 1; step <= MAX_STEPS; step++) {
      // 玩家落子
      const move = findRandomValidMove(board, playerColor, BOARD_SIZE);
      if (!move) {
        console.log(`${tag} 第${step}步 无合法落子，结束`);
        break;
      }

      const [row, col] = move;
      const moveRecord = { row, col, color: playerColor };
      moves.push(moveRecord);
      const result = applyMove(board, row, col, playerColor, BOARD_SIZE);
      board = result.board;

      // 调用引擎，计时
      const t0 = Date.now();
      let engineResult;
      try {
        engineResult = await api('POST', '/api/go-engine', {
          boardSize: BOARD_SIZE,
          difficulty: DIFFICULTY,
          engine,
          moves,
        }, token);
      } catch (e) {
        stats[engine].errors++;
        console.log(`${tag} 第${step}步 请求异常: ${e.message}`);
        break;
      }

      const elapsed = Date.now() - t0;
      const usedEngine = engineResult.engine || (engineResult.noEngine ? 'local' : engine);

      // 判断是否需要延迟（AI响应超过10秒）
      let delayed = false;
      if (elapsed > STEP_INTERVAL_MS) {
        userDelays.count++;
        stats[engine].delays++;
        delayed = true;
      }

      stats[engine].moves++;
      stats[engine].totalTime += elapsed;

      const delayMark = delayed ? ` ⏳+1延迟(${userDelays.count}次)` : '';
      const engineMark = usedEngine !== engine ? ` [${usedEngine}]` : '';
      console.log(`${tag} 第${step}步 ${elapsed}ms${engineMark}${delayMark}`);

      // 错误处理
      if (engineResult.error && !engineResult.insufficientPoints) {
        stats[engine].errors++;
        console.log(`${tag} 引擎错误: ${engineResult.error}`);
        break;
      }

      if (engineResult.insufficientPoints) {
        console.log(`${tag} 积分不足，退出`);
        break;
      }

      // AI停手
      if (engineResult.pass) {
        stats[engine].passes++;
        console.log(`${tag} AI停手，结束`);
        break;
      }

      // AI落子
      if (engineResult.move) {
        const aiColor = playerColor === 1 ? 2 : 1;
        const aiResult = applyMove(board, engineResult.move.row, engineResult.move.col, aiColor, BOARD_SIZE);
        board = aiResult.board;
        moves.push({ row: engineResult.move.row, col: engineResult.move.col, color: aiColor });
      }

      // 每5步更新棋局（保持活跃对弈状态）
      if (step % 5 === 0 && gameId) {
        await api('PUT', `/api/games/${gameId}`, {
          moves,
          status: 'playing',
        }, token).catch(() => {});
      }

      // 等待间隔（扣除AI响应时间）
      if (step < MAX_STEPS) {
        const waitTime = Math.max(0, STEP_INTERVAL_MS - elapsed);
        await new Promise(r => setTimeout(r, waitTime));
      }
    }

    // 结束棋局
    if (gameId) {
      await api('PUT', `/api/games/${gameId}`, {
        moves,
        status: 'finished',
      }, token).catch(() => {});
    }

    // 记录延迟统计
    if (userDelays.count > 0) {
      stats[engine].delayUsers.push({ userId, delays: userDelays.count });
    }

  } catch (e) {
    stats[engine].errors++;
    console.log(`${tag} 异常退出: ${e.message}`);
  } finally {
    if (gameStarted) activeGames--;
    completedUsers++;
  }
}

// ---- 主流程 ----
async function main() {
  console.log('='.repeat(70));
  console.log('  双引擎压力测试 v2');
  console.log('='.repeat(70));
  console.log(`  目标: ${BASE_URL}`);
  console.log(`  GnuGo用户: ${GNUGO_USERS}  |  KataGo用户: ${KATAGO_USERS}`);
  console.log(`  每步间隔: ${STEP_INTERVAL_MS / 1000}s  |  最多步数: ${MAX_STEPS}`);
  console.log(`  棋盘: ${BOARD_SIZE}路 ${DIFFICULTY}`);
  console.log(`  启动错峰: ${STAGGER_DELAY_MS}ms/用户`);
  console.log('='.repeat(70));

  // 检查引擎状态
  try {
    const engineStatus = await api('GET', '/api/go-engine');
    const kt = engineStatus.engines?.find(e => e.id === 'katago');
    const gn = engineStatus.engines?.find(e => e.id === 'gnugo');
    console.log(`  KataGo: ${kt?.available ? '✓ 可用' : '✗ 不可用'}  |  GnuGo: ${gn?.available ? '✓ 可用' : '✗ 不可用'}`);
    console.log(`  当前队列: ${engineStatus.queueLength}  |  正在处理: ${engineStatus.isProcessing}`);
  } catch (e) {
    console.log(`  无法获取引擎状态: ${e.message}`);
  }
  console.log('');

  // 启动进度监控（每15秒输出一次）
  const progressTimer = setInterval(printProgress, 15000);

  const startTime = Date.now();

  // 错峰启动用户
  const allPromises = [];
  let launchIndex = 0;

  // GnuGo 用户 (1-50)
  for (let i = 1; i <= GNUGO_USERS; i++) {
    launchIndex++;
    const delay = launchIndex * STAGGER_DELAY_MS;
    allPromises.push(
      new Promise(r => setTimeout(r, delay)).then(() => runUser('gnugo', i))
    );
  }

  // KataGo 用户 (51-100)
  for (let i = 51; i <= 50 + KATAGO_USERS; i++) {
    launchIndex++;
    const delay = launchIndex * STAGGER_DELAY_MS;
    allPromises.push(
      new Promise(r => setTimeout(r, delay)).then(() => runUser('katago', i))
    );
  }

  console.log(`已调度 ${launchIndex} 个用户，错峰启动中...`);
  console.log(`预计全部启动完毕: ~${((launchIndex * STAGGER_DELAY_MS) / 1000).toFixed(1)}s`);
  console.log('');

  // 等待全部完成
  await Promise.allSettled(allPromises);

  clearInterval(progressTimer);

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 最终进度
  printProgress();

  console.log('');
  console.log('='.repeat(70));
  console.log('  压力测试完成');
  console.log('='.repeat(70));
  console.log(`  总耗时: ${totalElapsed}s`);

  for (const eng of ['gnugo', 'katago']) {
    const s = stats[eng];
    const total = eng === 'gnugo' ? GNUGO_USERS : KATAGO_USERS;
    const avgTime = s.moves > 0 ? (s.totalTime / s.moves / 1000).toFixed(2) : 'N/A';
    const avgDelays = s.delayUsers.length > 0
      ? (s.delayUsers.reduce((a, b) => a + b.delays, 0) / s.delayUsers.length).toFixed(1)
      : 0;
    const maxDelays = s.delayUsers.length > 0
      ? Math.max(...s.delayUsers.map(u => u.delays))
      : 0;

    console.log('');
    console.log(`  --- ${eng.toUpperCase()} ---`);
    console.log(`  成功用户: ${s.users}/${total}`);
    console.log(`  总落子: ${s.moves}  |  错误: ${s.errors}  |  AI停手: ${s.passes}`);
    console.log(`  平均每步: ${avgTime}s`);
    console.log(`  延迟统计: 总延迟${s.delays}次 | 涉及${s.delayUsers.length}人 | 人均${avgDelays}次 | 最多${maxDelays}次`);
    if (s.delayUsers.length > 0 && s.delayUsers.length <= 20) {
      console.log(`  延迟详情: ${s.delayUsers.map(u => `${eng === 'gnugo' ? 'G' : 'K'}${u.userId}:${u.delays}次`).join(' ')}`);
    }
  }
}

main().catch(console.error);
