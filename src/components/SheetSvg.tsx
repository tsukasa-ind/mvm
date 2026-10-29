import { type ReactNode, memo, useMemo } from "react";
import { FALLBACK_FONTS } from "../lib/xlsx/drawing";
import { buildGeometry } from "../lib/xlsx/geometry";
import type { Styles } from "../lib/xlsx/styles";
import type { DrawNode, Fill, GroupNode, LineEnd, PicNode, Rect, ShapeNode, SheetModel, Stroke, TextBody } from "../lib/xlsx/types";

const PT_PX = 96 / 72;

// ---- 矢印の端点 (マーカー) -------------------------------------------------

type MarkerSpec = { id: string; color: string; end: LineEnd };

const markerKey = (color: string, end: LineEnd) => `${color}|${end.type}|${end.w}|${end.len}`;

const collectMarkers = (nodes: DrawNode[], out: Map<string, MarkerSpec>) => {
  for (const node of nodes) {
    if (node.kind === "group") collectMarkers(node.children, out);
    if (node.kind !== "shape" || !node.stroke) continue;
    for (const end of [node.stroke.head, node.stroke.tail]) {
      if (!end) continue;
      const key = markerKey(node.stroke.color, end);
      if (!out.has(key)) out.set(key, { id: `mk${out.size}`, color: node.stroke.color, end });
    }
  }
};

const SIZE: Record<string, number> = { sm: 2, med: 3, lg: 5 };

const Marker = ({ spec, reverse }: { spec: MarkerSpec; reverse: boolean }) => {
  const { end, color } = spec;
  const w = SIZE[end.w] ?? 3;
  const len = SIZE[end.len] ?? 3;
  const shape =
    end.type === "oval" ? <ellipse cx="5" cy="5" rx="5" ry="5" fill={color} /> : end.type === "diamond" ? <polygon points="0,5 5,0 10,5 5,10" fill={color} /> : end.type === "arrow" ? <polyline points="0,0 10,5 0,10" fill="none" stroke={color} strokeWidth="1.6" /> : <polygon points="0,0 10,5 0,10" fill={color} />;
  return (
    <marker id={reverse ? `${spec.id}r` : spec.id} viewBox="0 0 10 10" refX={end.type === "oval" || end.type === "diamond" ? 5 : 10} refY="5" markerWidth={len} markerHeight={w} markerUnits="strokeWidth" orient={reverse ? "auto-start-reverse" : "auto"}>
      {shape}
    </marker>
  );
};

// ---- 変形 ------------------------------------------------------------------

const center = (r: Rect) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });
const rotate = (rot: number, r: Rect) => (rot ? `rotate(${rot} ${center(r).cx} ${center(r).cy})` : undefined);
const flip = (flipH: boolean, flipV: boolean, r: Rect) => (flipH || flipV ? `translate(${center(r).cx} ${center(r).cy}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1}) translate(${-center(r).cx} ${-center(r).cy})` : undefined);

// ---- テキスト --------------------------------------------------------------

const TextBox = ({ body, rect }: { body: TextBody; rect: Rect }) => (
  <foreignObject x={rect.x} y={rect.y} width={Math.max(rect.w, 1)} height={Math.max(rect.h, 1)} overflow="visible" style={{ pointerEvents: "none" }}>
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: body.anchor === "ctr" ? "center" : body.anchor === "b" ? "flex-end" : "flex-start",
        padding: `${body.insets.t}px ${body.insets.r}px ${body.insets.b}px ${body.insets.l}px`,
        writingMode: body.vert === "horz" ? undefined : "vertical-rl",
        textOrientation: body.vert === "vert" || body.vert === "vert270" ? "sideways" : undefined,
        transform: body.vert === "vert270" ? "rotate(180deg)" : undefined,
        whiteSpace: body.wrap ? "pre-wrap" : "pre",
        overflowWrap: "anywhere",
        lineHeight: 1.25,
      }}
    >
      {body.paragraphs.map((p, i) => (
        <div key={i} style={{ textAlign: p.align, minHeight: `${p.sizePx * 1.25}px` }}>
          {p.runs.map((r, j) =>
            r.lineBreak ? (
              <br key={j} />
            ) : (
              <span key={j} style={{ fontSize: r.sizePx, fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? "italic" : "normal", textDecoration: [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ") || undefined, color: r.color, fontFamily: r.font }}>
                {r.text}
              </span>
            ),
          )}
        </div>
      ))}
    </div>
  </foreignObject>
);

// ---- 図形 ------------------------------------------------------------------

const fillAttr = (fill: Fill, id: string): string => (fill.kind === "solid" ? fill.color : fill.kind === "gradient" ? `url(#${id})` : "none");

const ShapeView = ({ node, markers, gid }: { node: ShapeNode; markers: Map<string, MarkerSpec>; gid: string }) => {
  const { rect, fill, stroke } = node;
  const geom = useMemo(() => buildGeometry(node.geom, rect.w, rect.h, node.adj), [node.geom, rect.w, rect.h, node.adj]);
  const markerOf = (end: LineEnd | null, s: Stroke, reverse: boolean) => {
    const spec = end ? markers.get(markerKey(s.color, end)) : undefined;
    return spec ? `url(#${reverse ? `${spec.id}r` : spec.id})` : undefined;
  };
  // テキストは反転させない。図形の反転に合わせて、テキスト領域だけを鏡像の位置に置く
  const tr = geom.textRect;
  const textRect: Rect = {
    x: rect.x + (node.flipH ? rect.w - tr.r : tr.l),
    y: rect.y + (node.flipV ? rect.h - tr.b : tr.t),
    w: tr.r - tr.l,
    h: tr.b - tr.t,
  };
  const body = node.text;
  const inset = body ? { ...textRect } : textRect;
  return (
    <g transform={rotate(node.rot, rect)}>
      <g transform={flip(node.flipH, node.flipV, rect)}>
        <g transform={`translate(${rect.x} ${rect.y})`}>
          {geom.paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill={p.fill && i === 0 ? fillAttr(fill, gid) : "none"}
              stroke={p.stroke && stroke ? stroke.color : "none"}
              strokeWidth={stroke?.width}
              strokeDasharray={stroke?.dash?.join(" ")}
              strokeLinejoin="miter"
              markerStart={stroke && geom.connector ? markerOf(stroke.head, stroke, true) : undefined}
              markerEnd={stroke && geom.connector ? markerOf(stroke.tail, stroke, false) : undefined}
            />
          ))}
        </g>
      </g>
      {body && <TextBox body={body} rect={inset} />}
    </g>
  );
};

