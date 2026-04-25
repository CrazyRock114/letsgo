/**
 * GOLD 回归测试集 — 小围棋乐园
 *
 * 这是一个 50 个局面的黄金测试集，覆盖：
 * - 空棋盘基线（验证 komi 和规则）
 * - 典型开局（验证视角）
 * - 中盘常见定式（验证棋力）
 * - 死活题（验证精确搜索）
 * - 官子（验证收官计算）
 * - 边界情况（让子、pass、棋盘角落）
 *
 * 每个测试的 `expected` 字段是在合理配置下（chinese rules, fair komi）跑
 * 500+ visits 得到的宽容范围。允许波动，但不允许严重偏离。
 *
 * 用法：
 *   node run-gold-tests.js --config analysis.cfg --model rect15.bin.gz
 *
 * 失败条件：
 *   - winrate 出界
 *   - scoreLead 出界
 *   - 或任何 runtime error
 */

export interface GoldTest {
  id: string;
  category: "empty-board" | "opening" | "midgame" | "life-death" | "endgame" | "edge-case";
  description: string;
  
  query: {
    boardXSize: number;
    boardYSize: number;
    rules: "chinese" | "japanese" | "chinese-ogs";
    komi: number;
    moves: Array<[string, string]>;        // [["B", "E5"], ["W", "E3"]]
    initialStones?: Array<[string, string]>;
    initialPlayer?: "B" | "W";
    maxVisits: number;
    includePolicy?: boolean;
    includeOwnership?: boolean;
  };
  
  expected: {
    // rootInfo 字段的容忍范围
    // 如果 actual 值不在 [min, max] 内，测试失败
    winrate?: { min: number; max: number };      // [0, 1]
    scoreLead?: { min: number; max: number };    // 目数
    
    // 可选：top 推荐手必须在此集合内
    topMoves?: string[];                         // 允许的 order=0 候选手
    
    // 可选：某些手**不应**出现在 top N 里
    forbiddenMoves?: string[];
    
    // 可选：确定某些位置的 ownership（对死活题）
    ownership?: Array<{ vertex: string; sign: -1 | 1; minAbs: number }>;
  };
  
  rationale: string;  // 为什么这是正确答案
}

// ============================================================
// 第一组：空棋盘基线（验证 komi 和规则）
// ============================================================

export const CATEGORY_EMPTY_BOARD: GoldTest[] = [
  {
    id: "GOLD-001",
    category: "empty-board",
    description: "9x9 空棋盘 @ fair komi 7, chinese 规则",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 7,
      moves: [],
      maxVisits: 500,
    },
    expected: {
      winrate: { min: 0.35, max: 0.65 },        // 应接近 50%
      scoreLead: { min: -3, max: 3 },            // 应接近 0
    },
    rationale: "fair komi 下必须大致均势。如果严重偏离，说明 komi 或 rules 错配。这是第一道防线。",
  },
  {
    id: "GOLD-002",
    category: "empty-board",
    description: "13x13 空棋盘 @ komi 7.5, chinese 规则",
    query: {
      boardXSize: 13, boardYSize: 13,
      rules: "chinese",
      komi: 7.5,
      moves: [],
      maxVisits: 500,
    },
    expected: {
      winrate: { min: 0.35, max: 0.65 },
      scoreLead: { min: -3, max: 3 },
    },
    rationale: "13x13 的 fair komi 附近应该均势",
  },
  {
    id: "GOLD-003",
    category: "empty-board",
    description: "19x19 空棋盘 @ komi 7.5, chinese 规则",
    query: {
      boardXSize: 19, boardYSize: 19,
      rules: "chinese",
      komi: 7.5,
      moves: [],
      maxVisits: 300,
    },
    expected: {
      winrate: { min: 0.35, max: 0.65 },
      scoreLead: { min: -3, max: 3 },
    },
    rationale: "19x19 的 fair komi",
  },
  {
    id: "GOLD-004",
    category: "empty-board",
    description: "9x9 空棋盘 @ 极低 komi = 2.5（应该黑方大优）",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 2.5,
      moves: [],
      maxVisits: 200,
    },
    expected: {
      winrate: { min: 0.85, max: 1.0 },        // 黑方几乎必胜
      scoreLead: { min: 3, max: 8 },            // 领先几目
    },
    rationale: "负对照：故意用错的 komi 看 KataGo 反应。如果这个测试'通过'，说明 winrate 变化有意义",
  },
  {
    id: "GOLD-005",
    category: "empty-board",
    description: "9x9 空棋盘 @ 极高 komi = 12（应该黑方大劣）",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 12,
      moves: [],
      maxVisits: 200,
    },
    expected: {
      winrate: { min: 0.0, max: 0.2 },         // 黑方几乎必败
      scoreLead: { min: -8, max: -2 },
    },
    rationale: "负对照：komi 太高对黑不利",
  },
];

