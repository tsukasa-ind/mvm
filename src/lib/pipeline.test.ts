import type { Element, Nodes } from "hast";
import { describe, expect, it } from "vitest";
import { extractHeadings, markdownToHast } from "./pipeline";

const collect = (node: Nodes, found: Element[] = []): Element[] => {
  if (node.type === "element") found.push(node);
  if ("children" in node) for (const child of node.children) collect(child, found);
  return found;
};

const render = async (markdown: string) => collect(await markdownToHast(markdown));
const tags = (elements: Element[]) => elements.map((element) => element.tagName);

describe("markdownToHast", () => {
  it("script 要素とイベントハンドラ属性を除去する", async () => {
    const elements = await render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n<a href="javascript:alert(3)">x</a>');
    expect(tags(elements)).not.toContain("script");
    for (const element of elements) {
      expect(Object.keys(element.properties)).not.toContain("onError");
    }
    const link = elements.find((element) => element.tagName === "a");
    expect(link?.properties.href).toBeUndefined();
  });

  it("GFM の表とタスクリストを変換する", async () => {
    const elements = await render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n");
    expect(tags(elements)).toContain("table");
    expect(elements.filter((element) => element.tagName === "input")).toHaveLength(2);
  });

  it("コードブロックを Shiki でハイライトし、未知の言語でも失敗しない", async () => {
    const known = await render("```ts\nconst x = 1;\n```");
    expect(known.some((element) => element.tagName === "pre" && String(element.properties.class).includes("shiki"))).toBe(true);
    const unknown = await render("```not-a-language\nfoo\n```");
    expect(tags(unknown)).toContain("pre");
  });

  it("見出しに id を付与する", async () => {
    const elements = await render("## 下の見出し");
    expect(elements.find((element) => element.tagName === "h2")?.properties.id).toBe("下の見出し");
  });
});

describe("markdownToHast (M2)", () => {
  it("数式を KaTeX で変換する", async () => {
    const elements = await render("inline $a^2$ と\n\n$$\\int_0^1 x\\,dx$$\n");
    expect(elements.filter((element) => String(element.properties.className).includes("katex")).length).toBeGreaterThan(0);
  });

  it("GitHub Alerts を変換する", async () => {
    const elements = await render("> [!NOTE]\n> 注意書き\n");
    expect(elements.some((element) => String(element.properties.className).includes("markdown-alert"))).toBe(true);
  });

  it("Mermaid のコードブロックを描画用要素に置き換え、Shiki に渡さない", async () => {
    const elements = await render("```mermaid\ngraph TD; A-->B\n```");
    const diagram = elements.find((element) => element.tagName === "mermaid-diagram");
    expect(diagram?.properties["data-source"]).toBe("graph TD; A-->B\n");
    expect(tags(elements)).not.toContain("pre");
  });

  it("見出しを抽出する", async () => {
    const headings = extractHeadings(await markdownToHast("# 題\n\n## 節 `code`\n\n### 小節\n"));
    expect(headings).toEqual([
      { id: "題", depth: 1, text: "題" },
      { id: "節-code", depth: 2, text: "節 code" },
      { id: "小節", depth: 3, text: "小節" },
    ]);
  });

  it("同名の見出しには連番の id を付ける", async () => {
    const headings = extractHeadings(await markdownToHast("## 同じ\n\n## 同じ\n"));
    expect(headings.map((heading) => heading.id)).toEqual(["同じ", "同じ-1"]);
  });
});

describe("脚注と見出し", () => {
  it("脚注の参照先と戻り先の id が href と一致する", async () => {
    const elements = await render("a[^1]\n\n[^1]: note\n");
    const ids = new Set(elements.map((element) => element.properties.id).filter((id): id is string => typeof id === "string"));
    const hrefs = elements.map((element) => element.properties.href).filter((href): href is string => typeof href === "string" && href.startsWith("#"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(ids.has(href.slice(1))).toBe(true);
  });

  it("数式を含む見出しのテキストを重複させない", async () => {
    const tree = await markdownToHast("## Energy $E=mc^2$\n");
    expect(extractHeadings(tree)[0]?.text).toBe("Energy E=mc2");
  });
});
