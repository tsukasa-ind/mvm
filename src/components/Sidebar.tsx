import { useEffect, useMemo, useRef, useState } from "react";
import { assertNever, type FileEntry, type FileId, type Tab, type TabId } from "../domain/types";
import { searchFiles } from "../lib/search";
import { buildTree, type TreeNode } from "../lib/tree";

type Props = {
  tab: Tab;
  /** 「別のタブへ追加」の宛先 */
  otherTabs: Tab[];
  onAddToTab: (path: string, tabId: TabId) => void;
  files: Record<FileId, FileEntry>;
  onSelect: (id: FileId) => void;
  onClose: (id: FileId) => void;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  open: boolean;
  /** 非表示の間に Ctrl+K が押されたとき、表示に切り替える */
  onRequestOpen: () => void;
};

type ViewMode = "flat" | "tree";
const VIEW_KEY = "mvm.sidebar.view";

const readViewMode = (): ViewMode => {
  try {
    return localStorage.getItem(VIEW_KEY) === "flat" ? "flat" : "tree";
  } catch {
    return "tree";
  }
};

const statusMark = (entry: FileEntry): string => {
  switch (entry.status) {
    case "loading":
      return "…";
    case "loaded":
    case "loadedBinary":
      return "";
    case "missing":
      return "削除済み";
    case "error":
      return "エラー";
    default:
      return assertNever(entry);
  }
};

type RowProps = { entry: FileEntry; active: boolean; depth: number; onSelect: () => void; onClose: () => void; onContextMenu: (event: React.MouseEvent) => void };

const FileRow = ({ entry, active, depth, onSelect, onClose, onContextMenu }: RowProps) => (
  <li className="group relative" onContextMenu={onContextMenu}>
    <button
      type="button"
      title={entry.file.path}
      onClick={onSelect}
      style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
      className={`flex w-full items-baseline gap-2 truncate py-1.5 pr-8 text-left text-sm ${
        active ? "bg-neutral-200 font-medium dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
      }`}
    >
      <span className="truncate">{entry.file.name}</span>
      <span className="shrink-0 text-xs text-neutral-500">{statusMark(entry)}</span>
    </button>
    <button
      type="button"
      aria-label={`${entry.file.name} を閉じる`}
      onClick={onClose}
      className="absolute top-1/2 right-2 hidden -translate-y-1/2 rounded px-1 text-neutral-500 hover:bg-neutral-300 group-hover:block dark:hover:bg-neutral-700"
    >
      ×
    </button>
  </li>
);

export const Sidebar = ({ tab, otherTabs, onAddToTab, files, onSelect, onClose, onOpenFiles, onOpenFolder, open, onRequestOpen }: Props) => {
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // メニューは外側のクリック、Esc、スクロールで閉じる
  useEffect(() => {
    if (menu === null) return;
    const dismiss = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onRequestOpen();
        // 非表示 (display: none) の要素にはフォーカスできないため、表示の反映後に移す
        requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onRequestOpen]);

  const entries = useMemo(() => tab.fileIds.flatMap((id) => (files[id] === undefined ? [] : [files[id]])), [tab.fileIds, files]);
  const tree = useMemo(() => buildTree(entries.map((entry) => entry.file)), [entries.map((entry) => entry.file.path).join("\n")]);
  const hits = useMemo(() => searchFiles(query, entries), [query, entries]);

  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // 保存できなくても表示には影響しない
    }
  };

  const toggleDir = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const renderRow = (id: FileId, depth: number) => {
    const entry = files[id];
    return entry === undefined ? null : (
      <FileRow
        key={id}
        entry={entry}
        active={id === tab.activeFileId}
        depth={depth}
        onSelect={() => onSelect(id)}
        onClose={() => onClose(id)}
        onContextMenu={(event) => {
          // 追加先のタブがないときは、既定のメニューを残す
          if (otherTabs.length === 0) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, path: entry.file.path });
        }}
      />
    );
  };

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.kind === "file") return renderRow(node.id, depth);
      const open = !collapsed.has(node.path);
      return (
        <li key={`dir:${node.path}`}>
          <button
            type="button"
            onClick={() => toggleDir(node.path)}
            aria-expanded={open}
            style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
            className="flex w-full items-center gap-1 truncate py-1 pr-2 text-left text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60"
          >
            <span aria-hidden className="w-3 shrink-0 text-xs">
              {open ? "▾" : "▸"}
            </span>
            <span className="truncate">{node.name}</span>
          </button>
          {open && <ul>{renderNodes(node.children, depth + 1)}</ul>}
        </li>
      );
    });

  const searching = query.trim() !== "";

  return (
    <nav aria-label="開いているファイル" className={`${open ? "flex" : "hidden"} w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900`}>
      <div className="space-y-2 border-b border-neutral-200 p-2 dark:border-neutral-800">
        <div className="flex gap-1 text-xs">
          <button type="button" onClick={onOpenFiles} className="flex-1 rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800">
            ファイルを開く
          </button>
          <button type="button" onClick={onOpenFolder} className="flex-1 rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800">
            フォルダを開く
          </button>
        </div>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="検索 (Ctrl+K)"
          aria-label="ファイル名と本文を検索"
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
        {!searching && (
          <div className="flex gap-1 text-xs" role="group" aria-label="表示形式">
            {(["tree", "flat"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => changeView(mode)}
                className={`flex-1 rounded px-2 py-0.5 ${view === mode ? "bg-neutral-300 dark:bg-neutral-700" : "hover:bg-neutral-200 dark:hover:bg-neutral-800"}`}
              >
                {mode === "tree" ? "ツリー" : "フラット"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {searching ? (
          hits.length === 0 ? (
            <p className="p-3 text-sm text-neutral-500">一致するものがありません。</p>
          ) : (
            <ul>
              {hits.map((hit) => {
                const entry = files[hit.id];
                if (entry === undefined) return null;
                return (
                  <li key={hit.id} className="border-b border-neutral-200 last:border-b-0 dark:border-neutral-800">
                    <button type="button" onClick={() => onSelect(hit.id)} title={entry.file.path} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/60">
                      <span className="block truncate font-medium">{entry.file.name}</span>
                      {hit.lines.map((line) => (
                        <span key={line.line} className="block truncate text-xs text-neutral-500">
                          {`${line.line}: ${line.text}`}
                        </span>
                      ))}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <ul>{view === "tree" ? renderNodes(tree, 0) : tab.fileIds.map((id) => renderRow(id, 0))}</ul>
        )}
      </div>
      {menu !== null && (
        <ul role="menu" style={{ left: menu.x, top: menu.y }} className="fixed z-50 min-w-40 rounded border border-neutral-300 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          {otherTabs.map((other) => (
            <li key={other.id} role="none">
              <button type="button" role="menuitem" onClick={() => onAddToTab(menu.path, other.id)} className="block w-full truncate px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800">
                {`「${other.title}」タブへ追加`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
};
