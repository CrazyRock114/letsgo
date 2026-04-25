/**
 * 导出详细棋局日志和引擎事件日志
 * - B: 每局 moves + analysis 展开
 * - C: 1933 条 ai-events 可读格式
 */

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'ai-test-games');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ============================================================
// B: 每局 moves + analysis 展开
// ============================================================
function exportGameDetails() {
  const games = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reports', 'ai-test-games-raw.json'), 'utf-8'));
  const lines = [];

  lines.push('# AI对弈详细着法记录');
  lines.push('');
  lines.push('数据范围: 2026-04-24 19:21 ~ 2026-04-25 04:11');
  lines.push(`总局数: ${games.length}`);
  lines.push('');

  games.forEach((g, gi) => {
    const moves = g.moves || [];
    const commentaries = g.commentaries || [];
    const durationMin = g.created_at && g.updated_at
      ? Math.round((new Date(g.updated_at) - new Date(g.created_at)) / 60000)
      : '-';
    const winner = g.black_score > g.white_score ? '黑' : g.white_score > g.black_score ? '白' : '平';

    lines.push(`## 第${gi + 1}局 (id=${g.id})`);
    lines.push('');
    lines.push(`- 创建: ${g.created_at}`);
    lines.push(`- 结束: ${g.updated_at}`);
    lines.push(`- 时长: ${durationMin}分钟`);
    lines.push(`- 总手数: ${moves.length}`);
    lines.push(`- 终局: 黑${g.black_score} - 白${g.white_score} (${winner}胜)`);
    lines.push('');
    lines.push('### 逐手记录');
    lines.push('');
    lines.push('| 手数 | 颜色 | 坐标 | 提子 | 胜率 | 目差 | visits | 推荐(前3) |');
    lines.push('|------|------|------|------|------|------|--------|-----------|');

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const c = commentaries[i];
      const moveNum = i + 1;
      const color = m.color === 'black' ? '黑' : '白';
      const coord = m.pass ? 'pass' : m.position ? `${String.fromCharCode(65 + (m.position.col >= 8 ? m.position.col + 1 : m.position.col))}${9 - m.position.row}` : '-';
      const captured = m.captured || 0;

      let winRate = '-';
      let scoreLead = '-';
      let visits = '-';
      let recommendations = '-';

      if (m.analysis) {
        winRate = m.analysis.winRate != null ? m.analysis.winRate.toFixed(1) + '%' : '-';
        scoreLead = m.analysis.scoreLead != null ? m.analysis.scoreLead.toFixed(1) : '-';
        visits = m.analysis.actualVisits || '-';
        if (m.analysis.bestMoves && m.analysis.bestMoves.length > 0) {
          recommendations = m.analysis.bestMoves.slice(0, 3).map(bm => {
            return `${bm.move}(${bm.winrate != null ? bm.winrate.toFixed(1) : '?'}%)`;
          }).join(', ');
        }
      } else if (c && c.commentary) {
        const wrMatch = c.commentary.match(/胜率([\d.]+)%/);
        if (wrMatch) winRate = wrMatch[1] + '%';
        const slMatch = c.commentary.match(/目差([+-]?[\d.]+)/);
        if (slMatch) scoreLead = slMatch[1];
        const vMatch = c.commentary.match(/visits:(\d+)/);
        if (vMatch) visits = vMatch[1];
      }

      lines.push(`| ${moveNum} | ${color} | ${coord} | ${captured} | ${winRate} | ${scoreLead} | ${visits} | ${recommendations} |`);
    }

    lines.push('');
  });

  const outputPath = path.join(REPORTS_DIR, 'B-game-moves-detailed.md');
  fs.writeFileSync(outputPath, lines.join('\n'));
  console.log(`[B] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);
}

// ============================================================
// C: 1933 条 ai-events 可读格式
// ============================================================
function exportAiEvents() {
  const files = [
    path.join(__dirname, '..', 'logs', 'ai-events', '2026-04-24.jsonl'),
    path.join(__dirname, '..', 'logs', 'ai-events', '2026-04-25.jsonl'),
  ];

  const events = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    content.split('\n').filter(l => l.trim()).forEach(line => {
      try { events.push(JSON.parse(line)); } catch {}
    });
  }

  // 筛选 4/24 19:00 之后
  const filtered = events.filter(e => e.ts >= '2026-04-24T19:00:00Z');

  const lines = [];
  lines.push('# AI引擎事件日志 (ai-events)');
  lines.push('');
  lines.push('数据范围: 2026-04-24 19:00 ~ 2026-04-25 04:11');
  lines.push(`总事件数: ${filtered.length}`);
  lines.push('');

  // 汇总统计
  const byType = {};
  const byModel = {};
  const byHour = {};
  const genmoveDurations = [];
  const analyzeVisits = [];

  filtered.forEach(e => {
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (e.model) {
      byModel[e.model] = byModel[e.model] || { count: 0, genmove: 0, analyze: 0 };
      byModel[e.model].count++;
      if (e.type === 'genmove') byModel[e.model].genmove++;
      if (e.type === 'analyze') byModel[e.model].analyze++;
    }
    const hour = e.ts.slice(0, 13);
    byHour[hour] = (byHour[hour] || 0) + 1;
    if (e.type === 'genmove' && e.durationMs) genmoveDurations.push(e.durationMs);
    if (e.type === 'analyze' && e.metadata?.visits) analyzeVisits.push(e.metadata.visits);
  });

  lines.push('## 汇总统计');
  lines.push('');
  lines.push('### 按类型');
  lines.push('| 类型 | 次数 |');
  lines.push('|------|------|');
  Object.entries(byType).forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
  lines.push('');

  lines.push('### 按模型');
  lines.push('| 模型 | 总次数 | genmove | analyze |');
  lines.push('|------|--------|---------|---------|');
  Object.entries(byModel).forEach(([k, v]) => lines.push(`| ${k} | ${v.count} | ${v.genmove} | ${v.analyze} |`));
  lines.push('');

  lines.push('### 按小时');
  lines.push('| 小时 | 事件数 |');
  lines.push('|------|--------|');
  Object.entries(byHour).sort().forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
  lines.push('');

  if (genmoveDurations.length > 0) {
    const avg = Math.round(genmoveDurations.reduce((a, b) => a + b, 0) / genmoveDurations.length);
    const sorted = [...genmoveDurations].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    lines.push('### genmove 耗时分布');
    lines.push(`- 平均: ${avg}ms`);
    lines.push(`- P50: ${p50}ms`);
    lines.push(`- P95: ${p95}ms`);
    lines.push(`- 最小: ${sorted[0]}ms`);
    lines.push(`- 最大: ${sorted[sorted.length - 1]}ms`);
    lines.push('');
  }

  if (analyzeVisits.length > 0) {
    const avg = Math.round(analyzeVisits.reduce((a, b) => a + b, 0) / analyzeVisits.length);
    const sorted = [...analyzeVisits].sort((a, b) => a - b);
    lines.push('### analyze visits 分布');
    lines.push(`- 平均: ${avg}`);
    lines.push(`- 最小: ${sorted[0]}`);
    lines.push(`- 最大: ${sorted[sorted.length - 1]}`);
    lines.push('');
  }

  // 逐条明细
  lines.push('## 逐条明细');
  lines.push('');
  lines.push('| 序号 | 时间 | 类型 | 模型 | 棋盘 | 耗时(ms) | 坐标 | visits | 错误 |');
  lines.push('|------|------|------|------|------|----------|------|--------|------|');

  filtered.forEach((e, i) => {
    const ts = e.ts.replace('T', ' ').replace('Z', '');
    const type = e.type;
    const model = e.model || '-';
    const board = e.boardSize || '-';
    const dur = e.durationMs != null ? e.durationMs : '-';
    const coord = e.coord || (e.isPass ? 'pass' : '-');
    const visits = e.metadata?.visits != null ? e.metadata.visits : '-';
    const error = e.error || '-';
    lines.push(`| ${i + 1} | ${ts} | ${type} | ${model} | ${board} | ${dur} | ${coord} | ${visits} | ${error} |`);
  });

  const outputPath = path.join(REPORTS_DIR, 'C-ai-events-detailed.md');
  fs.writeFileSync(outputPath, lines.join('\n'));
  console.log(`[C] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);
}

