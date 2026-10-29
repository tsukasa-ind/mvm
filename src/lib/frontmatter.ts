export type SplitContent = {
  /** 先頭の YAML frontmatter ( `---` を除く本文)。なければ null */
  frontmatter: string | null;
  body: string;
};

// 先頭行が `---` で、次の `---` 行までを frontmatter の候補とする。閉じ行が無ければ frontmatter ではない
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
// YAML のマッピングのキー行 (`key:` または `key: value`)。リスト (`- `)、コメントや見出し (`#`)、URL (`http://`) は除く
const YAML_KEY_LINE = /^[^\s#:-][^:]*:(?:[ \t]|$)/;

/**
 * 先頭が水平線の文書 ( `---` の後に空行と本文が続く) を frontmatter と取り違えないよう、
 * 開始行の直後の行が `key:` 形式の場合だけ frontmatter とみなす。中身が空の場合は空の frontmatter とする。
 */
const looksLikeYaml = (inner: string): boolean => {
  if (inner === "") return true;
  const firstLine = inner.split(/\r?\n/, 1)[0] ?? "";
  return YAML_KEY_LINE.test(firstLine);
};

export const splitFrontmatter = (content: string): SplitContent => {
  const match = FRONTMATTER.exec(content);
  if (match === null) return { frontmatter: null, body: content };
  const inner = match[1] ?? "";
  if (!looksLikeYaml(inner)) return { frontmatter: null, body: content };
  return { frontmatter: inner, body: content.slice(match[0].length) };
};
