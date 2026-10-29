import { type Color, resolveDrawingColor, resolveSolidFill, toCss } from "./color";
import { buildGeometry } from "./geometry";
import type { Layout } from "./layout";
import type { Theme } from "./theme";
import type { DrawNode, Fill, LineEnd, Paragraph, Rect, ShapeNode, Stroke, TextBody, TextRun } from "./types";
import { attr, flag, kid, kids, num, parseXml, text } from "./xml";

export type DrawingContext = {
  theme: Theme;
  layout: Layout;
  /** リレーション ID から、画像の data URI (未対応形式は null) */
  media: (rid: string) => string | null;
};

const EMU_PX = 9525;
const PT_PX = 96 / 72;
const FILL_TAGS = ["noFill", "solidFill", "gradFill", "pattFill", "blipFill"];

type Placer = (xfrm: Element | null) => Rect | null;

const DASHES: Record<string, number[]> = {
  dot: [1, 3], sysDot: [1, 1], dash: [4, 3], sysDash: [3, 1], lgDash: [8, 3], dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

const placement = (xfrm: Element | null) => ({ rot: num(xfrm, "rot", 0) / 60000, flipH: flag(xfrm, "flipH"), flipV: flag(xfrm, "flipV") });

const colorOfRef = (ref: Element | null, ctx: DrawingContext): Color | null => (ref ? resolveDrawingColor(kids(ref)[0] ?? null, ctx.theme.colors) : null);

const parseFill = (spPr: Element | null, style: Element | null, ctx: DrawingContext): Fill => {
  const el = kids(spPr).find((k) => FILL_TAGS.includes(k.localName));
  if (el) {
    if (el.localName === "noFill" || el.localName === "blipFill") return { kind: "none" };
    if (el.localName === "solidFill") {
      const c = resolveSolidFill(el, ctx.theme.colors);
      return c ? { kind: "solid", color: toCss(c) } : { kind: "none" };
    }
    if (el.localName === "pattFill") {
      const c = resolveSolidFill(kid(el, "fgClr"), ctx.theme.colors);
      return c ? { kind: "solid", color: toCss(c) } : { kind: "none" };
    }
    const stops = kids(kid(el, "gsLst"), "gs").flatMap((gs) => {
      const c = resolveDrawingColor(kids(gs)[0] ?? null, ctx.theme.colors);
      return c ? [{ pos: num(gs, "pos", 0) / 100000, color: toCss(c) }] : [];
    });
    if (stops.length === 0) return { kind: "none" };
    return { kind: "gradient", stops, angle: num(kid(el, "lin"), "ang", 0) / 60000 };
  }
  const ref = kid(style, "fillRef");
  if (ref && num(ref, "idx", 0) > 0) {
    const c = colorOfRef(ref, ctx);
    if (c) return { kind: "solid", color: toCss(c) };
  }
  return { kind: "none" };
};

const lineEnd = (el: Element | null): LineEnd | null => {
  const type = attr(el, "type");
  return el && type && type !== "none" ? { type, w: attr(el, "w") ?? "med", len: attr(el, "len") ?? "med" } : null;
};

const parseStroke = (spPr: Element | null, style: Element | null, ctx: DrawingContext): Stroke | null => {
  const ln = kid(spPr, "ln");
  if (ln && kid(ln, "noFill")) return null;
  const ref = kid(style, "lnRef");
  const idx = num(ref, "idx", 0);
  let color: Color | null = null;
  const solid = kid(ln, "solidFill");
  if (solid) color = resolveSolidFill(solid, ctx.theme.colors);
  else if (kid(ln, "gradFill")) color = resolveDrawingColor(kids(kid(kid(ln, "gradFill"), "gsLst"), "gs")[0] ? (kids(kids(kid(kid(ln, "gradFill"), "gsLst"), "gs")[0])[0] ?? null) : null, ctx.theme.colors);
  else if (ref && idx > 0) color = colorOfRef(ref, ctx);
  if (!color) return null;
  const widthEmu = attr(ln, "w") !== null ? num(ln, "w", 9525) : idx > 0 ? (ctx.theme.lineWidths[idx - 1] ?? 12700) : 9525;
  const width = Math.max(widthEmu / EMU_PX, 0.5);
  const dashName = attr(kid(ln, "prstDash"), "val");
  return {
    color: toCss(color),
    width,
    dash: dashName && DASHES[dashName] ? DASHES[dashName]!.map((n) => n * width) : null,
    head: lineEnd(kid(ln, "headEnd")),
    tail: lineEnd(kid(ln, "tailEnd")),
  };
};

export const FALLBACK_FONTS = ['"Meiryo UI"', "Meiryo", '"Yu Gothic"', '"Noto Sans CJK JP"', '"Noto Sans JP"', "sans-serif"];

const fontStack = (names: (string | null | undefined)[], ctx: DrawingContext): string => {
  const resolved = names
    .map((n) => (n === "+mn-ea" || n === "+mj-ea" ? ctx.theme.minorEa : n === "+mn-lt" || n === "+mj-lt" ? ctx.theme.minorLatin : n))
    .filter((n): n is string => !!n);
  return [...new Set([...resolved.map((n) => `"${n.replace(/"/g, "")}"`), ...FALLBACK_FONTS])].join(", ");
};

const parseText = (txBody: Element | null, style: Element | null, ctx: DrawingContext): TextBody | null => {
  if (!txBody) return null;
  const paras = kids(txBody, "p");
  if (!paras.some((p) => kids(p).some((c) => ["r", "fld"].includes(c.localName) && text(kid(c, "t")) !== ""))) return null;
  const body = kid(txBody, "bodyPr");
  const defaultColor = toCss(colorOfRef(kid(style, "fontRef"), ctx) ?? { r: 0, g: 0, b: 0, a: 1 });

  const run = (rPr: Element | null, value: string, lineBreak: boolean): TextRun => {
    const colorEl = kid(rPr, "solidFill");
    const color = colorEl ? resolveSolidFill(colorEl, ctx.theme.colors) : null;
    return {
      text: value,
      lineBreak,
      sizePx: (num(rPr, "sz", 1100) / 100) * PT_PX,
      bold: flag(rPr, "b"),
      italic: flag(rPr, "i"),
      underline: attr(rPr, "u") !== null && attr(rPr, "u") !== "none",
      strike: (attr(rPr, "strike") ?? "noStrike") !== "noStrike",
      color: color ? toCss(color) : defaultColor,
      font: fontStack([attr(kid(rPr, "ea"), "typeface"), attr(kid(rPr, "latin"), "typeface"), ctx.theme.minorEa], ctx),
    };
  };

  const paragraphs = paras.map((p): Paragraph => {
    const algn = attr(kid(p, "pPr"), "algn");
    const runs: TextRun[] = [];
    for (const c of kids(p)) {
      if (c.localName === "r" || c.localName === "fld") runs.push(run(kid(c, "rPr"), text(kid(c, "t")), false));
      else if (c.localName === "br") runs.push(run(kid(c, "rPr"), "", true));
    }
    return {
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" || algn === "dist" ? "justify" : "left",
      runs,
      sizePx: (num(kid(p, "endParaRPr"), "sz", 1100) / 100) * PT_PX,
    };
  });
  const anchor = attr(body, "anchor");
  const vert = attr(body, "vert") ?? "horz";
  return {
    paragraphs,
    anchor: anchor === "ctr" ? "ctr" : anchor === "b" ? "b" : "t",
    insets: { l: num(body, "lIns", 91440) / EMU_PX, t: num(body, "tIns", 45720) / EMU_PX, r: num(body, "rIns", 91440) / EMU_PX, b: num(body, "bIns", 45720) / EMU_PX },
    wrap: attr(body, "wrap") !== "none",
    vert: vert === "vert" || vert === "eaVert" || vert === "vert270" ? vert : vert === "wordArtVert" ? "eaVert" : "horz",
  };
};

const adjustments = (spPr: Element | null): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const gd of kids(kid(kid(spPr, "prstGeom"), "avLst"), "gd")) {
    const m = /^val\s+(-?\d+)/.exec(attr(gd, "fmla") ?? "");
    if (m && attr(gd, "name")) out[attr(gd, "name")!] = Number(m[1]);
  }
  return out;
};

