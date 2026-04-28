import { logAiEvent } from './ai-logger';

// Try to load .env.local if running outside Next.js
if (typeof process !== 'undefined' && !process.env.EMBEDDING_API_KEY) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('dotenv').config({ path: '.env.local' });
  } catch {
    // dotenv not available
  }
}

// ─── Provider Configuration ───
// Supports any OpenAI-compatible embedding API:
//   - Kimi (Moonshot):     https://api.moonshot.cn/v1          text-embedding          1536
//   - SiliconFlow:         https://api.siliconflow.cn/v1       BAAI/bge-m3             1024
//   - OpenAI:              https://api.openai.com/v1           text-embedding-3-small  1536
//   - 百度千帆:             https://qianfan.baidubce.com/v2      (custom format, not supported)
//   - 腾讯云混元:           https://hunyuan.tencentcloudapi.com  (custom format, not supported)
//
// Note: 百度和腾讯的 API 不是 OpenAI 兼容格式，需要额外适配。
//       推荐先用 Kimi 或 SiliconFlow（都支持 OpenAI 兼容格式）。

const API_BASE_URL = process.env.EMBEDDING_API_BASE_URL || '';
const API_KEY = process.env.EMBEDDING_API_KEY || '';
const MODEL = process.env.EMBEDDING_MODEL || '';
const DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || '0', 10);

function validateConfig(): void {
  if (!API_BASE_URL) throw new Error('EMBEDDING_API_BASE_URL is not set');
  if (!API_KEY) throw new Error('EMBEDDING_API_KEY is not set');
  if (!MODEL) throw new Error('EMBEDDING_MODEL is not set');
  if (!DIMENSION || DIMENSION <= 0) throw new Error('EMBEDDING_DIMENSION is not set');
}

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
    object: string;
  }>;
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

async function callEmbeddingAPI(texts: string | string[]): Promise<EmbeddingResponse> {
  validateConfig();

  const endpoint = API_BASE_URL.endsWith('/')
    ? `${API_BASE_URL}embeddings`
    : `${API_BASE_URL}/embeddings`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      encoding_format: 'float',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding API error (${response.status}): ${error}`);
  }

  return (await response.json()) as EmbeddingResponse;
}

/**
 * Generate embedding for a single text string
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const start = Date.now();

  const data = await callEmbeddingAPI(text);
  const embedding = data.data[0]?.embedding;

  if (!embedding || embedding.length !== DIMENSION) {
    throw new Error(
      `Invalid embedding response: expected ${DIMENSION} dimensions, got ${embedding?.length}`
    );
  }

  logAiEvent({
    type: 'analyze',
    model: MODEL,
    durationMs: Date.now() - start,
    metadata: {
      tokens: data.usage?.total_tokens,
      textLength: text.length,
      purpose: 'embedding',
    },
  });

  return embedding;
}

/**
 * Batch generate embeddings for multiple texts
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const start = Date.now();

  const data = await callEmbeddingAPI(texts);
  const embeddings = data.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);

  for (const emb of embeddings) {
    if (emb.length !== DIMENSION) {
      throw new Error(
        `Invalid embedding response: expected ${DIMENSION} dimensions, got ${emb.length}`
      );
    }
  }

  logAiEvent({
    type: 'analyze',
    model: MODEL,
    durationMs: Date.now() - start,
    metadata: {
      tokens: data.usage?.total_tokens,
      batchSize: texts.length,
      purpose: 'embedding_batch',
    },
  });

  return embeddings;
}

export function getEmbeddingDimension(): number {
  return DIMENSION;
}