const PicView = ({ node }: { node: PicNode }) => (
  <g transform={rotate(node.rot, node.rect)}>
    <g transform={flip(node.flipH, node.flipV, node.rect)}>
      <image href={node.href} x={node.rect.x} y={node.rect.y} width={node.rect.w} height={node.rect.h} preserveAspectRatio="none" />
    </g>
  </g>
);

type Ctx = { markers: Map<string, MarkerSpec>; gradients: ReactNode[]; counter: { n: number } };

const renderNodes = (nodes: DrawNode[], ctx: Ctx): ReactNode[] =>
  nodes.map((node, i) => {
    if (node.kind === "pic") return <PicView key={i} node={node} />;
    if (node.kind === "group") {
      const g: GroupNode = node;
      return (
        <g key={i} transform={rotate(g.rot, g.rect)}>
          <g transform={flip(g.flipH, g.flipV, g.rect)}>{renderNodes(g.children, ctx)}</g>
        </g>
      );
    }
    const gid = `gr${ctx.counter.n++}`;
    if (node.fill.kind === "gradient") {
      ctx.gradients.push(
        <linearGradient key={gid} id={gid} x1="0" y1="0" x2="1" y2="0" gradientTransform={`rotate(${node.fill.angle} 0.5 0.5)`}>
          {node.fill.stops.map((s, k) => (
            <stop key={k} offset={s.pos} stopColor={s.color} />
          ))}
        </linearGradient>,
      );
    }
    return <ShapeView key={i} node={node} markers={ctx.markers} gid={gid} />;
  });

// ---- セル ------------------------------------------------------------------

const EDGE_WIDTH: Record<string, number> = { hair: 0.5, thin: 1, medium: 2, thick: 3, double: 2 };
const EDGE_DASH: Record<string, string> = { dashed: "4 2", mediumDashed: "5 3", dotted: "1 2", dashDot: "4 2 1 2", mediumDashDot: "5 3 1 3", dashDotDot: "4 2 1 2 1 2", hair: "1 1" };

