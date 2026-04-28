import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { parseSgf } from "@/lib/sgf-parser";
import { generateSnapshotsFromSgf } from "@/lib/board-snapshot";
import { batchEmbeddings, pgVectorFormat } from "@/lib/go-knowledge";

interface ImportRequest {
  sgf: string;
  sourceName?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body: ImportRequest = await request.json();

    if (!body.sgf || typeof body.sgf !== "string") {
      return NextResponse.json({ error: "SGF content is required" }, { status: 400 });
    }

    // 1. Parse SGF
    const parsed = parseSgf(body.sgf);

    // 2. Generate snapshot series
    const snapshots = generateSnapshotsFromSgf(parsed);
    if (snapshots.length === 0) {
      return NextResponse.json({ error: "No moves found in SGF" }, { status: 400 });
    }

    // 3. Batch generate embeddings
    const batchSize = 100;
    const inserted: number[] = [];

    for (let i = 0; i < snapshots.length; i += batchSize) {
      const batch = snapshots.slice(i, i + batchSize);
      const descriptions = batch.map((s) => s.description);
      const embeddings = await batchEmbeddings(descriptions);

      // 4. Insert into database
      const rows = batch.map((snapshot, idx) => ({
        board_size: snapshot.boardSize,
        move_number: snapshot.moveNumber,
        color: snapshot.color,
        coordinate: snapshot.coordinate,
        region: snapshot.region,
        is_star_point: snapshot.isStarPoint,
        patterns: snapshot.patterns,
        description: snapshot.description,
        embedding: pgVectorFormat(embeddings[idx]),
        snapshot: snapshot,
        game_meta: snapshot.gameMeta,
        source_sgf: body.sourceName || body.sgf.slice(0, 500),
      }));

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("letsgo_position_index")
        .insert(rows)
        .select("id");

      if (error) {
        console.error("[go-knowledge] Insert error:", error);
        return NextResponse.json(
          { error: `Insert failed: ${error.message}` },
          { status: 500 }
        );
      }

      inserted.push(...(data?.map((d) => d.id) ?? []));
    }

    return NextResponse.json({
      success: true,
      inserted: inserted.length,
      moves: snapshots.length,
      game: {
        boardSize: parsed.boardSize,
        blackPlayer: parsed.blackPlayer,
        whitePlayer: parsed.whitePlayer,
        result: parsed.result,
      },
    });
  } catch (err) {
    console.error("[go-knowledge] Import error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
