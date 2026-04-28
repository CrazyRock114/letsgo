import { generateEmbedding, generateEmbeddings, getEmbeddingDimension } from './embedding';
import { getSupabaseClient } from '@/storage/database/supabase-client';

const MAX_BATCH_SIZE = 64; // SiliconFlow BGE-M3 max batch size

/**
 * Batch generate embeddings with automatic chunking and fallback to single requests
 */
export async function batchEmbeddings(texts: string[]): Promise<number[][]> {
  // Auto-chunk to respect API limits
  if (texts.length > MAX_BATCH_SIZE) {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const chunk = texts.slice(i, i + MAX_BATCH_SIZE);
      const chunkResults = await batchEmbeddings(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  try {
    return await generateEmbeddings(texts);
  } catch (err) {
    console.warn('[go-knowledge] Batch embedding failed, falling back to single:', err);
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await generateEmbedding(text));
    }
    return results;
  }
}

/**
 * Convert number[] to pgvector string format: '[1.0, 2.0, ...]'
 */
export function pgVectorFormat(embedding: number[]): string {
  return `[${embedding.join(', ')}]`;
}

export { getEmbeddingDimension };

// ─── 共享搜索函数（供 go-ai 直接调用）───

export interface SimilarPosition {
  id: number;
  board_size: number;
  move_number: number;
  color: string;
  coordinate: { row: number; col: number };
  region: string;
  description: string;
  snapshot: Record<string, unknown>;
  game_meta: Record<string, unknown>;
  similarity: number;
}

/**
 * 搜索相似棋局位置（内部共享，不经过 HTTP）
 */
export async function searchSimilarPositions(
  description: string,
  boardSize: number,
  options?: {
    moveNumberMin?: number;
    moveNumberMax?: number;
    region?: string;
    matchCount?: number;
  }
): Promise<SimilarPosition[]> {
  try {
    const embedding = await generateEmbedding(description);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('search_similar_positions', {
      query_embedding: pgVectorFormat(embedding),
      p_board_size: boardSize,
      p_move_number_min: options?.moveNumberMin ?? 0,
      p_move_number_max: options?.moveNumberMax ?? 999,
      p_region: options?.region || null,
      match_count: Math.min(options?.matchCount ?? 5, 20),
    });

    if (error) {
      console.error('[go-knowledge] Search error:', error);
      return [];
    }

    return (data ?? []) as SimilarPosition[];
  } catch (err) {
    console.error('[go-knowledge] Search error:', err);
    return [];
  }
}
