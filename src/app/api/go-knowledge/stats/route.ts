import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export async function GET(): Promise<NextResponse> {
  try {
    const supabase = getSupabaseClient();

    const { count: totalCount, error: totalError } = await supabase
      .from("letsgo_position_index")
      .select("*", { count: "exact", head: true });

    if (totalError) {
      return NextResponse.json(
        { error: totalError.message },
        { status: 500 }
      );
    }

    const { data: sizeData, error: sizeError } = await supabase
      .from("letsgo_position_index")
      .select("board_size")
      .order("board_size");

    if (sizeError) {
      return NextResponse.json(
        { error: sizeError.message },
        { status: 500 }
      );
    }

    // Count by board size manually
    const byBoardSize: Record<number, number> = {};
    for (const row of sizeData ?? []) {
      byBoardSize[row.board_size] = (byBoardSize[row.board_size] || 0) + 1;
    }

    return NextResponse.json({
      totalPositions: totalCount ?? 0,
      byBoardSize,
    });
  } catch (err) {
    console.error("[go-knowledge] Stats error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