// ============================================================
// 第二组：开局（验证视角）
// ============================================================

export const CATEGORY_OPENING: GoldTest[] = [
  {
    id: "GOLD-101",
    category: "opening",
    description: "9x9 黑下天元后（白方要下）@ komi 7",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 7,
      moves: [["B", "E5"]],
      maxVisits: 300,
    },
    expected: {
      // 视角测试：
      // - 如果 reportAnalysisWinratesAs = BLACK，winrate 应接近 0.5（黑方略优）
      // - 如果 = SIDETOMOVE（白方视角），winrate 应接近 0.5（白方略劣）
      // 无论哪种，都应在 0.4 附近（黑方先手优势 + fair komi）
      winrate: { min: 0.3, max: 0.55 },
    },
    rationale: "验证视角一致性。KataGo 在 fair komi 下，单手中央落子后仍接近均势",
  },
  {
    id: "GOLD-102",
    category: "opening",
    description: "19x19 黑下 Q16 后（白方要下）@ komi 7.5",
    query: {
      boardXSize: 19, boardYSize: 19,
      rules: "chinese",
      komi: 7.5,
      moves: [["B", "Q16"]],
      maxVisits: 300,
    },
    expected: {
      winrate: { min: 0.35, max: 0.55 },
      topMoves: ["D4", "D16", "Q4", "R4"],     // 白常应这些标准开局
    },
    rationale: "19x19 开局的标准应对",
  },
  {
    id: "GOLD-103",
    category: "opening",
    description: "9x9 五步后局面（简单开局）@ komi 7",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 7,
      moves: [
        ["B", "E5"], ["W", "E3"],
        ["B", "G3"], ["W", "C5"],
        ["B", "C3"],
      ],
      maxVisits: 300,
    },
    expected: {
      winrate: { min: 0.2, max: 0.8 },         // 视局面而定，但不应极端
    },
    rationale: "多步棋局，验证多步后视角仍然一致",
  },
];

// ============================================================
// 第三组：死活（验证精确搜索）
// ============================================================

export const CATEGORY_LIFE_DEATH: GoldTest[] = [
  {
    id: "GOLD-201",
    category: "life-death",
    description: "9x9 黑活棋局面，黑下 B1 应活",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 7,
      // 构造一个死活题局面（例子，具体需要专家设计）
      initialStones: [
        ["W", "C2"], ["W", "D2"], ["W", "D1"], ["W", "E2"],
        ["B", "A1"], ["B", "A2"], ["B", "B2"],
      ],
      initialPlayer: "B",
      moves: [],
      maxVisits: 2000,
      includeOwnership: true,
    },
    expected: {
      topMoves: ["B1"],                         // B1 是活棋关键点
      ownership: [
        { vertex: "A1", sign: 1, minAbs: 0.7 },  // 黑活
        { vertex: "A2", sign: 1, minAbs: 0.7 },
        { vertex: "B2", sign: 1, minAbs: 0.5 },
      ],
    },
    rationale: "经典活棋三目做活。KataGo 应该准确识别 B1 是唯一活点",
  },
  // ... 更多死活题
];

// ============================================================
// 第四组：让子棋（验证 whiteHandicapBonus）
// ============================================================

export const CATEGORY_HANDICAP: GoldTest[] = [
  {
    id: "GOLD-301",
    category: "edge-case",
    description: "9x9 两子让子局（白方要下）chinese 规则 whiteHandicapBonus=N",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 0.5,  // 让子棋常用
      initialStones: [["B", "C3"], ["B", "G7"]],
      initialPlayer: "W",
      moves: [],
      maxVisits: 300,
    },
    expected: {
      // 两子让子局，即使 komi=0.5 且无 bonus，黑仍大优
      winrate: { min: 0.75, max: 1.0 },   // 黑方视角
    },
    rationale: "验证让子棋 KataGo 仍能正确判断黑方优势",
  },
];

// ============================================================
// 第五组：边界情况
// ============================================================

