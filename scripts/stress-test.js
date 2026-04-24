/**
 * 双引擎压力测试脚本 v3
 *
 * 针对线上 letusgoa.cn，测试双引擎常驻架构的并发能力
 *
 * 三种测试模式：
 *   1. genmove  — 纯对弈引擎压力测试
 *   2. analyze  — 纯分析引擎压力测试（模拟大量用户同时点"教学提示"）
 *   3. mixed    — 混合压力（对弈 + 分析同时进行），验证两引擎互不阻塞
 *
 * 用法:
 *   node scripts/stress-test.js [模式] [BASE_URL]
 *
 * 示例:
 *   node scripts/stress-test.js genmove
 *   node scripts/stress-test.js analyze https://letusgoa.cn
 *   node scripts/stress-test.js mixed
 *
 * 环境变量:
 *   GENMOVE_USERS     对弈并发用户数，默认 10
 *   ANALYZE_USERS     分析并发用户数，默认 20
 *   BOARD_SIZE        棋盘大小，默认 19
 *   DIFFICULTY        easy | medium | hard，默认 hard
 *   STEP_INTERVAL_MS  每步间隔(ms)，默认 8000
 *   MAX_STEPS         每局最多步数，默认 15
 */

const MODE = process.argv[2] || 'mixed';
const BASE_URL = process.argv[3] || 'https://letusgoa.cn';

const GENMOVE_USERS = parseInt(process.env.GENMOVE_USERS || '10', 10);
const ANALYZE_USERS = parseInt(process.env.ANALYZE_USERS || '20', 10);
const BOARD_SIZE = parseInt(process.env.BOARD_SIZE || '19', 10);
const DIFFICULTY = process.env.DIFFICULTY || 'hard';
const STEP_INTERVAL_MS = parseInt(process.env.STEP_INTERVAL_MS || '8000', 10);
const MAX_STEPS = parseInt(process.env.MAX_STEPS || '15', 10);
const STAGGER_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 120000;

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
  for (const [nr, nc] of getNeighbors(row, col, size)) {
    if (newBoard[nr][nc] === opponent) {
      const group = getGroup(newBoard, nr, nc, size);
      if (group.liberties === 0) removeGroup(newBoard, group.stones);
    }
  }
  return newBoard;
}

// ---- API 工具 ----
async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  return res.json();
}

// ---- 全局统计 ----
const stats = {
  genmove: { requests: 0, success: 0, errors: 0, passes: 0, totalTime: 0, maxTime: 0, delays: 0 },
  analyze: { requests: 0, success: 0, errors: 0, totalTime: 0, maxTime: 0, delays: 0, totalVisits: 0 },
  startTime: Date.now(),
};

let activeGenmove = 0;
let activeAnalyze = 0;
let completedGenmove = 0;
let completedAnalyze = 0;

function printProgress() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const gm = stats.genmove;
  const an = stats.analyze;
  const gmAvg = gm.requests > 0 ? (gm.totalTime / gm.requests / 1000).toFixed(1) : '-';
  const anAvg = an.requests > 0 ? (an.totalTime / an.requests / 1000).toFixed(1) : '-';
  console.log(
    `[${elapsed}s] 活跃: GM=${activeGenmove} AN=${activeAnalyze} | ` +
    `GM: ${gm.requests}请求 ${gm.success}成功 ${gmAvg}s均耗 ${gm.delays}延迟 | ` +
    `AN: ${an.requests}请求 ${an.success}成功 ${anAvg}s均耗 ${an.delays}延迟 | ` +
    `完成: GM=${completedGenmove}/${MODE === 'analyze' ? 0 : GENMOVE_USERS} ` +
    `AN=${completedAnalyze}/${MODE === 'genmove' ? 0 : ANALYZE_USERS}`
  );
}

