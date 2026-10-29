import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SheetSvg } from "../../components/SheetSvg";
import { MAX_RENDER_CELLS, MAX_RENDER_COLS, MAX_RENDER_ROWS, limitRange } from "./limit";
import type { CellData } from "./types";
import { loadWorkbook } from "./workbook";

const cell = (r: number, c: number): CellData => ({ r, c, xf: 0, text: "x", isNumber: false });

describe("limitRange", () => {
  it("上限内なら何も変えない", () => {
    const cells = [cell(0, 0), cell(9, 4)];
    const merges = [{ r1: 0, c1: 0, r2: 1, c2: 1 }];
    const result = limitRange(cells, merges, 10, 5);
    expect(result).toEqual({ cells, merges, rows: 10, cols: 5, truncated: false });
  });

  it("行数・列数を上限に収め、範囲外のセルを捨てて結合範囲を切り詰める", () => {
    const cells = [cell(0, 0), cell(1048575, 0), cell(0, 16383)];
    const merges = [
      { r1: 0, c1: 0, r2: 1048575, c2: 16383 },
      { r1: 20000, c1: 0, r2: 20001, c2: 1 },
    ];
    const result = limitRange(cells, merges, 1048576, 16384);
    expect(result.truncated).toBe(true);
    expect(result.rows).toBe(MAX_RENDER_ROWS);
    expect(result.cols).toBe(MAX_RENDER_COLS);
    expect(result.cells).toEqual([cell(0, 0)]);
    expect(result.merges).toEqual([{ r1: 0, c1: 0, r2: MAX_RENDER_ROWS - 1, c2: MAX_RENDER_COLS - 1 }]);
  });

  it("セル数が上限を超えたら、行の途中で切らずに行単位で捨てる", () => {
    const perRow = 100;
    const cells: CellData[] = [];
    for (let r = 0; r < MAX_RENDER_CELLS / perRow + 10; r++) for (let c = 0; c < perRow; c++) cells.push(cell(r, c));
    const result = limitRange(cells, [], MAX_RENDER_CELLS / perRow + 10, perRow);
    expect(result.truncated).toBe(true);
    expect(result.rows).toBe(MAX_RENDER_CELLS / perRow);
    expect(result.cells).toHaveLength(MAX_RENDER_CELLS);
  });
});

const workbookWith = (sheetXml: string): Uint8Array =>
  zipSync({
    "xl/workbook.xml": strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
  });

describe("最終セルが極端に遠いシート", () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData></worksheet>';

  it("描画の範囲を上限に収め、切り詰めたことを返す", () => {
    const sheet = loadWorkbook(workbookWith(xml)).sheet(0);
    expect(sheet.truncated).toEqual({ rows: MAX_RENDER_ROWS, cols: MAX_RENDER_COLS });
    expect(sheet.rowY).toHaveLength(MAX_RENDER_ROWS + 1);
    expect(sheet.colX).toHaveLength(MAX_RENDER_COLS + 1);
    expect(sheet.cells.map((c) => c.text)).toEqual(["a"]);
  });

  it("グリッド線は行・列ごとの line ではなく 1 本の path で描く", () => {
    const book = loadWorkbook(workbookWith(xml));
    const svg = renderToStaticMarkup(createElement(SheetSvg, { sheet: book.sheet(0), styles: book.styles, scale: 1 }));
    expect(svg.match(/<line/g) ?? []).toHaveLength(0);
    expect(svg.match(/<path/g) ?? []).toHaveLength(1);
  });

  it("小さいシートは切り詰めない", () => {
    const sheet = loadWorkbook(workbookWith('<worksheet><sheetData><row r="1"><c r="B2"><v>1</v></c></row></sheetData></worksheet>')).sheet(0);
    expect(sheet.truncated).toBeNull();
  });
});
