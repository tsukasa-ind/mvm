import { describe, expect, it } from "vitest";
import { dirname, isRelativeReference, splitFragment } from "./path";

describe("dirname", () => {
  it("両方の区切りに対応する", () => {
    expect(dirname("/home/u/a.md")).toBe("/home/u");
    expect(dirname("C:\\u\\a.md")).toBe("C:\\u");
    expect(dirname("/a.md")).toBe("/");
  });
});

describe("isRelativeReference", () => {
  it.each([
    ["a.png", true],
    ["./a.png", true],
    ["../a.png", true],
    ["https://example.com/a.png", false],
    ["data:image/png;base64,xx", false],
    ["mailto:a@example.com", false],
    ["#section", false],
    ["/abs/a.png", false],
    ["//cdn.example.com/a.png", false],
  ])("%s -> %s", (reference, expected) => {
    expect(isRelativeReference(reference)).toBe(expected);
  });
});

describe("splitFragment", () => {
  it("フラグメントを分離する", () => {
    expect(splitFragment("a.md#intro")).toEqual({ path: "a.md", fragment: "#intro" });
    expect(splitFragment("a.md")).toEqual({ path: "a.md", fragment: "" });
  });
});