// ---- 对弈压力测试（genmove 引擎） ----
async function runGenmoveUser(userId) {
  const tag = `[GM${userId}]`;
  const userIdx = userId;
  let token;
  let gameStarted = false;

  try {
    const rid = Math.random().toString(36).slice(2, 5);
    const nickname = `gm${userIdx}_${rid}`;
    let regResult = await api('POST', '/api/auth/register', { nickname, password: 'test1234' });
    if (!regResult.token) {
      regResult = await api('POST', '/api/auth/register', { nickname: nickname + 'x', password: 'test1234' });
    }
    if (!regResult.token) throw new Error(`注册失败: ${regResult.error}`);
    token = regResult.token;

    gameStarted = true;
    activeGenmove++;
    console.log(`${tag} 开始对弈`);

    const gameResult = await api('POST', '/api/games', {
      boardSize: BOARD_SIZE, difficulty: DIFFICULTY, engine: 'katago',
      title: `压测-GM-${BOARD_SIZE}路-${DIFFICULTY}`, moves: [], status: 'playing',
    }, token);
    const gameId = gameResult.game?.id || gameResult.id;

    let board = createEmptyBoard(BOARD_SIZE);
    let moves = [];
    let playerColor = 1;

    for (let step = 1; step <= MAX_STEPS; step++) {
      const move = findRandomValidMove(board, playerColor, BOARD_SIZE);
      if (!move) break;
      const [row, col] = move;
      moves.push({ row, col, color: playerColor });
      board = applyMove(board, row, col, playerColor, BOARD_SIZE);

      const t0 = Date.now();
      let engineResult;
      try {
        engineResult = await api('POST', '/api/go-engine', {
          boardSize: BOARD_SIZE, difficulty: DIFFICULTY, engine: 'katago', moves,
        }, token);
      } catch (e) {
        stats.genmove.errors++;
        console.log(`${tag} 第${step}步 异常: ${e.message}`);
        break;
      }
      const elapsed = Date.now() - t0;

      stats.genmove.requests++;
      stats.genmove.totalTime += elapsed;
      if (elapsed > stats.genmove.maxTime) stats.genmove.maxTime = elapsed;
      if (elapsed > STEP_INTERVAL_MS) stats.genmove.delays++;

      const delayMark = elapsed > STEP_INTERVAL_MS ? ' ⏳' : '';
      console.log(`${tag} #${step} ${elapsed}ms${delayMark}`);

      if (engineResult.error && !engineResult.insufficientPoints) {
        stats.genmove.errors++;
        break;
      }
      if (engineResult.insufficientPoints) {
        console.log(`${tag} 积分不足`);
        break;
      }

      if (engineResult.move) {
        const aiColor = playerColor === 1 ? 2 : 1;
        board = applyMove(board, engineResult.move.row, engineResult.move.col, aiColor, BOARD_SIZE);
        moves.push({ row: engineResult.move.row, col: engineResult.move.col, color: aiColor });
        stats.genmove.success++;
      } else if (engineResult.pass) {
        stats.genmove.passes++;
        stats.genmove.success++;
        console.log(`${tag} AI停手`);
        break;
      }

      if (step % 5 === 0 && gameId) {
        await api('PUT', `/api/games/${gameId}`, { moves, status: 'playing' }, token).catch(() => {});
      }

      if (step < MAX_STEPS) {
        await new Promise(r => setTimeout(r, Math.max(0, STEP_INTERVAL_MS - elapsed)));
      }
    }

    if (gameId) {
      await api('PUT', `/api/games/${gameId}`, { moves, status: 'finished' }, token).catch(() => {});
    }
  } catch (e) {
    stats.genmove.errors++;
    console.log(`${tag} 异常: ${e.message}`);
  } finally {
    if (gameStarted) activeGenmove--;
    completedGenmove++;
  }
}

