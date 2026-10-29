import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Layout } from "./layout";
import { formatNumber } from "./numfmt";
import { loadWorkbook } from "./workbook";

describe("壊れた・悪意のある入力", () => {
  it("極端に長い小数部の書式で例外を出さない", () => {
    expect(() => formatNumber(1.5, `0.${"0".repeat(200)}`)).not.toThrow();
  });

  it("Layout は巨大な添字でも上限で止まる", () => {
    const layout = new Layout([], new Map(), 64, 20);
    expect(Number.isFinite(layout.x(2e7))).toBe(true);
    expect(layout.x(2e7)).toBe(layout.x(16384));
  });
});

const workbookWith = (sheetXml: string, extra: Record<string, string> = {}): Uint8Array =>
  zipSync({
    "xl/workbook.xml": strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    ...Object.fromEntries(Object.entries(extra).map(([path, body]) => [path, strToU8(body)])),
  });

describe("loadWorkbook のシート解析", () => {
  it("r 属性のないセルは、直前のセルの右隣に置く", () => {
    const book = loadWorkbook(
      workbookWith('<worksheet><sheetData><row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row></sheetData></worksheet>'),
    );
    const cells = book.sheet(0).cells;
    expect(cells.map((cell) => [cell.r, cell.c, cell.text])).toEqual([
      [0, 0, "a"],
      [0, 1, "b"],
    ]);
  });

  it("t=d の日付セルは NaN にせず値の文字列を表示する", () => {
    const book = loadWorkbook(workbookWith('<worksheet><sheetData><row r="1"><c r="A1" t="d"><v>2020-01-01T00:00:00</v></c></row></sheetData></worksheet>'));
    expect(book.sheet(0).cells[0]?.text).toBe("2020-01-01T00:00:00");
  });

  it("展開後のサイズが上限を超える xlsx を拒否する", () => {
    const big = new Uint8Array(70 * 1024 * 1024);
    const bytes = zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/media/x.png": big });
    expect(() => loadWorkbook(bytes)).toThrow("大きすぎます");
  });

  it("巨大な結合範囲があっても解析できる", () => {
    const book = loadWorkbook(workbookWith('<worksheet><sheetData/><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>'));
    expect(book.sheet(0).merges).toHaveLength(1);
  });
});