const offExt = (xfrm: Element | null) => ({
  x: num(kid(xfrm, "off"), "x", 0) / EMU_PX,
  y: num(kid(xfrm, "off"), "y", 0) / EMU_PX,
  w: num(kid(xfrm, "ext"), "cx", 0) / EMU_PX,
  h: num(kid(xfrm, "ext"), "cy", 0) / EMU_PX,
});

/** グループの子座標系 (chOff / chExt) から、絶対座標への変換 */
const childPlacer = (group: Rect, xfrm: Element | null): Placer => {
  const chOff = kid(xfrm, "chOff");
  const chExt = kid(xfrm, "chExt");
  const cx = num(chExt, "cx", 0) / EMU_PX;
  const cy = num(chExt, "cy", 0) / EMU_PX;
  const sx = cx > 0 ? group.w / cx : 1;
  const sy = cy > 0 ? group.h / cy : 1;
  const ox = num(chOff, "x", 0) / EMU_PX;
  const oy = num(chOff, "y", 0) / EMU_PX;
  return (child) => {
    if (!child) return null;
    const r = offExt(child);
    return { x: group.x + (r.x - ox) * sx, y: group.y + (r.y - oy) * sy, w: r.w * sx, h: r.h * sy };
  };
};

/**
 * 回転した図形のアンカー (from/to) は、回転後の外接矩形になる。xfrm の ext (回転前の大きさ) を、
 * 外接矩形の拡縮比で補正した回転前の矩形を、アンカーの中心に置いて返す。
 */
