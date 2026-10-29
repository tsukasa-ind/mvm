import { describe, expect, it } from "vitest";
import { builtinFormat, formatNumber, formatText } from "./numfmt";

describe("formatNumber", () => {
  it("General は有効数字を整えて表示する", () => {
    expect(formatNumber(42, "General")).toBe("42");
    expect(formatNumber(3.14159, undefined)).toBe("3.14159");
    expect(formatNumber(0.1 + 0.2, "General")).toBe("0.3");
  });

  it("桁区切り・小数桁・パーセント", () => {
    expect(formatNumber(1234.5, "#,##0")).toBe("1,235");
    expect(formatNumber(1234.5, "0.00")).toBe("1234.50");
    expect(formatNumber(1234567, "#,##0.0")).toBe("1,234,567.0");
    expect(formatNumber(0.256, "0%")).toBe("26%");
    expect(formatNumber(-5, "0")).toBe("-5");
  });

  it("引用符のリテラルと通貨記号を残す", () => {
    expect(formatNumber(1234, '"¥"#,##0')).toBe("¥1,234");
    expect(formatNumber(30, '0"円"')).toBe("30円");
  });

  it("日付 (シリアル値 45000 = 2023-03-15)", () => {
    expect(formatNumber(45000, "yyyy/m/d")).toBe("2023/3/15");
    expect(formatNumber(45000, "yyyy-mm-dd")).toBe("2023-03-15");
    expect(formatNumber(45000, 'yyyy"年"m"月"d"日"')).toBe("2023年3月15日");
  });

  it("時刻と、h の隣の m は「分」として扱う", () => {
    expect(formatNumber(0.5, "h:mm")).toBe("12:00");
    expect(formatNumber(45000.75, "yyyy/m/d h:mm")).toBe("2023/3/15 18:00");
  });
});

describe("formatNumber: 指数表記", () => {
  it("0.00E+00", () => {
    expect(formatNumber(12345.678, "0.00E+00")).toBe("1.23E+04");
    expect(formatNumber(1e-7, "0.00E+00")).toBe("1.00E-07");
    expect(formatNumber(0, "0.00E+00")).toBe("0.00E+00");
    expect(formatNumber(-12345.678, "0.00E+00")).toBe("-1.23E+04");
  });

  it("丸めで仮数が 10 になるときは指数を繰り上げる", () => {
    expect(formatNumber(9.999, "0.00E+00")).toBe("1.00E+01");
  });

  it("E- は負の指数だけ符号を付ける。##0.0E+0 は指数を 3 の倍数にする", () => {
    expect(formatNumber(12345, "0.0E-0")).toBe("1.2E4");
    expect(formatNumber(0.00123, "0.0E-0")).toBe("1.2E-3");
    expect(formatNumber(12345, "##0.0E+0")).toBe("12.3E+3");
    expect(formatNumber(1234567, "##0.0E+0")).toBe("1.2E+6");
  });
});

describe("formatNumber: セクション", () => {
  it("負のセクションでは符号を付けない", () => {
    expect(formatNumber(-1.5, "0.0;(0.0)")).toBe("(1.5)");
    expect(formatNumber(1.5, "0.0;(0.0)")).toBe("1.5");
    expect(formatNumber(-1234, "#,##0;[Red]\\-#,##0")).toBe("-1,234");
    expect(formatNumber(-1234, "#,##0;[Red]#,##0")).toBe("1,234");
  });

  it("ゼロのセクションと、書式記号のないセクション", () => {
    expect(formatNumber(0, '0;-0;"zero"')).toBe("zero");
    expect(formatNumber(5, '0;-0;"zero"')).toBe("5");
    expect(formatNumber(-5, '0;-0;"zero"')).toBe("-5");
    expect(formatNumber(0, "0;-0;")).toBe("");
  });

  it("2 セクションではゼロは第 1 セクション", () => {
    expect(formatNumber(0, '0"円";"▲"0"円"')).toBe("0円");
    expect(formatNumber(-300, '0"円";"▲"0"円"')).toBe("▲300円");
  });

  it("引用符の中の ; はセクションの区切りではない", () => {
    expect(formatNumber(3, '0" ; "0')).toBe("0 ; 3");
  });

  it("条件付きセクション", () => {
    expect(formatNumber(150, '[>100]"大"0;[<0]"負"0;0')).toBe("大150");
    expect(formatNumber(50, '[>100]"大"0;[<0]"負"0;0')).toBe("50");
    expect(formatNumber(-3, '[>100]"大"0;[<0]"負"0;0')).toBe("-負3");
    expect(formatNumber(1234567, "[<=999]000;000-0000")).toBe("123-4567");
    expect(formatNumber(12, "[<=999]000;000-0000")).toBe("012");
  });

  it("色の指定は表示に影響しない", () => {
    expect(formatNumber(-5, "[Blue]0;[Red]0")).toBe("5");
  });

  it("General をセクション内で使える", () => {
    expect(formatNumber(-2.5, 'General;"▲"General')).toBe("▲2.5");
  });
});

