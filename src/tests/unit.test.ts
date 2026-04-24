import { describe, it, expect } from 'vitest';
import { getKomi } from '@/lib/go-logic';

// ============================================================
// 坐标转换测试（从 route.ts 提取的核心逻辑）
// ============================================================

function boardToGTPCoord(row: number, col: number, boardSize: number): string {
  const colChar = col >= 8 ? String.fromCharCode(65 + col + 1) : String.fromCharCode(65 + col);
  const rowNum = boardSize - row;
  return `${colChar}${rowNum}`;
}

function gtpToBoardCoord(gtpCoord: string, boardSize: number): { row: number; col: number } | null {
  const match = gtpCoord.toUpperCase().match(/^([A-HJ-T])(\d+)$/);
  if (!match) return null;
  const colChar = match[1];
  const rowNum = parseInt(match[2]);
  let col = colChar.charCodeAt(0) - 65;
  if (col >= 8) col -= 1;
  const row = boardSize - rowNum;
  if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) return null;
  return { row, col };
}

// ============================================================
// 模型路径映射测试
// ============================================================

function getModelKeyFromPath(path: string): string | null {
  const basename = path.split('/').pop() || path;
  if (/kata9x9/.test(basename)) return 'kata9x9';
  if (/b18c384nbt-humanv0/.test(basename)) return 'humanv0';
  if (/rect15-b20c256/.test(basename)) return 'rect15';
  if (/lionffen_b24c64/.test(basename)) return 'b24c64';
  if (/lionffen_b6c64/.test(basename)) return 'b6c64';
  if (/g170-b6c96/.test(basename)) return 'g170';
  return null;
}

function getModelPathFromKey(key: string): string | null {
  const map: Record<string, string> = {
    rect15: '/usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz',
    kata9x9: '/usr/local/katago/kata9x9-b18c384nbt-20231025.bin.gz',
    humanv0: '/usr/local/katago/b18c384nbt-humanv0.bin.gz',
    g170: '/usr/local/katago/g170-b6c96-s175395328-d26788732.bin.gz',
    b6c64: '/usr/local/katago/lionffen_b6c64.txt.gz',
    b24c64: '/usr/local/katago/lionffen_b24c64_3x3_v3_12300.bin.gz',
  };
  return map[key] || null;
}

// ============================================================
// 测试套件
// ============================================================

describe('getKomi', () => {
  it('9x9 fair komi = 7', () => {
    expect(getKomi(9)).toBe(7);
  });
  it('13x13 standard komi = 7.5', () => {
    expect(getKomi(13)).toBe(7.5);
  });
  it('19x19 standard komi = 7.5', () => {
    expect(getKomi(19)).toBe(7.5);
  });
  it('7x7 uses 9x9 komi = 7', () => {
    expect(getKomi(7)).toBe(7);
  });
});

describe('坐标转换', () => {
  it('boardToGTPCoord 往返一致', () => {
    const size = 9;
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const gtp = boardToGTPCoord(row, col, size);
        const back = gtpToBoardCoord(gtp, size);
        expect(back).not.toBeNull();
        expect(back!.row).toBe(row);
        expect(back!.col).toBe(col);
      }
    }
  });

  it('boardToGTPCoord 跳过 I 列', () => {
    expect(boardToGTPCoord(0, 7, 9)).toBe('H9');
    expect(boardToGTPCoord(0, 8, 9)).toBe('J9'); // 跳过 I
  });

  it('gtpToBoardCoord 处理 pass/resign', () => {
    expect(gtpToBoardCoord('pass', 9)).toBeNull();
    expect(gtpToBoardCoord('resign', 9)).toBeNull();
  });

  it('gtpToBoardCoord 边界检查', () => {
    expect(gtpToBoardCoord('T20', 19)).toBeNull(); // 超出棋盘
    expect(gtpToBoardCoord('A0', 9)).toBeNull();
  });
});

describe('模型路径映射', () => {
  it('rect15 路径往返一致', () => {
    const path = '/usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz';
    expect(getModelKeyFromPath(path)).toBe('rect15');
    expect(getModelPathFromKey('rect15')).toBe(path);
  });

  it('kata9x9 路径识别', () => {
    expect(getModelKeyFromPath('/usr/local/katago/kata9x9-b18c384nbt-20231025.bin.gz')).toBe('kata9x9');
  });

  it('humanv0 路径识别', () => {
    expect(getModelKeyFromPath('/usr/local/katago/b18c384nbt-humanv0.bin.gz')).toBe('humanv0');
  });

  it('g170 路径识别', () => {
    expect(getModelKeyFromPath('/usr/local/katago/g170-b6c96-s175395328-d26788732.bin.gz')).toBe('g170');
  });

  it('b6c64 路径识别', () => {
    expect(getModelKeyFromPath('/usr/local/katago/lionffen_b6c64.txt.gz')).toBe('b6c64');
  });

  it('b24c64 路径识别', () => {
    expect(getModelKeyFromPath('/usr/local/katago/lionffen_b24c64_3x3_v3_12300.bin.gz')).toBe('b24c64');
  });

  it('未知路径返回 null', () => {
    expect(getModelKeyFromPath('/usr/local/katago/unknown.bin.gz')).toBeNull();
    expect(getModelPathFromKey('unknown')).toBeNull();
  });
});
