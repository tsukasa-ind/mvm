import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("先頭の YAML frontmatter を分離する", () => {
    expect(splitFrontmatter("---\ntitle: A\ntags: [x]\n---\n# 本文\n")).toEqual({ frontmatter: "title: A\ntags: [x]", body: "# 本文\n" });
  });

  it("CRLF と BOM に対応する", () => {
    expect(splitFrontmatter("﻿---\r\ntitle: A\r\n---\r\n# 本文")).toEqual({ frontmatter: "title: A", body: "# 本文" });
  });

  it("閉じ行が無い、または先頭でない `---` は frontmatter として扱わない", () => {
    expect(splitFrontmatter("---\ntitle: A\n# 本文").frontmatter).toBeNull();
    expect(splitFrontmatter("# 見出し\n\n---\nx: 1\n---\n").frontmatter).toBeNull();
  });

  it("空の frontmatter と、本文のない文書を扱う", () => {
    expect(splitFrontmatter("---\n\n---\nbody")).toEqual({ frontmatter: "", body: "body" });
    expect(splitFrontmatter("---\na: 1\n---")).toEqual({ frontmatter: "a: 1", body: "" });
  });

  it("本文中の水平線は影響しない", () => {
    const text = "---\na: 1\n---\n本文\n\n---\n\n続き";
    expect(splitFrontmatter(text).body).toBe("本文\n\n---\n\n続き");
  });

  it("先頭が水平線の文書は frontmatter として扱わない", () => {
    const text = "---\n\n本文A\n\n---\n本文B\n";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it("開始行の直後が空行、または `key:` 形式でない場合は frontmatter として扱わない", () => {
    expect(splitFrontmatter("---\n\ntitle: A\n---\n本文").frontmatter).toBeNull();
    expect(splitFrontmatter("---\n本文A\n---\n本文B").frontmatter).toBeNull();
    expect(splitFrontmatter("---\n- a\n- b\n---\n本文").frontmatter).toBeNull();
    expect(splitFrontmatter("---\n# 見出し\n---\n本文").frontmatter).toBeNull();
    expect(splitFrontmatter("---\nhttps://example.com\n---\n本文").frontmatter).toBeNull();
  });

  it("YAML らしい内容なら、途中の空行や値なしのキーを含んでも frontmatter とする", () => {
    expect(splitFrontmatter("---\ntitle: A\n\ntags:\n  - x\n---\n本文")).toEqual({ frontmatter: "title: A\n\ntags:\n  - x", body: "本文" });
    expect(splitFrontmatter("---\nタイトル: 日本語のキー\n---\n本文").frontmatter).toBe("タイトル: 日本語のキー");
    expect(splitFrontmatter('---\n"quoted key": 1\n---\n本文').frontmatter).toBe('"quoted key": 1');
    expect(splitFrontmatter("---\r\ndraft:\r\n---\r\n本文")).toEqual({ frontmatter: "draft:", body: "本文" });
  });
});
