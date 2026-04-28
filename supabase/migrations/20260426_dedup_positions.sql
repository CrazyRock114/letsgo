-- ============================================================
-- Position deduplication: remove duplicate records from letsgo_position_index
--
-- Duplicate definition: same (board_size, move_number, color, coordinate, snapshot)
-- Keep strategy: preserve the record with the smallest id (earliest insert)
-- ============================================================

-- Function: count duplicate groups and records that would be deleted
CREATE OR REPLACE FUNCTION count_duplicate_positions()
RETURNS TABLE (groups BIGINT, to_delete BIGINT)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH dup_groups AS (
    SELECT board_size, move_number, color, coordinate, snapshot
    FROM letsgo_position_index
    GROUP BY board_size, move_number, color, coordinate, snapshot
    HAVING COUNT(*) > 1
  ),
  dup_counts AS (
    SELECT COUNT(*) AS group_count,
           SUM(cnt - 1) AS delete_count
    FROM (
      SELECT board_size, move_number, color, coordinate, snapshot, COUNT(*) AS cnt
      FROM letsgo_position_index
      GROUP BY board_size, move_number, color, coordinate, snapshot
      HAVING COUNT(*) > 1
    ) t
  )
  SELECT dc.group_count, dc.delete_count FROM dup_counts dc;
END;
$$;

-- Function: delete duplicate positions, keeping the earliest (smallest id)
CREATE OR REPLACE FUNCTION delete_duplicate_positions()
RETURNS TABLE (deleted_count BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  deleted BIGINT;
BEGIN
  -- Delete all but the earliest record in each duplicate group
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY board_size, move_number, color, coordinate, snapshot
             ORDER BY id ASC
           ) AS rn
    FROM letsgo_position_index
  )
  DELETE FROM letsgo_position_index
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  GET DIAGNOSTICS deleted = ROW_COUNT;

  RETURN QUERY SELECT deleted;
END;
$$;