// 同时导出 JSON 版本方便程序处理
function exportGameDetailsJson() {
  const games = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reports', 'ai-test-games-raw.json'), 'utf-8'));

  const simplified = games.map((g, gi) => {
    const moves = (g.moves || []).map((m, i) => {
      const coord = m.pass ? 'pass' : m.position
        ? `${String.fromCharCode(65 + (m.position.col >= 8 ? m.position.col + 1 : m.position.col))}${9 - m.position.row}`
        : '-';
      return {
        moveNum: i + 1,
        color: m.color,
        coord,
        captured: m.captured || 0,
        winRate: m.analysis?.winRate ?? null,
        scoreLead: m.analysis?.scoreLead ?? null,
        actualVisits: m.analysis?.actualVisits ?? null,
        bestMoves: (m.analysis?.bestMoves || []).slice(0, 3).map(bm => ({
          move: bm.move,
          winrate: bm.winrate,
          scoreMean: bm.scoreMean,
          visits: bm.visits,
        })),
      };
    });

    return {
      gameNum: gi + 1,
      id: g.id,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      totalMoves: moves.length,
      blackScore: g.black_score,
      whiteScore: g.white_score,
      moves,
    };
  });

  const outputPath = path.join(REPORTS_DIR, 'B-game-moves-detailed.json');
  fs.writeFileSync(outputPath, JSON.stringify(simplified, null, 2));
  console.log(`[B-JSON] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);
}

function exportAiEventsJson() {
  const files = [
    path.join(__dirname, '..', 'logs', 'ai-events', '2026-04-24.jsonl'),
    path.join(__dirname, '..', 'logs', 'ai-events', '2026-04-25.jsonl'),
  ];

  const events = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    content.split('\n').filter(l => l.trim()).forEach(line => {
      try { events.push(JSON.parse(line)); } catch {}
    });
  }

  const filtered = events.filter(e => e.ts >= '2026-04-24T19:00:00Z');

  const outputPath = path.join(REPORTS_DIR, 'C-ai-events-detailed.json');
  fs.writeFileSync(outputPath, JSON.stringify(filtered, null, 2));
  console.log(`[C-JSON] 已写入 ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);
}

console.log('========================================');
console.log('导出详细日志');
console.log('========================================\n');

exportGameDetails();
exportAiEvents();
exportGameDetailsJson();
exportAiEventsJson();

console.log('\n全部完成！');
console.log(`输出目录: ${REPORTS_DIR}`);