const CellLayer = ({ sheet, styles }: { sheet: SheetModel; styles: Styles }) => {
  const { colX, rowY } = sheet;
  const mergeOf = new Map<string, { r2: number; c2: number }>();
  for (const m of sheet.merges) mergeOf.set(`${m.r1},${m.c1}`, { r2: m.r2, c2: m.c2 });
  // 結合範囲を全セルの Set に展開すると、A1:XFD1048576 のような範囲で描画が終わらないため、セルごとに範囲で判定する
  const isCovered = (r: number, c: number) => sheet.merges.some((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2 && (r !== m.r1 || c !== m.c1));
  const textAt = new Set(sheet.cells.filter((c) => c.text !== null).map((c) => `${c.r},${c.c}`));
  const colAt = (c: number) => colX[Math.min(c, colX.length - 1)] ?? 0;
  const rowAt = (r: number) => rowY[Math.min(r, rowY.length - 1)] ?? 0;

  const fills: ReactNode[] = [];
  const borders: ReactNode[] = [];
  const texts: ReactNode[] = [];
  sheet.cells.forEach((cell, i) => {
    // 範囲外の書式 ID は、Excel と同じく既定の書式 (0) として扱う
    const style = styles.xfs[cell.xf] ?? styles.xfs[0];
    if (!style) return;
    const merge = mergeOf.get(`${cell.r},${cell.c}`);
    const x = colAt(cell.c);
    const y = rowAt(cell.r);
    const w = colAt(merge ? merge.c2 + 1 : cell.c + 1) - x;
    const h = rowAt(merge ? merge.r2 + 1 : cell.r + 1) - y;
    if (w <= 0 || h <= 0) return;
    if (style.fill) fills.push(<rect key={i} x={x} y={y} width={w} height={h} fill={style.fill} />);
    const sides: [string, number, number, number, number][] = [["left", x, y, x, y + h], ["right", x + w, y, x + w, y + h], ["top", x, y, x + w, y], ["bottom", x, y + h, x + w, y + h]];
    for (const [side, x1, y1, x2, y2] of sides) {
      const e = style.border[side as "left"];
      if (e) borders.push(<line key={`${i}${side}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={e.color} strokeWidth={EDGE_WIDTH[e.style] ?? 1} strokeDasharray={EDGE_DASH[e.style]} />);
    }
    if (cell.text === null || isCovered(cell.r, cell.c)) return;
    const align = style.horizontal && style.horizontal !== "general" ? style.horizontal : cell.isNumber ? "right" : "left";
    // 折り返さない左寄せの文字は、右隣が空のセルの間は溢れて表示する
    let extra = 0;
    if (!style.wrap && align === "left" && !merge) {
      for (let c = cell.c + 1; c < colX.length - 1 && !textAt.has(`${cell.r},${c}`) && extra < 600; c++) extra += colAt(c + 1) - colAt(c);
    }
    texts.push(
      <foreignObject key={`t${i}`} x={x} y={y} width={w + extra} height={h} overflow="visible" style={{ pointerEvents: "none" }}>
        <div
          style={{
            boxSizing: "border-box",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: style.vertical === "center" ? "center" : style.vertical === "top" ? "flex-start" : "flex-end",
            justifyContent: align === "center" || align === "centerContinuous" ? "center" : align === "right" ? "flex-end" : "flex-start",
            padding: `0 3px 0 ${3 + style.indent * 9}px`,
            fontFamily: `"${style.font.name.replace(/"/g, "")}", ${FALLBACK_FONTS.join(", ")}`,
            fontSize: style.font.size * PT_PX,
            fontWeight: style.font.bold ? 700 : 400,
            fontStyle: style.font.italic ? "italic" : "normal",
            textDecoration: [style.font.underline && "underline", style.font.strike && "line-through"].filter(Boolean).join(" ") || undefined,
            color: style.font.color ?? "rgb(0 0 0)",
            whiteSpace: style.wrap ? "pre-wrap" : "pre",
            overflowWrap: style.wrap ? "anywhere" : undefined,
            lineHeight: 1.2,
            textAlign: align === "right" ? "right" : align === "center" ? "center" : "left",
          }}
        >
          <span>{cell.text}</span>
        </div>
      </foreignObject>,
    );
  });

  const grid: ReactNode[] = [];
  if (sheet.showGrid) {
    const right = colX[colX.length - 1] ?? 0;
    const bottom = rowY[rowY.length - 1] ?? 0;
    colX.forEach((x, i) => grid.push(<line key={`c${i}`} x1={x} y1={0} x2={x} y2={bottom} stroke="rgb(214 217 224)" strokeWidth={1} />));
    rowY.forEach((y, i) => grid.push(<line key={`r${i}`} x1={0} y1={y} x2={right} y2={y} stroke="rgb(214 217 224)" strokeWidth={1} />));
  }
  return (
    <>
      {fills}
      {grid}
      {borders}
      {texts}
    </>
  );
};

// ---- シート全体 ------------------------------------------------------------

type Props = { sheet: SheetModel; styles: Styles; scale: number };

export const SheetSvg = memo(({ sheet, styles, scale }: Props) => {
  const { markers, gradients, nodes } = useMemo(() => {
    const markers = new Map<string, MarkerSpec>();
    collectMarkers(sheet.nodes, markers);
    const gradients: ReactNode[] = [];
    const nodes = renderNodes(sheet.nodes, { markers, gradients, counter: { n: 0 } });
    return { markers, gradients, nodes };
  }, [sheet]);
  return (
    <svg width={sheet.width * scale} height={sheet.height * scale} viewBox={`0 0 ${sheet.width} ${sheet.height}`} style={{ background: "white", display: "block" }} role="img" aria-label={sheet.name}>
      <defs>
        {[...markers.values()].map((m) => (
          <g key={m.id}>
            <Marker spec={m} reverse={false} />
            <Marker spec={m} reverse />
          </g>
        ))}
        {gradients}
      </defs>
      <CellLayer sheet={sheet} styles={styles} />
      {nodes}
    </svg>
  );
});
SheetSvg.displayName = "SheetSvg";
