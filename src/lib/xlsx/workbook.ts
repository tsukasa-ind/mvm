import { unzipSync } from "fflate";
import { parseDrawing } from "./drawing";
import { maxDigitWidth, parseSharedStrings, parseSheet } from "./sheet";
import { parseStyles, type Styles } from "./styles";
import { parseTheme, type Theme } from "./theme";
import type { DrawNode, SheetModel } from "./types";
import { attr, kids, parseXml, kid } from "./xml";

export type Workbook = {
  sheets: { name: string; hidden: boolean }[];
  styles: Styles;
  /** シートを解析する (結果はキャッシュされる) */
  sheet: (index: number) => SheetModel;
};

const decoder = new TextDecoder("utf-8");
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp" };

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
};

/** "xl/worksheets/sheet1.xml" と "../drawings/drawing1.xml" から "xl/drawings/drawing1.xml" を得る。 */
export const resolvePath = (baseFile: string, target: string): string => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseFile.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
};

const relsOf = (files: Record<string, Uint8Array>, file: string): Map<string, string> => {
  const dir = file.split("/").slice(0, -1).join("/");
  const name = file.split("/").pop()!;
  const bytes = files[`${dir}/_rels/${name}.rels`];
  const map = new Map<string, string>();
  if (!bytes) return map;
  for (const r of kids(parseXml(decoder.decode(bytes)), "Relationship")) {
    if (attr(r, "Id") && attr(r, "Target")) map.set(attr(r, "Id")!, attr(r, "TargetMode") === "External" ? "" : resolvePath(file, attr(r, "Target")!));
  }
  return map;
};

const bounds = (nodes: DrawNode[]): { w: number; h: number } => {
  let w = 0;
  let h = 0;
  for (const n of nodes) {
    // 回転した図形は、回転後の外接矩形で数える
    const theta = (n.rot * Math.PI) / 180;
    const c = Math.abs(Math.cos(theta));
    const s = Math.abs(Math.sin(theta));
    const bw = n.rect.w * c + n.rect.h * s;
    const bh = n.rect.w * s + n.rect.h * c;
    w = Math.max(w, n.rect.x + n.rect.w / 2 + bw / 2);
    h = Math.max(h, n.rect.y + n.rect.h / 2 + bh / 2);
  }
  return { w, h };
};

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export const loadWorkbook = (bytes: Uint8Array): Workbook => {
  // zip bomb で展開時にメモリを使い切らないよう、ファイル単位と合計の展開サイズを制限する
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (file.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new Error("xlsx の展開後のサイズが大きすぎます");
      return true;
    },
  });
  const dataUris = new Map<string, string>();
  const read = (path: string): string | null => (files[path] ? decoder.decode(files[path]) : null);
  const workbookXml = read("xl/workbook.xml");
  if (!workbookXml) throw new Error("xl/workbook.xml がありません (xlsx ではありません)");
  const wb = parseXml(workbookXml);
  const wbRels = relsOf(files, "xl/workbook.xml");

  const sheetDefs = kids(kid(wb, "sheets"), "sheet").map((s) => ({
    name: attr(s, "name") ?? "Sheet",
    hidden: (attr(s, "state") ?? "visible") !== "visible",
    path: wbRels.get(attr(s, "r:id") ?? "") ?? "",
  }));

  const theme: Theme = parseTheme(read("xl/theme/theme1.xml"));
  const styles = parseStyles(read("xl/styles.xml") ?? "<styleSheet/>", theme.colors);
  const sst = parseSharedStrings(read("xl/sharedStrings.xml"));
  const mdw = maxDigitWidth(styles.defaultFont);
  const cache = new Map<number, SheetModel>();

  const sheet = (index: number): SheetModel => {
    const cached = cache.get(index);
    if (cached) return cached;
    const def = sheetDefs[index];
    const xml = def ? read(def.path) : null;
    if (!def || !xml) throw new Error(`シート ${index} を読み込めません`);
    const parsed = parseSheet(xml, styles, sst, mdw);

    let nodes: DrawNode[] = [];
    let unsupported: Record<string, number> = {};
    const drawingPath = parsed.drawingRid ? relsOf(files, def.path).get(parsed.drawingRid) : undefined;
    const drawingXml = drawingPath ? read(drawingPath) : null;
    if (drawingPath && drawingXml) {
      const drawingRels = relsOf(files, drawingPath);
      const result = parseDrawing(drawingXml, {
        theme,
        layout: parsed.layout,
        media: (rid) => {
          const path = drawingRels.get(rid);
          const data = path ? files[path] : undefined;
          const mime = path ? MIME[path.split(".").pop()!.toLowerCase()] : undefined;
          if (!path || !data || !mime) return null;
          // 同じ画像を何度も参照するファイルで、data URI を複製しない
          let uri = dataUris.get(path);
          if (uri === undefined) {
            uri = `data:${mime};base64,${toBase64(data)}`;
            dataUris.set(path, uri);
          }
          return uri;
        },
      });
      nodes = result.nodes;
      unsupported = result.unsupported;
    }

    // 描画範囲 (セル・図形の両方を含む)。右下に余白を持たせる
    const b = bounds(nodes);
    const colCount = Math.max(parsed.maxCol, 1);
    const rowCount = Math.max(parsed.maxRow, 1);
    const width = Math.max(parsed.layout.x(colCount), b.w) + 16;
    const height = Math.max(parsed.layout.y(rowCount), b.h) + 16;
    const model: SheetModel = {
      name: def.name,
      width,
      height,
      showGrid: parsed.showGrid,
      zoom: parsed.zoom,
      colX: parsed.layout.colBounds(colCount),
      rowY: parsed.layout.rowBounds(rowCount),
      cells: parsed.cells,
      merges: parsed.merges,
      nodes,
      unsupported,
    };
    cache.set(index, model);
    return model;
  };

  return { sheets: sheetDefs.map(({ name, hidden }) => ({ name, hidden })), styles, sheet };
};
