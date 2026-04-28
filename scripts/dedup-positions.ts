#!/usr/bin/env tsx
/**
 * 知识库去重脚本：删除重复的位置记录
 *
 * 重复判定：相同 (board_size, move_number, color, coordinate, snapshot JSONB)
 * 保留策略：每组保留 id 最小（最早插入）的一条
 *
 * 运行：npx tsx scripts/dedup-positions.ts [--dry-run]
 */

import { createClient } from '@supabase/supabase-js';

require('dotenv').config({ path: '.env.local' });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log('[dedup] Analyzing duplicate positions...');

  // Step 1: 统计重复组数量和待删除记录数
  const { data: dupStats, error: statsErr } = await supabase.rpc('count_duplicate_positions');

  if (statsErr) {
    if (statsErr.message.includes('function') && (statsErr.message.includes('does not exist') || statsErr.message.includes('Could not find'))) {
      console.log('[dedup] RPC function not found, falling back to client-side analysis...');
      await clientSideDedup(supabase);
      return;
    }
    console.error('[dedup] Stats error:', statsErr.message);
    process.exit(1);
  }

  console.log(`[dedup] Duplicate groups: ${dupStats?.groups || 'N/A'}`);
  console.log(`[dedup] Records to delete: ${dupStats?.to_delete || 'N/A'}`);

  if (DRY_RUN) {
    console.log('[dedup] DRY RUN mode — no records will be deleted');
    return;
  }

  // Step 2: 执行去重（保留每组 id 最小的）
  const { data: deleteResult, error: deleteErr } = await supabase.rpc('delete_duplicate_positions');

  if (deleteErr) {
    console.error('[dedup] Delete error:', deleteErr.message);
    process.exit(1);
  }

  console.log(`[dedup] Deleted ${deleteResult?.deleted_count || 'N/A'} duplicate records`);
}

/**
 * 客户端去重（fallback，当 RPC 函数不存在时使用）
 */
async function clientSideDedup(supabase: any) {
  console.log('[dedup] Fetching all positions for client-side dedup...');

  // 分批获取记录，避免内存溢出
  const PAGE_SIZE = 1000;
  let from = 0;
  const positions: Array<{
    id: number;
    board_size: number;
    move_number: number;
    color: string;
    coordinate: Record<string, unknown>;
    snapshot: Record<string, unknown>;
  }> = [];

  while (true) {
    const { data, error } = await supabase
      .from('letsgo_position_index')
      .select('id, board_size, move_number, color, coordinate, snapshot')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('[dedup] Fetch error:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    positions.push(...data);
    from += PAGE_SIZE;

    if (from % 5000 === 0) {
      console.log(`[dedup] Fetched ${positions.length} records...`);
    }
  }

  console.log(`[dedup] Total records fetched: ${positions.length}`);

  // 用 Map 分组检测重复
  const groups = new Map<string, number[]>(); // key -> [ids]

  for (const pos of positions) {
    const coord = pos.coordinate as { row: number; col: number };
    const key = `${pos.board_size}|${pos.move_number}|${pos.color}|${coord.row}|${coord.col}|${JSON.stringify(pos.snapshot)}`;

    const existing = groups.get(key);
    if (existing) {
      existing.push(pos.id);
    } else {
      groups.set(key, [pos.id]);
    }
  }

  // 收集待删除的 id（每组保留最小的 id）
  const toDelete: number[] = [];
  let dupGroups = 0;

  for (const [key, ids] of groups) {
    if (ids.length > 1) {
      dupGroups++;
      ids.sort((a, b) => a - b);
      toDelete.push(...ids.slice(1));
    }
  }

  console.log(`[dedup] Duplicate groups found: ${dupGroups}`);
  console.log(`[dedup] Records to delete: ${toDelete.length}`);

  if (DRY_RUN) {
    console.log('[dedup] DRY RUN mode — no records will be deleted');
    return;
  }

  if (toDelete.length === 0) {
    console.log('[dedup] No duplicates found');
    return;
  }

  // 分批删除
  const BATCH_SIZE = 100;
  let deleted = 0;

  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = toDelete.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('letsgo_position_index')
      .delete()
      .in('id', batch);

    if (error) {
      console.error(`[dedup] Delete error at batch ${i / BATCH_SIZE + 1}:`, error.message);
    } else {
      deleted += batch.length;
    }

    if (i + BATCH_SIZE < toDelete.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[dedup] Deleted ${deleted} duplicate records`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