export const unrotatedRect = (anchor: Rect, xfrm: Element | null): Rect => {
  const rot = num(xfrm, "rot", 0) / 60000;
  const theta = (rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  const w = num(kid(xfrm, "ext"), "cx", 0) / EMU_PX;
  const h = num(kid(xfrm, "ext"), "cy", 0) / EMU_PX;
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  if (s < 1e-6 || bw <= 0 || bh <= 0) return anchor;
  const sx = anchor.w / bw;
  const sy = anchor.h / bh;
  const w2 = (w * (c * sx + s * sy)) / (c + s);
  const h2 = (h * (c * sy + s * sx)) / (c + s);
  return { x: anchor.x + anchor.w / 2 - w2 / 2, y: anchor.y + anchor.h / 2 - h2 / 2, w: w2, h: h2 };
};

const parseNode = (el: Element, place: Placer, ctx: DrawingContext, unsupported: Record<string, number>): DrawNode | null => {
  const name = el.localName;
  const nv = kid(el, "nvSpPr") ?? kid(el, "nvCxnSpPr") ?? kid(el, "nvPicPr") ?? kid(el, "nvGrpSpPr");
  if (flag(kid(nv, "cNvPr"), "hidden")) return null;

  if (name === "grpSp") {
    const xfrm = kid(kid(el, "grpSpPr"), "xfrm");
    const rect = place(xfrm);
    if (!rect) return null;
    const inner = childPlacer(rect, xfrm);
    const children = kids(el)
      .filter((c) => ["sp", "grpSp", "cxnSp", "pic", "graphicFrame"].includes(c.localName))
      .flatMap((c) => parseNode(c, inner, ctx, unsupported) ?? []);
    return { kind: "group", rect, ...placement(xfrm), children };
  }

  if (name === "pic") {
    const spPr = kid(el, "spPr");
    const xfrm = kid(spPr, "xfrm");
    const rect = place(xfrm);
    const blip = kid(kid(el, "blipFill"), "blip");
    if (!rect || !blip) return null;
    // Excel は PNG を blip に置き、SVG 版を拡張 (svgBlip) に持つ。SVG があれば拡大しても滑らかなため優先する
    const svg = (function find(node: Element): string | null {
      for (const c of kids(node)) {
        if (c.localName === "svgBlip") return attr(c, "r:embed");
        const found = find(c);
        if (found) return found;
      }
      return null;
    })(blip);
    const href = (svg ? ctx.media(svg) : null) ?? ctx.media(attr(blip, "r:embed") ?? "");
    if (!href) {
      unsupported["picture(format)"] = (unsupported["picture(format)"] ?? 0) + 1;
      return null;
    }
    return { kind: "pic", rect, ...placement(xfrm), href };
  }

  if (name === "graphicFrame") {
    unsupported.graphicFrame = (unsupported.graphicFrame ?? 0) + 1;
    return null;
  }

  if (name !== "sp" && name !== "cxnSp") return null;
  const spPr = kid(el, "spPr");
  const style = kid(el, "style");
  const xfrm = kid(spPr, "xfrm");
  const rect = place(xfrm);
  if (!rect) return null;
  const geom = attr(kid(spPr, "prstGeom"), "prst") ?? (kid(spPr, "custGeom") ? "custGeom" : "rect");
  const node: ShapeNode = {
    kind: "shape",
    geom,
    adj: adjustments(spPr),
    rect,
    ...placement(xfrm),
    fill: name === "cxnSp" ? { kind: "none" } : parseFill(spPr, style, ctx),
    stroke: parseStroke(spPr, style, ctx),
    text: parseText(kid(el, "txBody"), style, ctx),
  };
  if (!buildGeometry(geom, 1, 1, {}).known) unsupported[geom] = (unsupported[geom] ?? 0) + 1;
  return node;
};

export const parseDrawing = (xml: string, ctx: DrawingContext): { nodes: DrawNode[]; unsupported: Record<string, number> } => {
  const root = parseXml(xml);
  const nodes: DrawNode[] = [];
  const unsupported: Record<string, number> = {};
  for (const anchor of kids(root)) {
    const kind = anchor.localName;
    if (kind !== "twoCellAnchor" && kind !== "oneCellAnchor" && kind !== "absoluteAnchor") continue;
    const content = kids(anchor).find((c) => ["sp", "grpSp", "cxnSp", "pic", "graphicFrame"].includes(c.localName));
    if (!content) continue;

    // 1e999 などの非有限値は 0 にする。col / row は Layout 側で Excel の上限に丸める
    const intText = (el: Element | null, name: string): number => {
      const value = Number(text(kid(el, name)));
      return Number.isFinite(value) ? value : 0;
    };
    const pos = (el: Element | null) => ({
      x: ctx.layout.x(intText(el, "col")) + intText(el, "colOff") / EMU_PX,
      y: ctx.layout.y(intText(el, "row")) + intText(el, "rowOff") / EMU_PX,
    });
    let rect: Rect;
    if (kind === "twoCellAnchor") {
      const from = pos(kid(anchor, "from"));
      const to = pos(kid(anchor, "to"));
      rect = { x: from.x, y: from.y, w: Math.max(to.x - from.x, 0), h: Math.max(to.y - from.y, 0) };
    } else if (kind === "oneCellAnchor") {
      const from = pos(kid(anchor, "from"));
      rect = { x: from.x, y: from.y, w: num(kid(anchor, "ext"), "cx", 0) / EMU_PX, h: num(kid(anchor, "ext"), "cy", 0) / EMU_PX };
    } else {
      rect = { x: num(kid(anchor, "pos"), "x", 0) / EMU_PX, y: num(kid(anchor, "pos"), "y", 0) / EMU_PX, w: num(kid(anchor, "ext"), "cx", 0) / EMU_PX, h: num(kid(anchor, "ext"), "cy", 0) / EMU_PX };
    }
    const node = parseNode(content, (xfrm) => unrotatedRect(rect, xfrm), ctx, unsupported);
    if (node) nodes.push(node);
  }
  return { nodes, unsupported };
};
