import type { Tab, TabId } from "../domain/types";

type Props = {
  tabs: Tab[];
  activeTabId: TabId;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
};

/** タブが1つだけのときは表示しない (追加はヘッダーのボタン) */
export const TabBar = ({ tabs, activeTabId, onSelect, onClose }: Props) => {
  if (tabs.length <= 1) return null;
  return (
    <div role="tablist" aria-label="タブ" className="flex overflow-x-auto border-b border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div key={tab.id} className={`group flex shrink-0 items-center border-r border-neutral-200 dark:border-neutral-800 ${active ? "bg-white dark:bg-neutral-950" : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60"}`}>
            <button type="button" role="tab" aria-selected={active} onClick={() => onSelect(tab.id)} title={tab.title} className={`max-w-48 truncate py-1.5 pr-1 pl-3 ${active ? "font-medium" : "text-neutral-600 dark:text-neutral-400"}`}>
              {tab.title}
            </button>
            <button type="button" aria-label={`${tab.title} を閉じる`} onClick={() => onClose(tab.id)} className="mr-1 rounded px-1 text-neutral-500 hover:bg-neutral-300 dark:hover:bg-neutral-700">
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
};
