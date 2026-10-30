export type Rect = { x: number; y: number; w: number; h: number };

export type Fill =
  | { kind: "none" }
  | { kind: "solid"; color: string }
  | { kind: "gradient"; stops: { pos: number; color: string }[]; angle: number };

export type LineEnd = { type: string; w: string; len: string };

export type Stroke = { color: string; width: number; dash: number[] | null; head: LineEnd | null; tail: LineEnd | null };

export type TextRun = { text: string; lineBreak: boolean; sizePx: number; bold: boolean; italic: boolean; underline: boolean; strike: boolean; color: string; font: string };
export type Paragraph = { align: "left" | "center" | "right" | "justify"; runs: TextRun[]; sizePx: number };
export type TextBody = {
  paragraphs: Paragraph[];
  anchor: "t" | "ctr" | "b";
  insets: { l: number; t: number; r: number; b: number };
  wrap: boolean;
  /** horz: 横書き / vert: 文字を90°回転 / eaVert: 日本語の縦書き / vert270: 270°回転 */
  vert: "horz" | "vert" | "eaVert" | "vert270";
};

type Placement = { rect: Rect; rot: number; flipH: boolean; flipV: boolean };
export type ShapeNode = Placement & { kind: "shape"; geom: string; adj: Record<string, number>; fill: Fill; stroke: Stroke | null; text: TextBody | null };
export type PicNode = Placement & { kind: "pic"; href: string };
export type GroupNode = Placement & { kind: "group"; children: DrawNode[] };
export type DrawNode = ShapeNode | PicNode | GroupNode;

export type CellData = { r: number; c: number; xf: number; text: string | null; isNumber: boolean };
export type MergeRange = { r1: number; c1: number; r2: number; c2: number };

export type SheetModel = {
  name: string;
  width: number;
  height: number;
  showGrid: boolean;
  /** Excel が保存している表示倍率 (%)。未指定は null */
  zoom: number | null;
  colX: number[];
  rowY: number[];
  cells: CellData[];
  merges: MergeRange[];
  nodes: DrawNode[];
  /** 未対応の図形のプリセット名と個数 */
  unsupported: Record<string, number>;
  /** 描画の上限で切り詰めたときの、表示している行数・列数。切り詰めていなければ null */
  truncated: { rows: number; cols: number } | null;
};
