#!/usr/bin/env tsx
/**
 * 幻觉率测试：验证 JSON 事实骨架是否能有效减少 LLM 解说幻觉
 *
 * 测试方法：
 * 1. 从向量数据库中选取具有明确特征的位置（星位/非星位、角/边/中腹、打吃/非打吃等）
 * 2. 构造与生产环境相同的 prompt（含 JSON 事实）
 * 3. 调用 DeepSeek API 生成解说
 * 4. 检查解说是否违反了 JSON 事实中的约束
 *
 * 运行：npx tsx scripts/test-hallucination.ts
 */

import { createClient } from '@supabase/supabase-js';

// Load env
require('dotenv').config({ path: '.env.local' });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY!;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

interface TestCase {
  id: number;
  description: string;
  facts: Record<string, unknown>;
  checks: HallucinationCheck[];
}

interface HallucinationCheck {
  name: string;
  // 如果返回 true，表示检测到幻觉
  detect: (response: string, facts: Record<string, unknown>) => boolean;
}

// ─── 幻觉检测规则 ───

const HALLUCINATION_CHECKS: HallucinationCheck[] = [
  {
    name: '颜色错误（说错落子方）',
    detect: (res, facts) => {
      const color = facts.color as string;
      if (!color) return false;
      const expected = color === 'black' ? '黑方' : '白方';
      const wrong = color === 'black' ? '白方' : '黑方';
      return res.includes(wrong) && !res.includes(expected);
    },
  },
  {
    name: '假星位（非星位说星位）',
    detect: (res, facts) =>
      facts.isStarPoint === false &&
      /星位/.test(res),
  },
  {
    name: '假占角（边/中说占角）',
    detect: (res, facts) =>
      facts.region !== 'corner' &&
      /占角/.test(res),
  },
  {
    name: '假打吃（非打吃说打吃）',
    detect: (res, facts) =>
      facts.isAtari === false &&
      /打吃|叫吃/.test(res),
  },
  {
    name: '假提子（非提子说提子）',
    detect: (res, facts) =>
      facts.isCapture === false &&
      facts.captured === 0 &&
      /提[了掉]?\d*个?[子棋]/.test(res),
  },
  {
    name: '假切断（patterns 中无 cut 却说切断）',
    detect: (res, facts) => {
      const patterns = (facts.patterns as Array<{ type: string }>) || [];
      const hasCut = patterns.some(p => p.type === 'cut');
      return !hasCut && /切断/.test(res);
    },
  },
  {
    name: '假做眼（patterns 中无 eye 却说做眼）',
    detect: (res, facts) => {
      const patterns = (facts.patterns as Array<{ type: string }>) || [];
      const hasEye = patterns.some(p => p.type === 'eye');
      return !hasEye && /做眼|眼形/.test(res);
    },
  },
  {
    name: '假连接（patterns 中无 connect 却说连接）',
    detect: (res, facts) => {
      const patterns = (facts.patterns as Array<{ type: string }>) || [];
      const hasConnect = patterns.some(p => p.type === 'connect');
      return !hasConnect && /连接/.test(res);
    },
  },
  {
    name: '假挂角（patterns 中无 approach 却说挂角）',
    detect: (res, facts) => {
      const patterns = (facts.patterns as Array<{ type: string }>) || [];
      const hasApproach = patterns.some(p => p.type === 'approach');
      return !hasApproach && /挂角/.test(res);
    },
  },
];

// ─── 构建测试用例 ───

