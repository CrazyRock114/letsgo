#!/usr/bin/env tsx
/**
 * 批量导入职业对局 SGF 文件到 Supabase 向量知识库
 *
 * 用法：
 *   npx tsx scripts/import-pro-games.ts data/sgf/*.sgf
 *   npx tsx scripts/import-pro-games.ts data/sgf/ --dry-run
 */

import fs from 'fs';
import path from 'path';
import { parseSgf } from '../src/lib/sgf-parser';
import { generateSnapshotsFromSgf } from '../src/lib/board-snapshot';
import { batchEmbeddings, pgVectorFormat } from '../src/lib/go-knowledge';
import { getSupabaseClient } from '../src/storage/database/supabase-client';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 32; // 每批生成 embedding 的数量

interface ImportResult {
  file: string;
  positions: number;
  error?: string;
}

async function importSgfFile(filePath: string): Promise<ImportResult> {
  const fileName = path.basename(filePath);
  console.log(`[import] ${fileName}`);

  try {
    const sgf = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSgf(sgf);
    const snapshots = generateSnapshotsFromSgf(parsed);

    if (snapshots.length === 0) {
      return { file: fileName, positions: 0, error: 'No snapshots generated' };
    }

    // 准备描述文本（用于 embedding）
    const descriptions = snapshots.map(s => s.description);

    // 批量生成 embedding
    console.log(`[import]   Generating embeddings for ${snapshots.length} positions...`);
    const embeddings = await batchEmbeddings(descriptions);

    // 构造插入数据
    const rows = snapshots.map((s, i) => ({
      board_size: s.boardSize,
      move_number: s.moveNumber,
      color: s.color,
      coordinate: s.coordinate,
      region: s.region,
      is_star_point: s.isStarPoint,
      patterns: s.patterns,
      description: s.description,
      embedding: pgVectorFormat(embeddings[i]),
      snapshot: s,
      game_meta: s.gameMeta ?? null,
      // source_sgf: sgf,  // 省略以减少插入数据量，避免 statement timeout
    }));

    if (DRY_RUN) {
      console.log(`[import]   DRY RUN: would insert ${rows.length} positions`);
      console.log(`[import]   Sample row #1:`, JSON.stringify(rows[0], null, 2).substring(0, 500));
      return { file: fileName, positions: rows.length };
    }

    // 写入 Supabase（分批插入 + 重试避免 statement timeout）
    const supabase = getSupabaseClient();
    let inserted = 0;

    async function insertChunk(chunk: typeof rows, retries = 3): Promise<boolean> {
      for (let attempt = 0; attempt < retries; attempt++) {
        const { error } = await supabase.from('letsgo_position_index').insert(chunk);
        if (!error) return true;

        const isTimeout = error.message.includes('statement timeout') || error.message.includes('canceling statement');
        const isAbort = error.message.includes('AbortError') || error.message.includes('aborted');
        if (isAbort && attempt < retries - 1) {
          console.log(`[import]   AbortError detected, pausing 30s before retry ${attempt + 1}/${retries}...`);
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        if (isTimeout && chunk.length > 1 && attempt < retries - 1) {
          // 超时且 chunk > 1：拆成两半分别重试
          const half = Math.floor(chunk.length / 2);
          console.log(`[import]   Chunk timeout (${chunk.length} rows), splitting to ${half}/${chunk.length - half} and retrying...`);
          const ok1 = await insertChunk(chunk.slice(0, half), retries);
          const ok2 = await insertChunk(chunk.slice(half), retries);
          return ok1 && ok2;
        }

        if (attempt < retries - 1) {
          console.log(`[import]   Insert retry ${attempt + 1}/${retries}: ${error.message}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        } else {
          console.error(`[import]   Insert failed after ${retries} retries:`, error.message);
          return false;
        }
      }
      return false;
    }

    const INSERT_BATCH = 5;
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const chunk = rows.slice(i, i + INSERT_BATCH);
      const ok = await insertChunk(chunk);
      if (!ok) {
        return { file: fileName, positions: inserted, error: 'Insert failed' };
      }
      inserted += chunk.length;
      // 每批插入后停顿，避免压垮数据库
      if (i + INSERT_BATCH < rows.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    console.log(`[import]   Inserted ${inserted} positions`);
    return { file: fileName, positions: inserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[import]   Error:`, msg);
    return { file: fileName, positions: 0, error: msg };
  }
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--dry-run');

  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/import-pro-games.ts <sgf-file-or-dir> [...] [--dry-run]');
    process.exit(1);
  }

  const files: string[] = [];
  for (const arg of args) {
    const stat = fs.statSync(arg);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(arg)
        .filter(f => f.endsWith('.sgf'))
        .map(f => path.join(arg, f));
      files.push(...entries);
    } else if (arg.endsWith('.sgf')) {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error('No .sgf files found');
    process.exit(1);
  }

  console.log(`[import] Found ${files.length} SGF file(s)`);
  if (DRY_RUN) console.log('[import] DRY RUN mode — no data will be written');

  const results: ImportResult[] = [];
  for (const file of files) {
    const result = await importSgfFile(file);
    results.push(result);
  }

  // 汇总
  const totalPositions = results.reduce((sum, r) => sum + r.positions, 0);
  const errors = results.filter(r => r.error);

  console.log('\n[import] === Summary ===');
  console.log(`Files processed: ${results.length}`);
  console.log(`Total positions: ${totalPositions}`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
    for (const e of errors) {
      console.log(`  - ${e.file}: ${e.error}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
