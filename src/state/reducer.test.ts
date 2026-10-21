import { describe, expect, it } from "vitest";
import { type FileId, type OpenedFile, type TabId } from "../domain/types";
import { initialState, reducer } from "./reducer";

const MAIN = "main" as TabId;
const SPEC = "spec" as TabId;
const file = (name: string): OpenedFile => ({ id: name as FileId, path: `/d/${name}`, name });

describe("reducer", () => {
  it("保存済みセッションを復元し、ファイルは loading から始める", () => {
    const state = reducer(initialState, {
      type: "sessionRestored",
      tabs: [{ id: "main" as TabId, title: "main", fileIds: ["a" as FileId, "b" as FileId], activeFileId: "a" as FileId }],
      activeTabId: "main" as TabId,
      files: [file("a"), file("b")],
    });
    expect(state.tabs[0]?.activeFileId).toBe("a");
    expect(state.files["b" as FileId]?.status).toBe("loading");
  });

  it("tabs が空の復元は無視する", () => {
    expect(reducer(initialState, { type: "sessionRestored", tabs: [], activeTabId: "main" as TabId, files: [] })).toBe(initialState);
  });

  it("ファイルを開くと loading で追加され、先頭のファイルが選択される", () => {
    const state = reducer(initialState, { type: "filesOpened", files: [file("a"), file("b")] });
    expect(state.tabs[0]?.fileIds).toEqual(["a", "b"]);
    expect(state.tabs[0]?.activeFileId).toBe("a");
    expect(state.files["a" as FileId]?.status).toBe("loading");
  });

  it("select: false では表示中のファイルを維持する", () => {
    let state = reducer(initialState, { type: "filesOpened", files: [file("a")] });
    state = reducer(state, { type: "filesOpened", files: [file("b")], select: false });
    expect(state.tabs[0]?.fileIds).toEqual(["a", "b"]);
    expect(state.tabs[0]?.activeFileId).toBe("a");
  });

  it("既に開いているファイルは内容を保持し、重複して追加しない", () => {
    let state = reducer(initialState, { type: "filesOpened", files: [file("a"), file("b")] });
    state = reducer(state, { type: "fileLoaded", id: "a" as FileId, content: "# a" });
    state = reducer(state, { type: "filesOpened", files: [file("a")] });
    expect(state.tabs[0]?.fileIds).toEqual(["a", "b"]);
    expect(state.tabs[0]?.activeFileId).toBe("a");
    expect(state.files["a" as FileId]).toMatchObject({ status: "loaded", content: "# a" });
  });

  it("読み込み結果で状態が遷移する", () => {
    let state = reducer(initialState, { type: "filesOpened", files: [file("a")] });
    const id = "a" as FileId;
    state = reducer(state, { type: "fileLoaded", id, content: "x" });
    expect(state.files[id]?.status).toBe("loaded");
    state = reducer(state, { type: "fileMissing", id });
    expect(state.files[id]?.status).toBe("missing");
    state = reducer(state, { type: "fileFailed", id, message: "boom" });
    expect(state.files[id]).toMatchObject({ status: "error", message: "boom" });
    state = reducer(state, { type: "fileLoaded", id, content: "y" });
    expect(state.files[id]).toMatchObject({ status: "loaded", content: "y" });
  });

  it("未登録のファイルへの結果は無視する", () => {
    const state = reducer(initialState, { type: "fileLoaded", id: "zzz" as FileId, content: "x" });
    expect(state).toBe(initialState);
  });

  it("閉じると隣のファイルが選択され、どのタブにも属さない実体は破棄される", () => {
    let state = reducer(initialState, { type: "filesOpened", files: [file("a"), file("b"), file("c")] });
    state = reducer(state, { type: "fileSelected", id: "b" as FileId });
    state = reducer(state, { type: "fileClosed", id: "b" as FileId, tabId: MAIN });
    expect(state.tabs[0]?.fileIds).toEqual(["a", "c"]);
    expect(state.tabs[0]?.activeFileId).toBe("c");
    expect("b" in state.files).toBe(false);
    state = reducer(state, { type: "fileClosed", id: "c" as FileId, tabId: MAIN });
    state = reducer(state, { type: "fileClosed", id: "a" as FileId, tabId: MAIN });
    expect(state.tabs[0]?.activeFileId).toBeNull();
    expect(state.files).toEqual({});
  });

  describe("タブ", () => {
    it("未知のタブへ開くとタブを作り、選択を切り替える", () => {
      const state = reducer(initialState, { type: "filesOpened", files: [file("a")], tabId: SPEC });
      expect(state.tabs.map((tab) => tab.id)).toEqual(["main", "spec"]);
      expect(state.tabs[1]).toMatchObject({ title: "spec", fileIds: ["a"], activeFileId: "a" });
      expect(state.activeTabId).toBe("spec");
    });

    it("select: false ではアクティブなタブを変えず、別のタブへ追加する", () => {
      let state = reducer(initialState, { type: "tabCreated", id: SPEC });
      state = reducer(state, { type: "tabSelected", id: MAIN });
      state = reducer(state, { type: "filesOpened", files: [file("a")], tabId: SPEC, select: false });
      expect(state.activeTabId).toBe("main");
      expect(state.tabs[1]?.fileIds).toEqual(["a"]);
      expect(state.tabs[1]?.activeFileId).toBeNull();
    });

    it("同じファイルを複数のタブで開いても実体は1つで、内容を共有する", () => {
      let state = reducer(initialState, { type: "filesOpened", files: [file("a")] });
      state = reducer(state, { type: "fileLoaded", id: "a" as FileId, content: "# a" });
      state = reducer(state, { type: "filesOpened", files: [file("a")], tabId: SPEC, select: false });
      expect(Object.keys(state.files)).toEqual(["a"]);
      expect(state.files["a" as FileId]).toMatchObject({ status: "loaded", content: "# a" });
    });

    it("ファイルを閉じても他のタブが持つ間は実体を残す", () => {
      let state = reducer(initialState, { type: "filesOpened", files: [file("a")] });
      state = reducer(state, { type: "filesOpened", files: [file("a")], tabId: SPEC, select: false });
      state = reducer(state, { type: "fileClosed", id: "a" as FileId, tabId: MAIN });
      expect(state.tabs[0]?.fileIds).toEqual([]);
      expect(state.tabs[1]?.fileIds).toEqual(["a"]);
      expect("a" in state.files).toBe(true);
      state = reducer(state, { type: "fileClosed", id: "a" as FileId, tabId: SPEC });
      expect(state.files).toEqual({});
    });

    it("タブを閉じると、他のタブが持たないファイルだけ破棄し、隣のタブを選択する", () => {
      let state = reducer(initialState, { type: "filesOpened", files: [file("a"), file("shared")] });
      state = reducer(state, { type: "filesOpened", files: [file("b"), file("shared")], tabId: SPEC });
      state = reducer(state, { type: "tabClosed", id: SPEC });
      expect(state.tabs.map((tab) => tab.id)).toEqual(["main"]);
      expect(state.activeTabId).toBe("main");
      expect(Object.keys(state.files).sort()).toEqual(["a", "shared"]);
    });

    it("最後の1つのタブは閉じない", () => {
      expect(reducer(initialState, { type: "tabClosed", id: MAIN })).toBe(initialState);
    });

    it("既にあるタブの作成は、そのタブを選択するだけ", () => {
      let state = reducer(initialState, { type: "tabCreated", id: SPEC });
      state = reducer(state, { type: "tabSelected", id: MAIN });
      state = reducer(state, { type: "tabCreated", id: SPEC });
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe("spec");
    });
  });
});