async function fetchTestCases(): Promise<TestCase[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const cases: TestCase[] = [];

  // 注意：is_atari / is_capture / captured 存储在 snapshot JSONB 中，需用 ->> 提取
  // 1. 星位 + 角部（应说星位、占角）
  const { data: starCorner, error: e1 } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .eq('is_star_point', true)
    .eq('region', 'corner')
    .limit(5);
  if (e1) console.error('[test] Query error (starCorner):', e1.message);

  // 2. 非星位 + 边部（绝对不能说星位、占角）
  const { data: edgeNonStar } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .eq('is_star_point', false)
    .eq('region', 'edge')
    .limit(5);

  // 3. 非星位 + 角部（绝对不能说星位）
  const { data: cornerNonStar } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .eq('is_star_point', false)
    .eq('region', 'corner')
    .limit(5);

  // 4. 中腹（绝对不能说星位、占角）
  const { data: center } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .eq('region', 'center')
    .limit(5);

  // 5. 打吃场景（snapshot->>isAtari = 'true'）
  const { data: atariMoves } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .filter('snapshot->>isAtari', 'eq', 'true')
    .limit(5);

  // 6. 非打吃场景（snapshot->>isAtari = 'false'）
  const { data: nonAtari } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .filter('snapshot->>isAtari', 'eq', 'false')
    .limit(5);

  // 7. 提子场景（snapshot->>isCapture = 'true'）
  const { data: captureMoves } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .filter('snapshot->>isCapture', 'eq', 'true')
    .limit(5);

  // 8. 非提子场景（snapshot->>isCapture = 'false'）
  const { data: nonCapture } = await supabase
    .from('letsgo_position_index')
    .select('id, description, snapshot, is_star_point, region, patterns')
    .eq('board_size', 19)
    .filter('snapshot->>isCapture', 'eq', 'false')
    .limit(5);

  const allRows = [
    ...(starCorner || []),
    ...(edgeNonStar || []),
    ...(cornerNonStar || []),
    ...(center || []),
    ...(atariMoves || []),
    ...(nonAtari || []),
    ...(captureMoves || []),
    ...(nonCapture || []),
  ];

  for (const row of allRows) {
    const snapshot = row.snapshot || {};
    const colorCn = snapshot.color === 'black' ? '黑方' : snapshot.color === 'white' ? '白方' : '某方';
    cases.push({
      id: row.id,
      description: row.description,
      facts: {
        color: snapshot.color,
        isStarPoint: row.is_star_point,
        region: row.region,
        isAtari: snapshot.isAtari ?? false,
        isCapture: snapshot.isCapture ?? false,
        captured: snapshot.captured ?? 0,
        patterns: row.patterns,
      },
      checks: HALLUCINATION_CHECKS,
    });
  }

  return cases;
}

// ─── 构建 Prompt ───

const COMMENTARY_SYSTEM = `你是"小棋老师"，一位专业的儿童围棋解说员。

【严格规则】
1. 只说1句话，言简意赅
2. 必须明确说是"黑方"还是"白方"刚落子
3. 严格依据"局面事实（JSON）"数据说话，禁止自行推断
   - 'patterns' 数组中没出现的棋型，绝对不能说
   - 'isStarPoint' 为 false 时，绝对不能说"星位"
   - 'region' 为 "edge" 时，绝对不能说"占角"
   - 'isAtari' 为 false 时，不能说"打吃"
   - 'isCapture' 为 false 时，不能说"提子"
4. 不提"即将落子"、"接下来"等内容`;

function buildPrompt(testCase: TestCase): string {
  const colorText = testCase.facts.color === 'black' ? '黑方' : '白方';
  return `棋盘大小：19x19

=== 局面事实（JSON，解说必须严格依据以下数据，禁止自行推断棋型） ===
${JSON.stringify(testCase.facts, null, 2)}

【刚落子方】${colorText}刚下完这步棋

请为这步棋生成一句简短的中文解说。`;
}

// ─── 调用 LLM ───

async function callLLM(prompt: string): Promise<string> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: COMMENTARY_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 200,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── 主流程 ───

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials');
    process.exit(1);
  }
  if (!DEEPSEEK_API_KEY) {
    console.error('Missing DEEPSEEK_API_KEY');
    process.exit(1);
  }

  console.log('[test] Fetching test cases from vector DB...');
  const testCases = await fetchTestCases();
  console.log(`[test] Fetched ${testCases.length} test cases\n`);

  let totalChecks = 0;
  let hallucinationCount = 0;
  const hallucinations: Array<{ caseId: number; description: string; response: string; checkName: string }> = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`[test] Case ${i + 1}/${testCases.length} (id=${tc.id}): ${tc.description.substring(0, 60)}...`);

    const prompt = buildPrompt(tc);
    let response: string;
    try {
      response = await callLLM(prompt);
    } catch (err) {
      console.error(`[test]   LLM error: ${(err as Error).message}`);
      continue;
    }

    console.log(`[test]   Response: "${response}"`);

    for (const check of tc.checks) {
      totalChecks++;
      if (check.detect(response, tc.facts)) {
        hallucinationCount++;
        hallucinations.push({
          caseId: tc.id,
          description: tc.description,
          response,
          checkName: check.name,
        });
        console.log(`[test]   ❌ HALLUCINATION: ${check.name}`);
      }
    }

    // Rate limit friendly
    if (i < testCases.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ─── 报告 ───
  console.log('\n========== 幻觉测试报告 ==========');
  console.log(`测试用例数: ${testCases.length}`);
  console.log(`总检测项数: ${totalChecks}`);
  console.log(`幻觉次数: ${hallucinationCount}`);
  console.log(`幻觉率: ${totalChecks > 0 ? ((hallucinationCount / totalChecks) * 100).toFixed(1) : 0}%`);

  if (hallucinations.length > 0) {
    console.log('\n--- 幻觉详情 ---');
    for (const h of hallucinations) {
      console.log(`\n[${h.checkName}]`);
      console.log(`  位置描述: ${h.description}`);
      console.log(`  LLM输出: "${h.response}"`);
    }
  } else {
    console.log('\n✅ 未检测到任何幻觉！');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