// ---- 分析压力测试（analyze 引擎） ----
async function runAnalyzeUser(userId) {
  const tag = `[AN${userId}]`;
  const userIdx = userId + 200;
  let token;
  let started = false;

  try {
    const rid = Math.random().toString(36).slice(2, 5);
    const nickname = `an${userIdx}_${rid}`;
    let regResult = await api('POST', '/api/auth/register', { nickname, password: 'test1234' });
    if (!regResult.token) {
      regResult = await api('POST', '/api/auth/register', { nickname: nickname + 'x', password: 'test1234' });
    }
    if (!regResult.token) throw new Error(`注册失败: ${regResult.error}`);
    token = regResult.token;

    started = true;
    activeAnalyze++;
    console.log(`${tag} 开始分析压测`);

    // 预构造一段棋谱
    let board = createEmptyBoard(BOARD_SIZE);
    let moves = [];
    let color = 1;
    for (let i = 0; i < 8; i++) {
      const move = findRandomValidMove(board, color, BOARD_SIZE);
      if (!move) break;
      const [row, col] = move;
      moves.push({ row, col, color });
      board = applyMove(board, row, col, color, BOARD_SIZE);
      color = color === 1 ? 2 : 1;
    }

    // 循环点击"教学提示"，模拟真实用户行为
    for (let round = 1; round <= MAX_STEPS; round++) {
      // 每轮追加一手，让局面变化
      if (round > 1) {
        const move = findRandomValidMove(board, color, BOARD_SIZE);
        if (move) {
          const [row, col] = move;
          moves.push({ row, col, color });
          board = applyMove(board, row, col, color, BOARD_SIZE);
          color = color === 1 ? 2 : 1;
        }
      }

      const t0 = Date.now();
      let result;
      try {
        result = await api('POST', '/api/go-engine', {
          action: 'analyze',
          boardSize: BOARD_SIZE,
          moves,
          difficulty: DIFFICULTY,
        }, token);
      } catch (e) {
        stats.analyze.errors++;
        console.log(`${tag} #${round} 异常: ${e.message}`);
        break;
      }
      const elapsed = Date.now() - t0;

      stats.analyze.requests++;
      stats.analyze.totalTime += elapsed;
      if (elapsed > stats.analyze.maxTime) stats.analyze.maxTime = elapsed;
      if (elapsed > STEP_INTERVAL_MS) stats.analyze.delays++;

      const visits = result?.analysis?.actualVisits || 0;
      stats.analyze.totalVisits += visits;

      const ok = !!result?.analysis;
      if (ok) stats.analyze.success++;
      else stats.analyze.errors++;

      const delayMark = elapsed > STEP_INTERVAL_MS ? ' ⏳' : '';
      console.log(`${tag} #${round} ${elapsed}ms visits=${visits} ${ok ? '✓' : '✗'}${delayMark}`);

      if (result?.insufficientPoints) {
        console.log(`${tag} 积分不足`);
        break;
      }

      await new Promise(r => setTimeout(r, Math.max(0, STEP_INTERVAL_MS - elapsed)));
    }
  } catch (e) {
    stats.analyze.errors++;
    console.log(`${tag} 异常: ${e.message}`);
  } finally {
    if (started) activeAnalyze--;
    completedAnalyze++;
  }
}

