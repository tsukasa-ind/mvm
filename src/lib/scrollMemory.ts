import { type RefObject, useLayoutEffect, useRef } from "react";

/** 復元を待つ時間の上限。画像や図の読み込みで高さが増えるのを待つ */
const RESTORE_TIMEOUT_MS = 2000;
/** ユーザーが操作したら復元を打ち切るイベント */
const USER_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** 目標の位置に到達済みか。内容がまだ短く、目標まで届かない場合は false。 */
export const isRestored = (scrollTop: number, target: number, scrollHeight: number, clientHeight: number): boolean => {
  if (target === 0) return scrollTop === 0;
  const reachable = scrollHeight - clientHeight >= target;
  return reachable && Math.abs(scrollTop - target) < 1;
};

export type RestoreHandle = {
  /** 復元中か。復元中の scroll イベントは位置の保存対象にしない */
  isRestoring: () => boolean;
  /** 復元を打ち切り、監視を解除する */
  dispose: () => void;
};

/**
 * scroller のスクロール位置を target に合わせる。内容は非同期に描画され、画像や Mermaid の図で高さが後から変わるため、
 * 内容のサイズ変化のたびに再適用する。ユーザーの操作か時間切れで終わる (目標 0 は即座に終わる)。
 *
 * 目標に届いた時点では終わらない。目標より上にある Mermaid の図が後から描画されると、WebView のスクロールアンカリングが
 * scrollTop を図の高さ分ずらすため、時間切れまでは目標に戻し続ける。復元中は overflow-anchor も無効にする。
 *
 * content (App の `h-full` の div) はスクロール領域と同じ高さに固定され、内容が伸びても自身のサイズは変わらない。
 * そのため content の子要素 (Viewer が描画する実際の内容) を観測し、子の入れ替えは MutationObserver で追従する。
 */
export const restoreScroll = (scroller: HTMLElement, content: HTMLElement, target: number): RestoreHandle => {
  let restoring = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;

  const previousAnchor = scroller.style.overflowAnchor;
  const finish = () => {
    if (!restoring) return;
    restoring = false;
    scroller.style.overflowAnchor = previousAnchor;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    for (const name of USER_EVENTS) scroller.removeEventListener(name, finish);
  };

  const done = () => isRestored(scroller.scrollTop, target, scroller.scrollHeight, scroller.clientHeight);
  const apply = () => {
    if (!restoring) return;
    if (!done()) scroller.scrollTop = target;
    // 先頭が目標なら、上に伸びる内容はないのでここで終える
    if (target === 0 && done()) finish();
  };

  // 観測対象を content と現在の子要素に合わせる。外れた子は disconnect でまとめて解除する
  const observeChildren = () => {
    if (resizeObserver === undefined) return;
    resizeObserver.disconnect();
    resizeObserver.observe(content);
    for (const child of Array.from(content.children)) resizeObserver.observe(child);
  };

  scroller.style.overflowAnchor = "none";
  for (const name of USER_EVENTS) scroller.addEventListener(name, finish, { passive: true });
  resizeObserver = new ResizeObserver(apply);
  mutationObserver = new MutationObserver(() => {
    observeChildren();
    apply();
  });
  mutationObserver.observe(content, { childList: true });
  observeChildren();
  timer = setTimeout(finish, RESTORE_TIMEOUT_MS);
  apply();

  return { isRestoring: () => restoring, dispose: finish };
};

/**
 * ファイル(key)ごとにスクロール位置を覚え、ファイルを切り替えたときに復元する。
 */
export const useScrollMemory = (scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, key: string | null) => {
  const positions = useRef(new Map<string, number>());

  // 描画の確定と同じタイミングで設定する。内容の入れ替えで scrollTop が丸められる scroll イベントを、
  // 切替前のファイルの位置として保存しないため
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;

    const target = key === null ? 0 : (positions.current.get(key) ?? 0);
    // scroll イベントは非同期に届くため、復元で設定した scrollTop による scroll も isRestoring で除外できる
    const restore = restoreScroll(scroller, content, target);
    const onScroll = () => {
      // 復元中の scroll イベントは、位置の保存対象にしない
      if (!restore.isRestoring() && key !== null) positions.current.set(key, scroller.scrollTop);
    };
    scroller.addEventListener("scroll", onScroll);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      restore.dispose();
    };
  }, [scrollRef, contentRef, key]);
};
