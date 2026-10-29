import rehypeShiki from "@shikijs/rehype";
import type { Element, Nodes, Root as HastRoot } from "hast";
import { rehypeGithubAlerts } from "rehype-github-alerts";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Heading } from "../domain/types";

/** Mermaid のコードブロックを描画用のカスタム要素に置き換える (Shiki より前に実行する)。 */
const MERMAID_TAG = "mermaid-diagram";

const textOf = (node: Nodes): string => {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
};

/** 数式は KaTeX が MathML と HTML の両方を出力するため、MathML 側を除いてテキストを重複させない */
const headingText = (node: Nodes): string => {
  if (node.type === "text") return node.value;
  if (node.type === "element" && classNames(node).includes("katex-mathml")) return "";
  return "children" in node ? node.children.map(headingText).join("") : "";
};

const classNames = (element: Element): string[] => {
  const value = element.properties.className ?? element.properties.class;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/) : [];
};

const replaceMermaid = (node: Nodes) => {
  if (!("children" in node)) return;
  node.children = node.children.map((child) => {
    if (child.type !== "element") return child;
    const code = child.children.find((grandchild): grandchild is Element => grandchild.type === "element" && grandchild.tagName === "code");
    if (child.tagName === "pre" && code !== undefined && classNames(code).includes("language-mermaid")) {
      return { type: "element", tagName: MERMAID_TAG, properties: { "data-source": textOf(code) }, children: [] } satisfies Element;
    }
    replaceMermaid(child);
    return child;
  });
};

const rehypeMermaid = () => (tree: HastRoot) => replaceMermaid(tree);

// 脚注のリンク先 (user-content-fn-1) は remark-rehype が接頭辞付きで生成するため、
// sanitize がさらに接頭辞を付けると参照と id が一致しなくなる。見出しの id (rehype-slug) も接頭辞なしなので揃える。
const sanitizeSchema = { ...defaultSchema, clobberPrefix: "" };

// @shikijs/rehype は非同期プラグインのため、同期の react-markdown ではなく run() で変換する。
// 生 HTML を通すため sanitize は必須。数式・アラート・Mermaid・Shiki の出力 (style 属性や svg) は
// sanitize で除去されるため、すべて sanitize の後段に置く。
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeSlug)
  .use(rehypeKatex, { maxSize: 50, maxExpand: 200 })
  .use(rehypeGithubAlerts, {})
  .use(rehypeMermaid)
  .use(rehypeShiki, { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false, fallbackLanguage: "text" });

export const markdownToHast = async (content: string): Promise<HastRoot> => {
  const tree = await processor.run(processor.parse(content));
  return tree as HastRoot;
};

const HEADING_TAGS = /^h([1-6])$/;

export const extractHeadings = (tree: Nodes): Heading[] => {
  const headings: Heading[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element") {
      const match = HEADING_TAGS.exec(node.tagName);
      const id = node.properties.id;
      if (match !== null && typeof id === "string") {
        headings.push({ id, depth: Number(match[1]), text: headingText(node).trim() });
        return;
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return headings;
};

export { MERMAID_TAG };
