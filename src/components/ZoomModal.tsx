import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useRef } from "react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { type BackdropPointer, isBackdropClick } from "../lib/backdropClick";

type Props = { children: ReactNode; label: string; onClose: () => void };

/**
 * 背景のクリックで閉じるまでの猶予。余白のダブルクリック (表示のリセット) の1回目で閉じないよう、
 * 2回目のクリックが来たら取り消す
 */
const DOUBLE_CLICK_GRACE_MS = 300;

/** 画像や図を全画面で拡大・パンするモーダル。Esc または背景のクリックで閉じる。 */
export const ZoomModal = ({ children, label, onClose }: Props) => {
  // 背景は TransformComponent が全面を覆うため、target === currentTarget では判定できない。
  // パネルとボタン以外を背景とみなす
  const panelRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pointerDown = useRef<BackdropPointer | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const isBackdrop = (target: EventTarget) => target instanceof Node && !(panelRef.current?.contains(target) ?? false) && !(toolbarRef.current?.contains(target) ?? false);

  // パン操作のライブラリより先に記録するため capture で受ける
  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    pointerDown.current = { x: event.clientX, y: event.clientY, onBackdrop: event.isPrimary && event.button === 0 && isBackdrop(event.target) };
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    clearTimeout(closeTimer.current);
    // ダブルクリックの2回目以降は、表示のリセットに任せて閉じない
    if (event.detail >= 2) return;
    if (!isBackdropClick(pointerDown.current, { x: event.clientX, y: event.clientY, onBackdrop: isBackdrop(event.target) })) return;
    closeTimer.current = setTimeout(onClose, DOUBLE_CLICK_GRACE_MS);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-50 bg-black/80" onPointerDownCapture={onPointerDownCapture} onClick={onClick}>
      <TransformWrapper minScale={0.2} maxScale={20} centerOnInit doubleClick={{ mode: "reset" }}>
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <div ref={toolbarRef} className="absolute top-4 right-4 z-10 flex gap-2 text-sm" onClick={(event) => event.stopPropagation()}>
              {[
                { text: "＋", action: () => zoomIn(), label: "拡大" },
                { text: "－", action: () => zoomOut(), label: "縮小" },
                { text: "リセット", action: () => resetTransform(), label: "表示をリセット" },
                { text: "×", action: onClose, label: "閉じる" },
              ].map((button) => (
                <button key={button.label} type="button" aria-label={button.label} onClick={button.action} className="rounded bg-neutral-800 px-3 py-1.5 text-neutral-100 hover:bg-neutral-700">
                  {button.text}
                </button>
              ))}
            </div>
            <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
              <div className="zoom-content flex h-screen w-screen items-center justify-center">
                {/* 図は背景が透明で、半透明の背景越しにページが重なると線が見えなくなる。テーマ(Mermaid の配色と同じ)に合わせた不透明なパネルに載せる */}
                <div ref={panelRef} className="zoom-panel rounded bg-white p-6 dark:bg-neutral-900">
                  {children}
                </div>
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
};