describe("formatNumber: 桁と記号", () => {
  it("末尾の , は 1000 で割る", () => {
    expect(formatNumber(1234, "#,##0,")).toBe("1");
    expect(formatNumber(1234567, '#,##0,"千円"')).toBe("1,235千円");
    expect(formatNumber(123456789, "0.0,,")).toBe("123.5");
  });

  it("# は不要な 0 を出さず、? は空白で桁をそろえる", () => {
    expect(formatNumber(1.5, "0.0#")).toBe("1.5");
    expect(formatNumber(1.25, "0.0#")).toBe("1.25");
    expect(formatNumber(1.5, "0.0?")).toBe("1.5 ");
    expect(formatNumber(0.5, "#.00")).toBe(".50");
    expect(formatNumber(5, "?0")).toBe(" 5");
  });

  it("書式記号の間のリテラル", () => {
    expect(formatNumber(1234567, "000-0000")).toBe("123-4567");
    expect(formatNumber(12, "000-0000")).toBe("000-0012");
  });

  it("1e21 以上でも指数表記にならない", () => {
    expect(formatNumber(1e21, "0")).toBe("1000000000000000000000");
  });

  it("分数", () => {
    expect(formatNumber(1.5, "# ?/?")).toBe("1 1/2");
    expect(formatNumber(0.75, "?/?")).toBe("3/4");
    expect(formatNumber(3.14159, "# ??/??")).toBe("3 14/99");
    expect(formatNumber(0.3, "# ?/8")).toBe("2/8");
    expect(formatNumber(1.5, "?/?")).toBe("3/2");
    expect(formatNumber(-1.5, "# ?/?")).toBe("-1 1/2");
    expect(formatNumber(2, "# ?/?")).toBe("2    ");
    expect(formatNumber(1.5, builtinFormat(12))).toBe("1 1/2");
  });

  it("会計 (41〜44) は負を - 付き、ゼロを - で表す", () => {
    expect(formatNumber(1234, builtinFormat(41))).toBe(" 1,234 ");
    expect(formatNumber(-1234, builtinFormat(41))).toBe(" -1,234 ");
    expect(formatNumber(0, builtinFormat(41))).toBe(" - ");
    expect(formatNumber(1234, builtinFormat(42))).toBe(" ¥1,234 ");
    expect(formatNumber(0, builtinFormat(44))).toBe(" ¥-   ");
  });

  it("組み込み 48 (工学表記) と 49 (@)", () => {
    expect(formatNumber(12345, builtinFormat(48))).toBe("12.3E+3");
    expect(formatNumber(3.5, builtinFormat(49))).toBe("3.5");
  });
});

