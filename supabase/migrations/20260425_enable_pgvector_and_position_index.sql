-- ============================================================
-- Enable pgvector extension and create position index table
--
-- Default dimension: 1024 (SiliconFlow BGE-M3)
-- If using Kimi/OpenAI (1536 dim), change VECTOR(1024) to VECTOR(1536)
-- ============================================================

-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Create position index table for RAG knowledge base
CREATE TABLE IF NOT EXISTS letsgo_position_index (
  id BIGSERIAL PRIMARY KEY,
  board_size INTEGER NOT NULL,
  move_number INTEGER NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('black', 'white')),
  coordinate JSONB NOT NULL, -- { row: number, col: number }
  region TEXT NOT NULL CHECK (region IN ('corner', 'edge', 'center')),
  is_star_point BOOLEAN NOT NULL DEFAULT FALSE,
  patterns JSONB NOT NULL DEFAULT '[]', -- Array of { type, confidence, description }
  description TEXT NOT NULL, -- Natural language description for display and debugging
  embedding VECTOR(1024), -- Default: SiliconFlow BGE-M3. Change to 1536 for Kimi/OpenAI
  snapshot JSONB NOT NULL, -- Full BoardSnapshot object
  game_meta JSONB, -- { blackPlayer, whitePlayer, komi, result }
  source_sgf TEXT, -- Original SGF content or reference
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW vector index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_position_embedding
  ON letsgo_position_index
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index for filtering by board size and move number
CREATE INDEX IF NOT EXISTS idx_position_board_move
  ON letsgo_position_index (board_size, move_number);

-- Index for region filtering
CREATE INDEX IF NOT EXISTS idx_position_region
  ON letsgo_position_index (region);

-- Index for pattern type search (using GIN for JSONB array)
CREATE INDEX IF NOT EXISTS idx_position_patterns
  ON letsgo_position_index USING GIN (patterns jsonb_path_ops);

-- Create RPC function for vector similarity search
-- NOTE: If you change VECTOR dimension, update the parameter type below
CREATE OR REPLACE FUNCTION search_similar_positions(
  query_embedding VECTOR(1024), -- Default: 1024 for BGE-M3. Change to 1536 for Kimi/OpenAI
  p_board_size INTEGER,
  p_move_number_min INTEGER DEFAULT 0,
  p_move_number_max INTEGER DEFAULT 999,
  p_region TEXT DEFAULT NULL,
  match_count INTEGER DEFAULT 5
)
RETURNS TABLE (
  id BIGINT,
  board_size INTEGER,
  move_number INTEGER,
  color TEXT,
  coordinate JSONB,
  region TEXT,
  description TEXT,
  snapshot JSONB,
  game_meta JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.board_size,
    p.move_number,
    p.color,
    p.coordinate,
    p.region,
    p.description,
    p.snapshot,
    p.game_meta,
    1 - (p.embedding <=> query_embedding) AS similarity
  FROM letsgo_position_index p
  WHERE p.board_size = p_board_size
    AND p.move_number BETWEEN p_move_number_min AND p_move_number_max
    AND (p_region IS NULL OR p.region = p_region)
    AND p.embedding IS NOT NULL
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
