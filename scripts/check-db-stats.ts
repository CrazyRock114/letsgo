#!/usr/bin/env tsx
/**
 * 查询知识库统计信息
 * 运行：npx tsx scripts/check-db-stats.ts
 */

import { createClient } from '@supabase/supabase-js';

require('dotenv').config({ path: '.env.local' });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log('[stats] Querying database stats...\n');

  // 总记录数
  const { count: total } = await supabase
    .from('letsgo_position_index')
    .select('*', { count: 'exact', head: true });

  // 按棋盘大小分组
  for (const size of [9, 13, 19]) {
    const { count } = await supabase
      .from('letsgo_position_index')
      .select('*', { count: 'exact', head: true })
      .eq('board_size', size);

    const { data: moveRange } = await supabase
      .from('letsgo_position_index')
      .select('move_number')
      .eq('board_size', size)
      .order('move_number', { ascending: true })
      .limit(1);

    const { data: moveRangeMax } = await supabase
      .from('letsgo_position_index')
      .select('move_number')
      .eq('board_size', size)
      .order('move_number', { ascending: false })
      .limit(1);

    const minMove = moveRange?.[0]?.move_number ?? 'N/A';
    const maxMove = moveRangeMax?.[0]?.move_number ?? 'N/A';

    console.log(`${size}x${size}: ${count?.toLocaleString()} records (moves ${minMove}–${maxMove})`);
  }

  console.log(`\nTotal: ${total?.toLocaleString()} records`);

  console.log('\nUse Supabase SQL Editor for region/star_point breakdowns.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
