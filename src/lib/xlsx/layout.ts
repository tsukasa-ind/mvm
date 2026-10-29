/** 列幅・行高から、セルの座標 (px) を求める。範囲外は既定値で延長する。 */
export type ColSpec = { min: number; max: number; px: number };

/** Excel の最大列数・行数。壊れたファイルの巨大な添字でメモリを使い切らないための上限 */
const MAX_COLS = 16384;
const MAX_ROWS = 1048576;

export class Layout {
  private colX: number[] = [0];
  private rowY: number[] = [0];

  constructor(
    private readonly colSpecs: ColSpec[],
    private readonly rowPx: Map<number, number>,
    private readonly defaultColPx: number,
    private readonly defaultRowPx: number,
  ) {}

  colWidth(col: number): number {
    const spec = this.colSpecs.find((s) => col + 1 >= s.min && col + 1 <= s.max);
    return spec ? spec.px : this.defaultColPx;
  }

  rowHeight(row: number): number {
    return this.rowPx.get(row + 1) ?? this.defaultRowPx;
  }

  x(col: number): number {
    col = Math.min(Math.max(0, Math.trunc(col)), MAX_COLS);
    while (this.colX.length <= col) this.colX.push((this.colX[this.colX.length - 1] ?? 0) + this.colWidth(this.colX.length - 1));
    return this.colX[col] ?? 0;
  }

  y(row: number): number {
    row = Math.min(Math.max(0, Math.trunc(row)), MAX_ROWS);
    while (this.rowY.length <= row) this.rowY.push((this.rowY[this.rowY.length - 1] ?? 0) + this.rowHeight(this.rowY.length - 1));
    return this.rowY[row] ?? 0;
  }

  /** 先頭から count 個分の境界 (長さ count+1) */
  colBounds(count: number): number[] {
    this.x(count);
    return this.colX.slice(0, count + 1);
  }

  rowBounds(count: number): number[] {
    this.y(count);
    return this.rowY.slice(0, count + 1);
  }
}
