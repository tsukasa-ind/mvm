import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Workbook, loadWorkbook } from "../lib/xlsx/workbook";
import { SheetSvg } from "./SheetSvg";

type Props = { bytes: Uint8Array };

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

const useWorkbook = (bytes: Uint8Array): { workbook: Workbook | null; error: string | null } =>
  useMemo(() => {
    try {
      return { workbook: loadWorkbook(bytes), error: null };
    } catch (error) {
      return { workbook: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [bytes]);

export const XlsxView = ({ bytes }: Props) => {
  const { workbook, error } = useWorkbook(bytes);
  const firstVisible = workbook?.sheets.findIndex((s) => !s.hidden) ?? 0;
  const [index, setIndex] = useState(Math.max(firstVisible, 0));
  const [scale, setScale] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // 再読み込みでシート数が減った場合に備えて、範囲内に収める
  const current = workbook ? Math.min(index, Math.max(workbook.sheets.length - 1, 0)) : 0;

  const sheetResult = useMemo(() => {
    if (!workbook) return null;
    try {
      return { sheet: workbook.sheet(current), error: null };
    } catch (e) {
      return { sheet: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [workbook, current]);
  const sheet = sheetResult?.sheet ?? null;

  const fit = useCallback(() => {
    if (!sheet || !scroller.current) return;
    const { clientWidth } = scroller.current;
    setScale(clampScale(Math.min(clientWidth / sheet.width, 1.5)));
    scroller.current.scrollTo({ left: 0, top: 0 });
  }, [sheet]);

  // シートを切り替えたとき (初回を含む) だけ、Excel が保存している倍率で表示する。未指定なら幅に合わせる。
  // ファイルの更新による再読み込みでは、倍率とスクロール位置を保つ
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (!sheet || applied.current === current) return;
    applied.current = current;
    if (sheet.zoom != null) {
      setScale(clampScale(sheet.zoom / 100));
      scroller.current?.scrollTo({ left: 0, top: 0 });
    } else fit();
  }, [sheet, current, fit]);

  // Ctrl+ホイールで拡大縮小 (通常のホイールはスクロール)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setScale((s) => clampScale(s * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (error || !workbook) return <p className="p-8 text-red-600 dark:text-red-400">{`Excel を読み込めません: ${error ?? "不明なエラー"}`}</p>;

  const unsupported = sheet ? Object.entries(sheet.unsupported) : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-1 text-sm dark:border-neutral-800">
        <button type="button" onClick={() => setScale((s) => clampScale(s / 1.2))} className="rounded px-2 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800" aria-label="縮小">
          −
        </button>
        <span className="w-12 text-center tabular-nums text-neutral-500">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((s) => clampScale(s * 1.2))} className="rounded px-2 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800" aria-label="拡大">
          ＋
        </button>
        <button type="button" onClick={fit} className="rounded px-2 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800">
          幅に合わせる
        </button>
        <button type="button" onClick={() => setScale(1)} className="rounded px-2 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800">
          100%
        </button>
        {sheet?.truncated && (
          <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">{`大きすぎるため、先頭の ${sheet.truncated.rows.toLocaleString()} 行 × ${sheet.truncated.cols.toLocaleString()} 列だけ表示しています`}</span>
        )}
        {unsupported.length > 0 && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">{`未対応: ${unsupported.map(([k, v]) => `${k} ${v}`).join(", ")}`}</span>}
        <span className="ml-auto text-xs text-neutral-500">Ctrl+ホイールで拡大縮小、ドラッグで移動</span>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 cursor-grab overflow-auto bg-neutral-100 active:cursor-grabbing dark:bg-neutral-900"
        onPointerDown={(event) => {
          if (event.button !== 0 || !scroller.current) return;
          drag.current = { x: event.clientX, y: event.clientY, left: scroller.current.scrollLeft, top: scroller.current.scrollTop };
          scroller.current.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || !scroller.current) return;
          scroller.current.scrollLeft = d.left - (event.clientX - d.x);
          scroller.current.scrollTop = d.top - (event.clientY - d.y);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        {sheetResult?.error ? <p className="p-8 text-red-600 dark:text-red-400">{`シートを読み込めません: ${sheetResult.error}`}</p> : sheet && <SheetSvg sheet={sheet} styles={workbook.styles} scale={scale} />}
      </div>
      <div role="tablist" aria-label="シート" className="flex shrink-0 gap-1 overflow-x-auto border-t border-neutral-200 bg-neutral-50 px-2 py-1 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        {workbook.sheets.map((s, i) =>
          s.hidden ? null : (
            <button
              key={`${i}-${s.name}`}
              type="button"
              role="tab"
              aria-selected={i === current}
              onClick={() => setIndex(i)}
              className={`shrink-0 rounded px-3 py-1 ${i === current ? "bg-white font-medium shadow-sm dark:bg-neutral-700" : "text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"}`}
            >
              {s.name}
            </button>
          ),
        )}
      </div>
    </div>
  );
};
