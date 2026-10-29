import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRestored, restoreScroll } from "./scrollMemory";

describe("isRestored", () => {
  it("目標が 0 のときは先頭にあれば到達済み", () => {
    expect(isRestored(0, 0, 100, 500)).toBe(true);
    expect(isRestored(30, 0, 1000, 500)).toBe(false);
  });

  it("内容が短くて目標に届かない間は未到達", () => {
    expect(isRestored(100, 800, 600, 500)).toBe(false);
    // 内容が増えて届くようになった
    expect(isRestored(800, 800, 1500, 500)).toBe(true);
  });

  it("端数の誤差(1px 未満)は到達済みとみなす", () => {
    expect(isRestored(799.6, 800, 2000, 500)).toBe(true);
    expect(isRestored(798, 800, 2000, 500)).toBe(false);
  });
});

// テスト環境は node のため、restoreScroll が使う DOM の最小限を偽物で用意する
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<unknown>();
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown) {
    this.observed.add(target);
  }
  disconnect() {
    this.observed.clear();
  }
  /** target のサイズが変わったことを通知する (観測中の要素だけ) */
  resize(target: unknown) {
    if (this.observed.has(target)) this.callback();
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  connected = false;
  constructor(readonly callback: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

const fakeScroller = (clientHeight: number) => {
  const listeners = new Map<string, Set<() => void>>();
  let scrollHeight = clientHeight;
  let scrollTop = 0;
  return {
    clientHeight,
    style: { overflowAnchor: "" },
    get scrollHeight() {
      return scrollHeight;
    },
    set scrollHeight(value: number) {
      scrollHeight = value;
    },
    get scrollTop() {
      return scrollTop;
    },
    // ブラウザと同じく、スクロール可能な範囲に丸める
    set scrollTop(value: number) {
      scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
    },
    addEventListener(name: string, listener: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(listener);
    },
    removeEventListener(name: string, listener: () => void) {
      listeners.get(name)?.delete(listener);
    },
    dispatch(name: string) {
      for (const listener of listeners.get(name) ?? []) listener();
    },
    /** 目標より上の内容が伸びた。WebView のスクロールアンカリングを真似て、伸びた分だけ scrollTop もずらす */
    growAbove(delta: number) {
      scrollHeight += delta;
      scrollTop += delta;
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
};

const setup = (target: number) => {
  const scroller = fakeScroller(500);
  const content = { children: [] as object[] };
  const handle = restoreScroll(scroller as unknown as HTMLElement, content as unknown as HTMLElement, target);
  const resize = FakeResizeObserver.instances.at(-1);
  const mutation = FakeMutationObserver.instances.at(-1);
  if (resize === undefined || mutation === undefined) throw new Error("observer が作られていない");
  return { scroller, content, handle, resize, mutation };
};

describe("restoreScroll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    FakeResizeObserver.instances = [];
    FakeMutationObserver.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("後から描画された子要素の高さが増えたら、目標の位置まで再適用する", () => {
    const { scroller, content, handle, resize, mutation } = setup(800);
    expect(handle.isRestoring()).toBe(true);
    expect(scroller.scrollTop).toBe(0);

    // Viewer が内容を描画した (content の子が入れ替わる)。content 自身の高さは固定のまま
    const article = {};
    content.children = [article];
    scroller.scrollHeight = 900;
    mutation.callback();
    expect(resize.observed.has(article)).toBe(true);
    expect(handle.isRestoring()).toBe(true);

    // 画像の読み込みで子要素だけが伸びる
    scroller.scrollHeight = 3000;
    resize.resize(article);
    expect(scroller.scrollTop).toBe(800);
    // 到達しても、上の図が後から描画される可能性があるので時間切れまで続ける
    expect(handle.isRestoring()).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(handle.isRestoring()).toBe(false);
    // 終わったら監視とイベントを解除する
    expect(resize.observed.size).toBe(0);
    expect(mutation.connected).toBe(false);
    expect(scroller.listenerCount()).toBe(0);
  });

  it("到達後に上の図が描画され、アンカリングで位置がずれたら目標に戻す", () => {
    const { scroller, content, handle, resize, mutation } = setup(800);
    const article = {};
    content.children = [article];
    scroller.scrollHeight = 3000; // 図は「描画中…」のまま、内容は目標に届く長さ
    mutation.callback();
    expect(scroller.scrollTop).toBe(800);

    // Mermaid の図が描画されて 400px 伸び、アンカリングで scrollTop が 1200 にずれる
    scroller.growAbove(400);
    expect(scroller.scrollTop).toBe(1200);
    resize.resize(article);
    expect(scroller.scrollTop).toBe(800);
    expect(handle.isRestoring()).toBe(true);
  });

  it("復元中は overflow-anchor を無効にし、終わったら元に戻す", () => {
    const { scroller, handle } = setup(800);
    expect(scroller.style.overflowAnchor).toBe("none");
    handle.dispose();
    expect(scroller.style.overflowAnchor).toBe("");
  });

  it("入れ替わって外れた子要素は観測しない", () => {
    const { content, resize, mutation } = setup(800);
    const pending = {};
    content.children = [pending];
    mutation.callback();
    const ready = {};
    content.children = [ready];
    mutation.callback();
    expect(resize.observed.has(pending)).toBe(false);
    expect(resize.observed.has(ready)).toBe(true);
    expect(resize.observed.has(content)).toBe(true);
  });

  it("ユーザーが操作したら復元を打ち切る", () => {
    const { scroller, content, handle, resize } = setup(800);
    scroller.dispatch("wheel");
    expect(handle.isRestoring()).toBe(false);
    content.children = [{}];
    scroller.scrollHeight = 3000;
    resize.callback();
    expect(scroller.scrollTop).toBe(0);
  });

  it("目標に届かないまま時間切れになったら打ち切る", () => {
    const { handle, mutation } = setup(800);
    vi.advanceTimersByTime(2000);
    expect(handle.isRestoring()).toBe(false);
    expect(mutation.connected).toBe(false);
  });

  it("目標が 0 で先頭にあれば、すぐに終わる", () => {
    const { handle, scroller } = setup(0);
    expect(handle.isRestoring()).toBe(false);
    expect(scroller.listenerCount()).toBe(0);
  });
});
