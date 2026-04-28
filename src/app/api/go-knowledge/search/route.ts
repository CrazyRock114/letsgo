import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { generateEmbedding } from "@/lib/embedding";
import { pgVectorFormat } from "@/lib/go-knowledge";

interface SearchRequest {
  description: string;
  boardSize: number;
  moveNumberMin?: number;
  moveNumberMax?: number;
  region?: string;
  matchCount?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body: SearchRequest = await request.json();

    if (!body.description || typeof body.description !== "string") {
      return NextResponse.json(
        { error: "Description is required" },
        { status: 400 }
      );
    }

    const boardSize = body.boardSize ?? 19;
    const matchCount = Math.min(body.matchCount ?? 5, 20);

    // 1. Generate query embedding
    const embedding = await generateEmbedding(body.description);

    // 2. Call RPC search
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("search_similar_positions", {
      query_embedding: pgVectorFormat(embedding),
      p_board_size: boardSize,
      p_move_number_min: body.moveNumberMin ?? 0,
      p_move_number_max: body.moveNumberMax ?? 999,
      p_region: body.region || null,
      match_count: matchCount,
    });

    if (error) {
      console.error("[go-knowledge] Search error:", error);
      return NextResponse.json(
        { error: `Search failed: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      results: data ?? [],
      query: body.description,
      boardSize,
    });
  } catch (err) {
    console.error("[go-knowledge] Search error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
