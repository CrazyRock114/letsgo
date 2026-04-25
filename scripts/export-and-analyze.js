/**
 * AI对弈数据导出与分析脚本
 *
 * 1. 从 Supabase 导出 ai-test 棋局数据
 * 2. 整理本地 ai-events 日志
 * 3. 生成统计摘要
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// 读取环境变量
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.+)$/);
  if (match) env[match[1]] = match[2].trim();
});

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

async function exportGames() {
  console.log('[导出] 查询 Supabase letsgo_games 表...');

  const { data, error } = await supabase
    .from('letsgo_games')
    .select('*')
    .is('user_id', null)
    .eq('board_size', 9)
    .eq('status', 'finished')
    .gte('created_at', '2026-04-24T19:00:00Z')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[导出错误]', error);
    throw error;
  }

  console.log(`[导出] 共 ${data.length} 局 finished 棋局`);

  const outputPath = path.join(REPORTS_DIR, 'ai-test-games', 'ai-test-games-raw.json');
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`[导出] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

  return data;
}

function analyzeAiEvents() {
  const logsDir = path.join(__dirname, '..', 'logs', 'ai-events');
  const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl')).sort();

  const CUTOFF_TIME = '2026-04-24T19:00:00Z';
  const allEvents = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(logsDir, file), 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.ts >= CUTOFF_TIME) allEvents.push(evt);
      } catch {}
    }
  }

  console.log(`\n[日志] 共 ${allEvents.length} 条引擎事件`);

  // 按类型统计
  const byType = {};
  const byModel = {};
  const byDifficulty = {};
  const genmoveDurations = [];
  const analyzeDurations = [];
  const analyzeVisits = [];
  const errors = [];
  const modelSwitches = [];

  for (const e of allEvents) {
    // by type
    byType[e.type] = (byType[e.type] || 0) + 1;

    // by model
    if (e.model) {
      byModel[e.model] = byModel[e.model] || { genmove: 0, analyze: 0, error: 0 };
      byModel[e.model][e.type === 'genmove' ? 'genmove' : e.type === 'analyze' ? 'analyze' : 'error']++;
    }

    // by difficulty
    if (e.difficulty) {
      byDifficulty[e.difficulty] = byDifficulty[e.difficulty] || { count: 0, totalDuration: 0, errors: 0 };
      byDifficulty[e.difficulty].count++;
      if (e.durationMs) byDifficulty[e.difficulty].totalDuration += e.durationMs;
      if (e.type === 'engine_error') byDifficulty[e.difficulty].errors++;
    }

    // durations & visits
    if (e.type === 'genmove' && e.durationMs) genmoveDurations.push(e.durationMs);
    if (e.type === 'analyze') {
      if (e.durationMs) analyzeDurations.push(e.durationMs);
      if (e.metadata?.visits) analyzeVisits.push(e.metadata.visits);
    }

    // errors
    if (e.type === 'engine_error') {
      errors.push({ model: e.model, error: e.error, boardSize: e.boardSize, difficulty: e.difficulty, durationMs: e.durationMs });
    }

    // model switches
    if (e.type === 'model_switch') {
      modelSwitches.push({ ts: e.ts, model: e.model });
    }
  }

  function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  const summary = {
    totalEvents: allEvents.length,
    byType,
    byModel,
    byDifficulty: Object.fromEntries(
      Object.entries(byDifficulty).map(([k, v]) => [
        k,
        {
          count: v.count,
          avgDurationMs: v.count > 0 ? Math.round(v.totalDuration / v.count) : 0,
          errors: v.errors,
        },
      ])
    ),
    genmove: {
      count: genmoveDurations.length,
      avgMs: genmoveDurations.length > 0 ? Math.round(genmoveDurations.reduce((a, b) => a + b, 0) / genmoveDurations.length) : 0,
      p50: genmoveDurations.length > 0 ? percentile(genmoveDurations, 0.5) : 0,
      p95: genmoveDurations.length > 0 ? percentile(genmoveDurations, 0.95) : 0,
      p99: genmoveDurations.length > 0 ? percentile(genmoveDurations, 0.99) : 0,
      maxMs: genmoveDurations.length > 0 ? Math.max(...genmoveDurations) : 0,
    },
    analyze: {
      count: analyzeDurations.length,
      avgMs: analyzeDurations.length > 0 ? Math.round(analyzeDurations.reduce((a, b) => a + b, 0) / analyzeDurations.length) : 0,
      p50: analyzeDurations.length > 0 ? percentile(analyzeDurations, 0.5) : 0,
      p95: analyzeDurations.length > 0 ? percentile(analyzeDurations, 0.95) : 0,
      p99: analyzeDurations.length > 0 ? percentile(analyzeDurations, 0.99) : 0,
      maxMs: analyzeDurations.length > 0 ? Math.max(...analyzeDurations) : 0,
      hasDurationData: analyzeDurations.length > 0,
    },
    analyzeVisits: {
      count: analyzeVisits.length,
      avg: analyzeVisits.length > 0 ? Math.round(analyzeVisits.reduce((a, b) => a + b, 0) / analyzeVisits.length) : 0,
      min: analyzeVisits.length > 0 ? Math.min(...analyzeVisits) : 0,
      max: analyzeVisits.length > 0 ? Math.max(...analyzeVisits) : 0,
      p50: analyzeVisits.length > 0 ? percentile(analyzeVisits, 0.5) : 0,
    },
    errors: {
      count: errors.length,
      breakdown: errors.reduce((acc, e) => {
        const key = `${e.error}(${e.model || '?'})`;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      details: errors.slice(0, 20),
    },
    modelSwitches: {
      count: modelSwitches.length,
      history: modelSwitches,
    },
    timeRange: {
      first: allEvents.length > 0 ? allEvents[0].ts : null,
      last: allEvents.length > 0 ? allEvents[allEvents.length - 1].ts : null,
    },
  };

  const outputPath = path.join(REPORTS_DIR, 'ai-test-games', 'ai-events-summary.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`[日志] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

  return summary;
}

async function analyzeGames(games) {
  console.log('\n[分析] 棋局质量统计...');

  let totalMoves = 0;
  let blackWins = 0;
  let whiteWins = 0;
  let passes = 0;
  const scoreDiffs = [];
  const moveCounts = [];
  const heatmapBlack = Array(9).fill(null).map(() => Array(9).fill(0));
  const heatmapWhite = Array(9).fill(null).map(() => Array(9).fill(0));
  const winRateTrajectories = [];
  const scoreLeadTrajectories = [];
  const koPositions = new Set();
  let totalVisitsAI = 0;
  let aiMoveCount = 0;
  let totalVisitsOpponent = 0;
  let opponentMoveCount = 0;

  for (const game of games) {
    const moves = game.moves || [];
    const commentaries = game.commentaries || [];
    const config = game.config || {};
    const aiColor = config.aiPlayer?.color || 'black';
    const opponentEngine = config.opponent?.engine || 'katago';

    moveCounts.push(moves.length);
    totalMoves += moves.length;

    // 胜负统计
    const blackScore = game.black_score || 0;
    const whiteScore = game.white_score || 0;
    if (blackScore > whiteScore) blackWins++;
    else if (whiteScore > blackScore) whiteWins++;
    scoreDiffs.push(blackScore - whiteScore);

    // 落子热力图 + pass统计 + visits统计
    const boardState = Array(9).fill(null).map(() => Array(9).fill(null));
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (!move) continue;

      const color = move.color;
      const pos = move.position;

      if (move.pass || !pos) {
        passes++;
        continue;
      }

      const { row, col } = pos;
      if (row >= 0 && row < 9 && col >= 0 && col < 9) {
        if (color === 'black') heatmapBlack[row][col]++;
        else heatmapWhite[row][col]++;

        // 检测打劫（同一位置被不同颜色先后落子）
        if (boardState[row][col] && boardState[row][col] !== color) {
          koPositions.add(`${row},${col}`);
        }
        boardState[row][col] = color;
      }

      // 统计手数 + visits
      if (color === aiColor) {
        aiMoveCount++;
        if (move.analysis) totalVisitsAI += move.analysis.actualVisits || 0;
      } else {
        opponentMoveCount++;
        if (move.analysis) totalVisitsOpponent += move.analysis.actualVisits || 0;
      }
    }

    // 胜率/目差轨迹（从 commentaries 提取）
    const wrTraj = [];
    const slTraj = [];
    for (const c of commentaries) {
      if (c.commentary) {
        // 从解说文本提取胜率
        const wrMatch = c.commentary.match(/胜率([\d.]+)%/);
        if (wrMatch) wrTraj.push(parseFloat(wrMatch[1]));

        // 从解说文本提取目差
        const slMatch = c.commentary.match(/目差([+-]?[\d.]+)/);
        if (slMatch) slTraj.push(parseFloat(slMatch[1]));
      }
    }
    if (wrTraj.length > 0) winRateTrajectories.push(wrTraj);
    if (slTraj.length > 0) scoreLeadTrajectories.push(slTraj);
  }

  // 统计摘要
  const avgMoves = games.length > 0 ? Math.round(totalMoves / games.length * 10) / 10 : 0;
  const avgScoreDiff = scoreDiffs.length > 0
    ? Math.round(scoreDiffs.reduce((a, b) => a + b, 0) / scoreDiffs.length * 10) / 10
    : 0;

  const gameAnalysis = {
    totalGames: games.length,
    totalMoves,
    avgMovesPerGame: avgMoves,
    blackWins,
    whiteWins,
    drawOrUnknown: games.length - blackWins - whiteWins,
    passes,
    avgScoreDiff,
    scoreDiffDistribution: {
      'black_crush(>20)': scoreDiffs.filter(d => d > 20).length,
      'black_win(5~20)': scoreDiffs.filter(d => d > 5 && d <= 20).length,
      'close(-5~5)': scoreDiffs.filter(d => d >= -5 && d <= 5).length,
      'white_win(-20~-5)': scoreDiffs.filter(d => d >= -20 && d < -5).length,
      'white_crush(<-20)': scoreDiffs.filter(d => d < -20).length,
    },
    moveCountDistribution: {
      'very_short(<20)': moveCounts.filter(m => m < 20).length,
      'short(20~40)': moveCounts.filter(m => m >= 20 && m < 40).length,
      'medium(40~60)': moveCounts.filter(m => m >= 40 && m < 60).length,
      'long(60~80)': moveCounts.filter(m => m >= 60 && m < 80).length,
      'very_long(>=80)': moveCounts.filter(m => m >= 80).length,
    },
    heatmapBlack,
    heatmapWhite,
    koPoints: Array.from(koPositions),
    aiPlayer: {
      avgVisits: aiMoveCount > 0 ? Math.round(totalVisitsAI / aiMoveCount) : 0,
      totalMoves: aiMoveCount,
    },
    opponentPlayer: {
      avgVisits: opponentMoveCount > 0 ? Math.round(totalVisitsOpponent / opponentMoveCount) : 0,
      totalMoves: opponentMoveCount,
    },
    sampleWinRateTrajectories: winRateTrajectories.slice(0, 5),
    sampleScoreLeadTrajectories: scoreLeadTrajectories.slice(0, 5),
  };

  const outputPath = path.join(REPORTS_DIR, 'ai-test-games', 'ai-test-game-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(gameAnalysis, null, 2));
  console.log(`[分析] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

  return gameAnalysis;
}

async function generateReport(games, eventSummary, gameAnalysis) {
  console.log('\n[报告] 生成 Markdown 报告...');

  // 提取 config 样本确认对弈配置
  const sampleConfigs = games.slice(0, 5).map(g => ({
    title: g.title,
    config: g.config,
    engine: g.engine,
    difficulty: g.difficulty,
  }));

  const report = `# AI对弈棋局深度分析报告

> 生成时间: ${new Date().toISOString()}
> 数据来源: Supabase letsgo_games + 本地 ai-events 日志

---

## 一、数据概览

| 指标 | 数值 |
|------|------|
| 导出棋局数 | ${gameAnalysis.totalGames} |
| 总手数 | ${gameAnalysis.totalMoves} |
| 平均每局手数 | ${gameAnalysis.avgMovesPerGame} |
| 日志事件总数 | ${eventSummary.totalEvents} |
| 日志时间范围 | ${eventSummary.timeRange.first || 'N/A'} ~ ${eventSummary.timeRange.last || 'N/A'} |

## 二、对弈配置样本

\`\`\`json
${JSON.stringify(sampleConfigs, null, 2)}
\`\`\`

## 三、引擎性能统计（基于 ai-events 日志）

### 3.1 事件类型分布

| 类型 | 次数 |
|------|------|
${Object.entries(eventSummary.byType).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

### 3.2 Genmove 性能

| 指标 | 数值 |
|------|------|
| 总次数 | ${eventSummary.genmove.count} |
| 平均耗时 | ${eventSummary.genmove.avgMs}ms |
| P50 | ${eventSummary.genmove.p50}ms |
| P95 | ${eventSummary.genmove.p95}ms |
| P99 | ${eventSummary.genmove.p99}ms |
| 最大耗时 | ${eventSummary.genmove.maxMs}ms |

### 3.3 Analyze 性能

| 指标 | 数值 |
|------|------|
| 总次数 | ${eventSummary.analyze.count} |
| 平均耗时 | ${eventSummary.analyze.hasDurationData ? eventSummary.analyze.avgMs + 'ms' : '未记录（旧日志缺少durationMs）'} |
| P50 | ${eventSummary.analyze.hasDurationData ? eventSummary.analyze.p50 + 'ms' : '-'} |
| P95 | ${eventSummary.analyze.hasDurationData ? eventSummary.analyze.p95 + 'ms' : '-'} |
| P99 | ${eventSummary.analyze.hasDurationData ? eventSummary.analyze.p99 + 'ms' : '-'} |
| 最大耗时 | ${eventSummary.analyze.hasDurationData ? eventSummary.analyze.maxMs + 'ms' : '-'} |

### 3.3b Analyze Visits 分布（替代性能指标）

| 指标 | 数值 |
|------|------|
| 记录数 | ${eventSummary.analyzeVisits.count} |
| 平均 visits | ${eventSummary.analyzeVisits.avg} |
| P50 | ${eventSummary.analyzeVisits.p50} |
| 最小 | ${eventSummary.analyzeVisits.min} |
| 最大 | ${eventSummary.analyzeVisits.max} |

### 3.4 按模型统计

| 模型 | genmove | analyze | error |
|------|---------|---------|-------|
${Object.entries(eventSummary.byModel).map(([k, v]) => `| ${k} | ${v.genmove} | ${v.analyze} | ${v.error} |`).join('\n')}

### 3.5 错误统计

| 错误类型 | 次数 |
|----------|------|
${Object.entries(eventSummary.errors.breakdown).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

### 3.6 模型切换历史

共 ${eventSummary.modelSwitches.count} 次模型切换：

| 时间 | 切换至模型 |
|------|-----------|
${eventSummary.modelSwitches.history.map(s => `| ${s.ts} | ${s.model} |`).join('\n')}

## 四、棋局质量分析

### 4.1 胜负分布

| 结果 | 局数 |
|------|------|
| 黑胜 | ${gameAnalysis.blackWins} |
| 白胜 | ${gameAnalysis.whiteWins} |
| 未知/平局 | ${gameAnalysis.drawOrUnknown} |

### 4.2 终局目差分布

| 范围 | 局数 |
|------|------|
| 黑大胜 (>20目) | ${gameAnalysis.scoreDiffDistribution['black_crush(>20)']} |
| 黑胜 (5~20目) | ${gameAnalysis.scoreDiffDistribution['black_win(5~20)']} |
| 胶着 (-5~5目) | ${gameAnalysis.scoreDiffDistribution['close(-5~5)']} |
| 白胜 (-20~-5目) | ${gameAnalysis.scoreDiffDistribution['white_win(-20~-5)']} |
| 白大胜 (<-20目) | ${gameAnalysis.scoreDiffDistribution['white_crush(<-20)']} |

### 4.3 局长分布

| 长度 | 局数 |
|------|------|
| 很短 (<20手) | ${gameAnalysis.moveCountDistribution['very_short(<20)']} |
| 短 (20~40手) | ${gameAnalysis.moveCountDistribution['short(20~40)']} |
| 中等 (40~60手) | ${gameAnalysis.moveCountDistribution['medium(40~60)']} |
| 长 (60~80手) | ${gameAnalysis.moveCountDistribution['long(60~80)']} |
| 很长 (>=80手) | ${gameAnalysis.moveCountDistribution['very_long(>=80)']} |

### 4.4 AI 玩家 vs 对手 对比

| 指标 | AI 玩家 | 对手 |
|------|---------|------|
| 总手数 | ${gameAnalysis.aiPlayer.totalMoves} | ${gameAnalysis.opponentPlayer.totalMoves} |
| 平均 visits | ${gameAnalysis.aiPlayer.avgVisits} | ${gameAnalysis.opponentPlayer.avgVisits} |

### 4.5 打劫位置

共 ${gameAnalysis.koPoints.length} 个点出现过打劫：
${gameAnalysis.koPoints.map(p => `- (${p})`).join('\n')}

### 4.6 黑棋落子热力图 (9x9)

\`\`\`
${renderHeatmap(gameAnalysis.heatmapBlack, 'B')}
\`\`\`

### 4.7 白棋落子热力图 (9x9)

\`\`\`
${renderHeatmap(gameAnalysis.heatmapWhite, 'W')}
\`\`\`

### 4.8 胜率轨迹样本（前5局）

\`\`\`json
${JSON.stringify(gameAnalysis.sampleWinRateTrajectories, null, 2)}
\`\`\`

### 4.9 目差轨迹样本（前5局）

\`\`\`json
${JSON.stringify(gameAnalysis.sampleScoreLeadTrajectories, null, 2)}
\`\`\`

---

## 五、关键发现

1. **引擎稳定性**: ${eventSummary.errors.count === 0 ? '无错误记录，引擎运行稳定。' : `共 ${eventSummary.errors.count} 次引擎错误，需关注。`}
2. **响应延迟**: genmove P95 = ${eventSummary.genmove.p95}ms，analyze ${eventSummary.analyze.hasDurationData ? 'P95 = ' + eventSummary.analyze.p95 + 'ms' : '耗时未记录（visits平均' + eventSummary.analyzeVisits.avg + '）'}
3. **对弈时长**: 平均 ${gameAnalysis.avgMovesPerGame} 手/局，${gameAnalysis.moveCountDistribution['very_short(<20)']} 局过早结束（<20手）
4. **胜负平衡**: 黑胜 ${gameAnalysis.blackWins} vs 白胜 ${gameAnalysis.whiteWins}，${Math.abs(gameAnalysis.blackWins - gameAnalysis.whiteWins) <= 3 ? '胜负较为均衡' : '胜负有偏'}
5. **模型切换**: ${eventSummary.modelSwitches.count > 0 ? `共 ${eventSummary.modelSwitches.count} 次模型切换，旧架构痕迹。` : '无模型切换，常驻架构稳定。'}

---

*报告由 AI 自动生成，数据来源于实际运行日志。*
`;

  function renderHeatmap(heatmap, label) {
    const max = Math.max(...heatmap.flat());
    const lines = [];
    lines.push('   A B C D E F G H J');
    for (let r = 0; r < 9; r++) {
      const rowNum = 9 - r;
      const cells = heatmap[r].map((v, c) => {
        if (v === 0) return ' .';
        const intensity = Math.min(9, Math.ceil((v / max) * 9));
        return ` ${intensity}`;
      });
      lines.push(`${rowNum} ${cells.join('')}`);
    }
    return lines.join('\n');
  }

  const outputPath = path.join(REPORTS_DIR, 'ai-test-games', 'ai-test-analysis-report.md');
  fs.writeFileSync(outputPath, report);
  console.log(`[报告] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);
}

async function main() {
  console.log('========================================');
  console.log('AI对弈数据导出与分析');
  console.log('========================================\n');

  // 1. 导出棋局
  const games = await exportGames();

  // 2. 分析 ai-events
  const eventSummary = analyzeAiEvents();

  // 3. 分析棋局质量
  const gameAnalysis = await analyzeGames(games);

  // 4. 生成报告
  await generateReport(games, eventSummary, gameAnalysis);

  console.log('\n========================================');
  console.log('全部完成！');
  console.log(`棋局数据: reports/ai-test-games/ai-test-games-raw.json (${games.length} 局)`);
  console.log('引擎日志: reports/ai-test-games/ai-events-summary.json');
  console.log('棋局分析: reports/ai-test-games/ai-test-game-analysis.json');
  console.log('分析报告: reports/ai-test-games/ai-test-analysis-report.md');
  console.log('========================================');
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
