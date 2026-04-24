import { describe, it, expect } from 'vitest';
import { getKomi } from '@/lib/go-logic';
import { getAnalysisManager } from '@/lib/katago-analysis-client';
import { ALL_GOLD_TESTS } from '../../reports/katago-spec-v1/spec-v1-assets/gold-tests';

// GOLD 回归测试 — 需要本地 KataGo 二进制和模型
// 运行方式:
//   KATAGO_PATH=~/katago/katago KATAGO_DIR=~/katago KATAGO_ANALYSIS_CONFIG=~/katago/analysis.cfg pnpm test:gold
//
// 环境要求:
//   - KATAGO_PATH: katago 可执行文件路径
//   - KATAGO_DIR: 模型文件所在目录
//   - KATAGO_ANALYSIS_CONFIG: analysis.cfg 路径

function hasLocalKataGo(): boolean {
  try {
    const fs = require('fs');
    const path = process.env.KATAGO_PATH || '/usr/local/katago/katago';
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

const shouldRun = hasLocalKataGo();

describe('GOLD 回归测试', () => {
  // 空棋盘基线（最核心，必须过）
  describe('空棋盘基线', () => {
    for (const test of ALL_GOLD_TESTS.filter(t => t.category === 'empty-board')) {
      const run = shouldRun ? it : it.skip;
      run(`${test.id}: ${test.description}`, async () => {
        const manager = getAnalysisManager();
        await manager.start();

        const result = await manager.analyze(
          test.query.boardXSize,
          [],
          {
            maxVisits: test.query.maxVisits,
            maxTime: 30,
            komi: test.query.komi,
            rules: test.query.rules,
          }
        );

        expect(result).not.toBeNull();
        if (!result) return;

        const winrate = result.winRate / 100; // 0-100 → 0-1
        const scoreLead = result.scoreLead;

        if (test.expected.winrate) {
          expect(winrate, `winrate=${winrate} not in [${test.expected.winrate.min}, ${test.expected.winrate.max}]`)
            .toBeGreaterThanOrEqual(test.expected.winrate.min);
          expect(winrate).toBeLessThanOrEqual(test.expected.winrate.max);
        }
        if (test.expected.scoreLead) {
          expect(scoreLead, `scoreLead=${scoreLead} not in [${test.expected.scoreLead.min}, ${test.expected.scoreLead.max}]`)
            .toBeGreaterThanOrEqual(test.expected.scoreLead.min);
          expect(scoreLead).toBeLessThanOrEqual(test.expected.scoreLead.max);
        }
      }, 60000);
    }
  });

  // 开局视角测试
  describe('开局视角', () => {
    for (const test of ALL_GOLD_TESTS.filter(t => t.category === 'opening')) {
      const run = shouldRun ? it : it.skip;
      run(`${test.id}: ${test.description}`, async () => {
        const manager = getAnalysisManager();
        await manager.start();

        const moves = test.query.moves.map((m): { row: number; col: number; color: 'black' | 'white' } => {
          const cols = 'ABCDEFGHJKLMNOPQRST';
          const coord = m[1];
          const col = cols.indexOf(coord.charAt(0));
          const rowNum = parseInt(coord.slice(1));
          return {
            row: test.query.boardXSize - rowNum,
            col,
            color: m[0] === 'B' ? 'black' : 'white',
          };
        });

        const result = await manager.analyze(
          test.query.boardXSize,
          moves,
          {
            maxVisits: test.query.maxVisits,
            maxTime: 30,
            komi: test.query.komi,
            rules: test.query.rules,
          }
        );

        expect(result).not.toBeNull();
      }, 60000);
    }
  });

  // komi 正确性快速验证（不依赖 KataGo）
  describe('komi 配置验证', () => {
    it('fair komi 值与 GOLD 测试一致', () => {
      // 只验证 fair komi 测试（排除负对照如 GOLD-004/005）
      const fairTests = ALL_GOLD_TESTS.filter(
        t => t.category === 'empty-board' && t.query.komi >= 6 && t.query.komi <= 8
      );
      for (const test of fairTests) {
        const expectedKomi = test.query.komi;
        const actualKomi = getKomi(test.query.boardXSize);
        expect(actualKomi, `${test.id}: ${test.query.boardXSize}x${test.query.boardYSize} komi`).toBe(expectedKomi);
      }
    });
  });
});