describe("formatNumber: 日付と時刻", () => {
  it("1900 年の閏年バグに合わせる", () => {
    expect(formatNumber(1, "yyyy/m/d")).toBe("1900/1/1");
    expect(formatNumber(59, "yyyy/m/d")).toBe("1900/2/28");
    expect(formatNumber(60, "yyyy/m/d")).toBe("1900/2/29");
    expect(formatNumber(61, "yyyy/m/d")).toBe("1900/3/1");
    expect(formatNumber(366, "yyyy/m/d")).toBe("1900/12/31");
    expect(formatNumber(367, "yyyy/m/d")).toBe("1901/1/1");
    expect(formatNumber(0, "yyyy/m/d")).toBe("1900/1/0");
  });

  it("曜日 (aaa は日本語、ddd は英語)", () => {
    expect(formatNumber(45000, "aaa")).toBe("水");
    expect(formatNumber(45000, "aaaa")).toBe("水曜日");
    expect(formatNumber(45000, "m/d(aaa)")).toBe("3/15(水)");
    expect(formatNumber(45000, "ddd")).toBe("Wed");
    expect(formatNumber(45000, "dddd")).toBe("Wednesday");
    // Excel は 1900/1/1 (シリアル 1) を日曜として扱う
    expect(formatNumber(1, "aaa")).toBe("日");
    expect(formatNumber(61, "aaa")).toBe("木");
  });

  it("和暦", () => {
    expect(formatNumber(45000, '[$-411]ggge"年"m"月"d"日"')).toBe("令和5年3月15日");
    expect(formatNumber(45000, "[$-411]ge.m.d")).toBe("R5.3.15");
    expect(formatNumber(45000, "[$-411]gge")).toBe("令5");
    expect(formatNumber(45000, '[$-ja-JP]ggg ee"年"')).toBe("令和 05年");
    expect(formatNumber(45000, builtinFormat(28))).toBe("令和5年3月15日");
  });

  it("和暦の境界日付", () => {
    const era = (serial: number) => formatNumber(serial, '[$-411]ggge"年"m"月"d"日"');
    // 1912/7/29 = 4594、1912/7/30 = 4595
    expect(era(4594)).toBe("明治45年7月29日");
    expect(era(4595)).toBe("大正1年7月30日");
    // 1926/12/24 = 9855、1926/12/25 = 9856
    expect(era(9855)).toBe("大正15年12月24日");
    expect(era(9856)).toBe("昭和1年12月25日");
    // 1989/1/7 = 32515、1989/1/8 = 32516
    expect(era(32515)).toBe("昭和64年1月7日");
    expect(era(32516)).toBe("平成1年1月8日");
    // 2019/4/30 = 43585、2019/5/1 = 43586
    expect(era(43585)).toBe("平成31年4月30日");
    expect(era(43586)).toBe("令和1年5月1日");
    expect(formatNumber(1, "[$-411]ge.m.d")).toBe("M33.1.1");
  });

  it("経過時間 [h] [m] [s]", () => {
    expect(formatNumber(100000, "[h]:mm:ss")).toBe("2400000:00:00");
    expect(formatNumber(1.25, "[h]:mm")).toBe("30:00");
    expect(formatNumber(1.25, "[mm]:ss")).toBe("1800:00");
    expect(formatNumber(1 / 1440 + 1 / 86400, "[s]")).toBe("61");
  });

  it("秒の丸めと小数秒", () => {
    expect(formatNumber(0.5 + 0.6 / 86400, "h:mm:ss")).toBe("12:00:01");
    expect(formatNumber(1.25 / 1440, builtinFormat(47))).toBe("01:15.0");
    expect(formatNumber(1.25 / 86400, "ss.00")).toBe("01.25");
  });

  it("午前・午後", () => {
    expect(formatNumber(0.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(formatNumber(0.25, "h:mm a/p")).toBe("6:00 a");
  });

  it("日本語の組み込み日付書式", () => {
    expect(formatNumber(45000, builtinFormat(31))).toBe("2023年3月15日");
    expect(formatNumber(0.5, builtinFormat(33))).toBe("12時00分00秒");
    expect(formatNumber(45000, builtinFormat(34))).toBe("2023年3月");
    expect(formatNumber(45000, builtinFormat(35))).toBe("3月15日");
  });

  it("日付にできない値はそのまま表示する", () => {
    expect(formatNumber(-1, "yyyy/m/d")).toBe("-1");
    expect(formatNumber(Number.POSITIVE_INFINITY, "yyyy/m/d")).toBe("Infinity");
    expect(formatNumber(Number.NaN, "0.00")).toBe("NaN");
  });
});

describe("formatNumber: 未対応の書式でも例外を出さない", () => {
  it.each([
    "[DBNum1][$-411]ggge\"年\"",
    "0;0;0;0;0",
    "[>",
    "\"unterminated",
    "#,##0.00_);[Red](#,##0.00)",
    "??????/??????",
    "0E+",
    "[=1]\"one\"",
    "\\",
    "*",
    "_",
    "[h",
    "b",
  ])("%s", (code) => {
    for (const v of [0, 1.5, -1.5, 45000, 1e300]) expect(() => formatNumber(v, code)).not.toThrow();
  });
});

describe("formatText", () => {
  it("テキストのセクションがない書式では元の文字列", () => {
    expect(formatText("abc", undefined)).toBe("abc");
    expect(formatText("abc", "0.00")).toBe("abc");
    expect(formatText("abc", "@")).toBe("abc");
  });

  it("第 4 セクションや @ を含むセクションを使う", () => {
    expect(formatText("abc", '0;-0;0;"「"@"」"')).toBe("「abc」");
    expect(formatText("abc", '0;@" 様"')).toBe("abc 様");
    expect(formatText("abc", "0;-0;0;")).toBe("");
    expect(formatText("abc", builtinFormat(41))).toBe(" abc ");
  });
});
