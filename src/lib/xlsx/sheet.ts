import { formatNumber, formatText } from "./numfmt";
import type { Styles } from "./styles";
import { Layout, type ColSpec } from "./layout";
import type { CellData, MergeRange } from "./types";
import { attr, flag, kid, kids, num, text, parseXml } from "./xml";

export type ParsedSheet = {
  layout: Layout;
  cells: CellData[];
  merges: MergeRange[];
  showGrid: boolean;
  zoom: number | null;
  maxRow: number;
  maxCol: number;
  drawingRid: string | null;
};

const PT_TO_PX = 96 / 72;

/** "AB12" → { r: 11, c: 27 } (0 始まり) */
export const parseRef = (ref: string): { r: number; c: number } => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return { r: 0, c: 0 };
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
};

/** 共有文字列表 (ルビ <rPh> は除く) */
export const parseSharedStrings = (xml: string | null): string[] => {
  if (!xml) return [];
  return kids(parseXml(xml), "si").map((si) => {
    const direct = kid(si, "t");
    if (direct) return text(direct);
    return kids(si, "r").map((r) => text(kid(r, "t"))).join("");
  });
};

/** 既定フォントの最大桁幅 (px)。列幅 (文字数) をピクセルに換算する係数。 */
export const maxDigitWidth = (font: { name: string; size: number }): number =>
  /calibri|arial|verdana|tahoma|segoe|helvetica|times/i.test(font.name) ? 7 : 8;

export const parseSheet = (xml: string, styles: Styles, sst: string[], mdw: number): ParsedSheet => {
  const root = parseXml(xml);
  const fmt = kid(root, "sheetFormatPr");
  const defaultColWidth = attr(fmt, "defaultColWidth");
  const baseColWidth = num(fmt, "baseColWidth", 8);
  const defaultColPx = Math.round((defaultColWidth !== null ? Number(defaultColWidth) : baseColWidth + 5 / mdw) * mdw);
  const defaultRowPx = Math.round(num(fmt, "defaultRowHeight", 15) * PT_TO_PX);

  const colSpecs: ColSpec[] = kids(kid(root, "cols"), "col").map((c) => ({
    min: num(c, "min", 1),
    max: num(c, "max", 1),
    px: flag(c, "hidden") ? 0 : Math.round(num(c, "width", defaultColPx / mdw) * mdw),
  }));

  const rowPx = new Map<number, number>();
  const cells: CellData[] = [];
  let maxRow = 0;
  let maxCol = 0;
  let lastRow = 0;
  for (const row of kids(kid(root, "sheetData"), "row")) {
    // r 属性は省略できる。省略時は直前の行の次の行
    const rIdx = num(row, "r", lastRow + 1);
    lastRow = rIdx;
    let nextCol = 0;
    if (flag(row, "hidden")) rowPx.set(rIdx, 0);
    else if (attr(row, "ht") !== null) rowPx.set(rIdx, Math.round(num(row, "ht", 15) * PT_TO_PX));
    for (const c of kids(row, "c")) {
      const refAttr = attr(c, "r");
      const ref = refAttr !== null ? parseRef(refAttr) : { r: rIdx - 1, c: nextCol };
      nextCol = ref.c + 1;
      const xf = num(c, "s", 0);
      const style = styles.xfs[xf];
      const type = attr(c, "t");
      const v = text(kid(c, "v"));
      let display: string | null = null;
      if (type === "s") display = formatText(sst[Number(v)] ?? "", style?.numFmt);
      else if (type === "inlineStr") display = formatText(text(kid(kid(c, "is"), "t")) || kids(kid(c, "is"), "r").map((r) => text(kid(r, "t"))).join(""), style?.numFmt);
      else if (type === "str") display = formatText(v, style?.numFmt);
      else if (type === "e" || type === "d") display = v;
      else if (type === "b") display = v === "1" ? "TRUE" : "FALSE";
      else if (v !== "") display = formatNumber(Number(v), style?.numFmt);
      const hasLook = style !== undefined && (style.fill !== null || Object.values(style.border).some(Boolean));
      if (display === "") display = null;
      if (display === null && !hasLook) continue;
      cells.push({ r: ref.r, c: ref.c, xf, text: display, isNumber: type === null || type === "n" });
      maxRow = Math.max(maxRow, ref.r + 1);
      maxCol = Math.max(maxCol, ref.c + 1);
    }
  }

  const merges = kids(kid(root, "mergeCells"), "mergeCell").map((m): MergeRange => {
    const [a = "A1", b = a] = (attr(m, "ref") ?? "A1").split(":");
    const s = parseRef(a);
    const e = parseRef(b);
    return { r1: s.r, c1: s.c, r2: e.r, c2: e.c };
  });
  for (const m of merges) {
    maxRow = Math.max(maxRow, m.r2 + 1);
    maxCol = Math.max(maxCol, m.c2 + 1);
  }

  const view = kid(kid(root, "sheetViews"), "sheetView");
  return {
    layout: new Layout(colSpecs, rowPx, defaultColPx, defaultRowPx),
    cells,
    merges,
    showGrid: attr(view, "showGridLines") !== "0",
    zoom: attr(view, "zoomScale") !== null ? num(view, "zoomScale", 100) : null,
    maxRow,
    maxCol,
    drawingRid: attr(kid(root, "drawing"), "r:id"),
  };
};
