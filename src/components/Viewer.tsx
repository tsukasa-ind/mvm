import { Suspense, lazy, useMemo } from "react";
import { assertNever, type FileEntry, type FileId } from "../domain/types";
import { splitFrontmatter } from "../lib/frontmatter";
import { MarkdownBody } from "../lib/markdown";
import { dirname } from "../lib/path";
import { FONT_SIZES, RAW_FONT_SIZES, type Settings, WIDTH_CLASS } from "../lib/settings";
import { useMarkdownTree } from "../lib/useMarkdownTree";
import { ARTICLE_ID } from "./DocumentToolbar";
import { TocPanel } from "./TocPanel";
// Excel の解析・描画は、xlsx を開くときだけ読み込む
const XlsxView = lazy(async () => ({ default: (await import("./XlsxView")).XlsxView }));

type Props = {
  entry: FileEntry | null;
  settings: Settings;
  raw: boolean;
  onOpenRelative: (baseDir: string, path: string) => void;
};

const Message = ({ children }: { children: string }) => <p className="p-8 text-neutral-500">{children}</p>;

type DocumentProps = { content: string; fileId: FileId; settings: Settings; onOpenRelative: (path: string) => void };

const LoadedDocument = ({ content, fileId, settings, onOpenRelative }: DocumentProps) => {
  // frontmatter は本文と別に折りたたみ表示し、Markdown の変換対象から外す
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content), [content]);
  const rendered = useMarkdownTree(body);
  switch (rendered.status) {
    case "pending":
      return null;
    case "failed":
      return <Message>{`Markdown を変換できません: ${rendered.message}`}</Message>;
    case "ready":
      return (
        <div className="mx-auto flex max-w-7xl justify-center gap-6 px-8 py-6">
          <div className={`min-w-0 flex-1 ${WIDTH_CLASS[settings.width]}`}>
            {frontmatter !== null && (
              <details className="mb-6 rounded border border-neutral-200 text-sm dark:border-neutral-800">
                <summary className="cursor-pointer px-3 py-1.5 text-neutral-500">frontmatter</summary>
                <pre className="overflow-x-auto border-t border-neutral-200 p-3 dark:border-neutral-800">{frontmatter}</pre>
              </details>
            )}
            <article id={ARTICLE_ID} className={`prose ${FONT_SIZES[settings.fontSize]} prose-neutral dark:prose-invert max-w-none`}>
              <MarkdownBody tree={rendered.tree} fileId={fileId} onOpenRelative={onOpenRelative} />
            </article>
          </div>
          <TocPanel headings={rendered.headings} />
        </div>
      );
  }
};

export const Viewer = ({ entry, settings, raw, onOpenRelative }: Props) => {
  if (entry === null) {
    return <Message>ファイルが開かれていません。`mvm file.md` で起動するか、ファイルをドロップしてください。</Message>;
  }
  switch (entry.status) {
    case "loading":
      return <Message>読み込み中…</Message>;
    case "missing":
      return <Message>{`${entry.file.path} は存在しません。`}</Message>;
    case "error":
      return <Message>{`${entry.file.path} を読み込めません: ${entry.message}`}</Message>;
    case "loadedBinary":
      return (
        <Suspense fallback={<Message>Excel を読み込み中…</Message>}>
          <XlsxView bytes={entry.bytes} />
        </Suspense>
      );
    case "loaded": {
      if (raw) {
        return (
          <pre data-testid="raw-view" className={`mx-auto whitespace-pre-wrap break-words px-8 py-6 font-mono ${RAW_FONT_SIZES[settings.fontSize]} ${WIDTH_CLASS[settings.width]}`}>
            {entry.content}
          </pre>
        );
      }
      const baseDir = dirname(entry.file.path);
      return <LoadedDocument key={entry.file.id} content={entry.content} fileId={entry.file.id} settings={settings} onOpenRelative={(path) => onOpenRelative(baseDir, path)} />;
    }
    default:
      return assertNever(entry);
  }
};