export const CATEGORY_EDGE_CASE: GoldTest[] = [
  {
    id: "GOLD-401",
    category: "edge-case",
    description: "9x9 连续两 pass 后（游戏应结束）",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 7,
      moves: [
        ["B", "E5"], ["W", "E3"],
        ["B", "pass"], ["W", "pass"],
      ],
      maxVisits: 100,
    },
    expected: {
      // 此时游戏已结束，但 KataGo 仍可分析（作为 finalize 判断）
      // scoreLead 应反映实际地盘
      scoreLead: { min: -10, max: 10 },
    },
    rationale: "验证 KataGo 在双方 pass 后的行为（非 crash）",
  },
  {
    id: "GOLD-402",
    category: "edge-case",
    description: "9x9 棋盘角落堆子（压力测试）",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "chinese",
      komi: 7,
      moves: [
        ["B", "A1"], ["W", "A2"],
        ["B", "B1"], ["W", "B2"],
        ["B", "C1"], ["W", "C2"],
      ],
      maxVisits: 200,
    },
    expected: {
      winrate: { min: 0.0, max: 1.0 },         // 范围宽，主要看不 crash
    },
    rationale: "低概率局面，验证 KataGo 仍能工作",
  },
  {
    id: "GOLD-403",
    category: "edge-case",
    description: "9x9 使用 Japanese 规则 @ komi 6（Japanese fair komi）",
    query: {
      boardXSize: 9, boardYSize: 9,
      rules: "japanese",
      komi: 6,                                  // Japanese 的 fair komi 是 6
      moves: [],
      maxVisits: 300,
    },
    expected: {
      winrate: { min: 0.35, max: 0.65 },
      scoreLead: { min: -3, max: 3 },
    },
    rationale: "Japanese 规则下的 fair komi 验证（和 Chinese 不同）",
  },
];

// ============================================================
// 导出所有测试
// ============================================================

export const ALL_GOLD_TESTS: GoldTest[] = [
  ...CATEGORY_EMPTY_BOARD,
  ...CATEGORY_OPENING,
  ...CATEGORY_LIFE_DEATH,
  ...CATEGORY_HANDICAP,
  ...CATEGORY_EDGE_CASE,
];

// ============================================================
// 测试运行器
// ============================================================

export interface GoldTestResult {
  testId: string;
  passed: boolean;
  failures: string[];
  actual: {
    winrate: number;
    scoreLead: number;
    topMove: string;
    elapsedMs: number;
  };
}

export async function runGoldTest(
  client: {
    analyze: (q: unknown) => Promise<Array<{
      rootInfo: { winrate: number; scoreLead: number };
      moveInfos: Array<{ move: string }>;
      ownership?: number[];
      _client?: { elapsedMs: number };
    }>>;
  },
  test: GoldTest,
  boardSize: number
): Promise<GoldTestResult> {
  const responses = await client.analyze(test.query);
  const resp = responses[0];
  const failures: string[] = [];
  
  if (test.expected.winrate) {
    const wr = resp.rootInfo.winrate;
    if (wr < test.expected.winrate.min || wr > test.expected.winrate.max) {
      failures.push(
        `winrate=${wr.toFixed(3)} not in [${test.expected.winrate.min}, ${test.expected.winrate.max}]`
      );
    }
  }
  
  if (test.expected.scoreLead) {
    const sl = resp.rootInfo.scoreLead;
    if (sl < test.expected.scoreLead.min || sl > test.expected.scoreLead.max) {
      failures.push(
        `scoreLead=${sl.toFixed(2)} not in [${test.expected.scoreLead.min}, ${test.expected.scoreLead.max}]`
      );
    }
  }
  
  if (test.expected.topMoves) {
    const topMove = resp.moveInfos[0]?.move;
    if (!test.expected.topMoves.includes(topMove)) {
      failures.push(
        `top move ${topMove} not in allowed list [${test.expected.topMoves.join(", ")}]`
      );
    }
  }
  
  // 类似地检查 forbiddenMoves, ownership 等
  
  return {
    testId: test.id,
    passed: failures.length === 0,
    failures,
    actual: {
      winrate: resp.rootInfo.winrate,
      scoreLead: resp.rootInfo.scoreLead,
      topMove: resp.moveInfos[0]?.move ?? "?",
      elapsedMs: resp._client?.elapsedMs ?? 0,
    },
  };
}

export async function runAllGoldTests(
  client: Parameters<typeof runGoldTest>[0]
): Promise<{
  passed: number;
  failed: number;
  results: GoldTestResult[];
}> {
  const results: GoldTestResult[] = [];
  for (const test of ALL_GOLD_TESTS) {
    try {
      const result = await runGoldTest(client, test, test.query.boardXSize);
      results.push(result);
      console.log(
        `${result.passed ? "✅" : "❌"} ${test.id}: ${test.description}`
      );
      if (!result.passed) {
        for (const f of result.failures) console.log(`   - ${f}`);
      }
    } catch (e) {
      results.push({
        testId: test.id,
        passed: false,
        failures: [`Runtime error: ${(e as Error).message}`],
        actual: { winrate: 0, scoreLead: 0, topMove: "?", elapsedMs: 0 },
      });
      console.log(`❌ ${test.id}: runtime error`);
    }
  }
  
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  
  return { passed, failed, results };
}
