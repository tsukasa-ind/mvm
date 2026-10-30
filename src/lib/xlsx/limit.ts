import type { CellData, MergeRange } from "./types";

/**
 * 描画する範囲の上限。最終セルが XFD1048576 のように遠いシートや、書式だけのセルが大量にあるシートで、
 * グリッド線と foreignObject が数十万〜百万個になり描画が固まるのを防ぐ。超えた分は表示しない。
 */
export const MAX_RENDER_ROWS = 10000;
export const MAX_RENDER_COLS = 1000;
export const MAX_RENDER_CELLS = 50000;

export type LimitedRange = {
  cells: CellData[];
  merges: MergeRange[];
  rows: number;
  cols: number;
  /** 上限で切り詰めたか */
  truncated: boolean;
};

/** 使用範囲 (rows × cols) とセルを、描画の上限に収める。セル数の上限は行単位で切り、行の途中では切らない。 */
export const limitRange = (cells: CellData[], merges: MergeRange[], rows: number, cols: number): LimitedRange => {
  let limitRows = Math.min(rows, MAX_RENDER_ROWS);
  const limitCols = Math.min(cols, MAX_RENDER_COLS);
  let inside = cells.filter((cell) => cell.r < limitRows && cell.c < limitCols);
  if (inside.length > MAX_RENDER_CELLS) {
    // 上限番目のセルの行から先を捨てる
    const sorted = [...inside].sort((a, b) => a.r - b.r);
    limitRows = sorted[MAX_RENDER_CELLS]!.r;
    inside = inside.filter((cell) => cell.r < limitRows);
  }
  const truncated = limitRows < rows || limitCols < cols;
  if (!truncated) return { cells, merges, rows, cols, truncated };
  const clamped = merges
    .filter((m) => m.r1 < limitRows && m.c1 < limitCols)
    .map((m) => ({ ...m, r2: Math.min(m.r2, limitRows - 1), c2: Math.min(m.c2, limitCols - 1) }));
  return { cells: inside, merges: clamped, rows: limitRows, cols: limitCols, truncated };
};