// ---- 主流程 ----
async function main() {
  console.log('='.repeat(70));
  console.log('  双引擎压力测试 v3');
  console.log('  目标:', BASE_URL);
  console.log('  模式:', MODE);
  console.log('  棋盘:', BOARD_SIZE, '路', DIFFICULTY);
  console.log('  对弈用户:', MODE === 'analyze' ? 0 : GENMOVE_USERS);
  console.log('  分析用户:', MODE === 'genmove' ? 0 : ANALYZE_USERS);
  console.log('  每步间隔:', STEP_INTERVAL_MS, 'ms | 最大步数:', MAX_STEPS);
  console.log('='.repeat(70));

  // 检查引擎状态
  try {
    const status = await api('GET', '/api/go-engine');
    const kt = status.engines?.find(e => e.id === 'katago');
    console.log(`  KataGo: ${kt?.available ? '✓ 可用' : '✗ 不可用'}`);
    console.log(`  对弈模型: ${status.katago?.gameModel?.name || '-'}`);
    console.log(`  分析模型: ${status.katago?.analysisModel?.name || '-'}`);
  } catch (e) {
    console.log(`  无法获取引擎状态: ${e.message}`);
  }
  console.log('');

  const progressTimer = setInterval(printProgress, 15000);
  const startTime = Date.now();

  const allPromises = [];
  let launchIndex = 0;

  if (MODE !== 'analyze') {
    for (let i = 1; i <= GENMOVE_USERS; i++) {
      launchIndex++;
      const delay = launchIndex * STAGGER_DELAY_MS;
      allPromises.push(
        new Promise(r => setTimeout(r, delay)).then(() => runGenmoveUser(i))
      );
    }
  }

  if (MODE !== 'genmove') {
    for (let i = 1; i <= ANALYZE_USERS; i++) {
      launchIndex++;
      const delay = launchIndex * STAGGER_DELAY_MS;
      allPromises.push(
        new Promise(r => setTimeout(r, delay)).then(() => runAnalyzeUser(i))
      );
    }
  }

  console.log(`已调度 ${launchIndex} 个用户，错峰启动中...`);
  console.log(`预计全部启动: ~${((launchIndex * STAGGER_DELAY_MS) / 1000).toFixed(1)}s`);
  console.log('');

  await Promise.allSettled(allPromises);
  clearInterval(progressTimer);

  const totalElapsed = (Date.now() - startTime) / 1000;

  printProgress();
  console.log('');
  console.log('='.repeat(70));
  console.log('  压力测试完成');
  console.log('='.repeat(70));
  console.log(`  总耗时: ${totalElapsed.toFixed(1)}s`);

  // 对弈统计
  if (stats.genmove.requests > 0) {
    const s = stats.genmove;
    const avg = (s.totalTime / s.requests / 1000).toFixed(2);
    const p99 = s.maxTime / 1000;
    const rps = (s.requests / totalElapsed).toFixed(1);
    console.log('');
    console.log('  --- 对弈引擎 (genmove) ---');
    console.log(`  请求: ${s.requests} | 成功: ${s.success} | 错误: ${s.errors} | AI停手: ${s.passes}`);
    console.log(`  平均: ${avg}s | 最大: ${p99.toFixed(1)}s | 延迟: ${s.delays}次 | RPS: ${rps}`);
    console.log(`  成功率: ${((s.success / s.requests) * 100).toFixed(1)}%`);
  }

  // 分析统计
  if (stats.analyze.requests > 0) {
    const s = stats.analyze;
    const avg = (s.totalTime / s.requests / 1000).toFixed(2);
    const p99 = s.maxTime / 1000;
    const avgVisits = Math.round(s.totalVisits / s.requests);
    const rps = (s.requests / totalElapsed).toFixed(1);
    console.log('');
    console.log('  --- 分析引擎 (analyze) ---');
    console.log(`  请求: ${s.requests} | 成功: ${s.success} | 错误: ${s.errors}`);
    console.log(`  平均: ${avg}s | 最大: ${p99.toFixed(1)}s | 延迟: ${s.delays}次 | RPS: ${rps}`);
    console.log(`  平均 visits: ${avgVisits}`);
    console.log(`  成功率: ${((s.success / s.requests) * 100).toFixed(1)}%`);
  }

  // 关键结论
  console.log('');
  console.log('  --- 关键结论 ---');
  if (MODE === 'mixed') {
    const gmBlocked = stats.genmove.delays > 0;
    const anBlocked = stats.analyze.delays > 0;
    if (!gmBlocked && !anBlocked) {
      console.log('  ✓ 两引擎互不阻塞（无互相延迟）');
    } else {
      console.log(`  ${gmBlocked ? '✗' : '✓'} 对弈引擎${gmBlocked ? '有' : '无'}延迟`);
      console.log(`  ${anBlocked ? '✗' : '✓'} 分析引擎${anBlocked ? '有' : '无'}延迟`);
    }
  }
  console.log('='.repeat(70));
}

main().catch(console.error);
