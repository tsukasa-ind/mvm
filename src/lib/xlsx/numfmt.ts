/** 組み込みの数値書式 (numFmtId)。ロケール依存の ID は日本語環境 (ja-JP) の値 */
const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
  5: '"¥"#,##0;"¥"\\-#,##0', 6: '"¥"#,##0;[Red]"¥"\\-#,##0', 7: '"¥"#,##0.00;"¥"\\-#,##0.00', 8: '"¥"#,##0.00;[Red]"¥"\\-#,##0.00',
  9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "yyyy/m/d", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy/m/d h:mm",
  27: '[$-411]ge.m.d', 28: '[$-411]ggge"年"m"月"d"日"', 29: '[$-411]ggge"年"m"月"d"日"', 30: "m/d/yy", 31: 'yyyy"年"m"月"d"日"',
  32: 'h"時"mm"分"', 33: 'h"時"mm"分"ss"秒"', 34: 'yyyy"年"m"月"', 35: 'm"月"d"日"', 36: '[$-411]ge.m.d',
  37: "#,##0;-#,##0", 38: "#,##0;[Red]-#,##0", 39: "#,##0.00;-#,##0.00", 40: "#,##0.00;[Red]-#,##0.00",
  41: '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"_ ;_ @_ ', 42: '_ "¥"* #,##0_ ;_ "¥"* \\-#,##0_ ;_ "¥"* "-"_ ;_ @_ ',
  43: '_ * #,##0.00_ ;_ * \\-#,##0.00_ ;_ * "-"??_ ;_ @_ ', 44: '_ "¥"* #,##0.00_ ;_ "¥"* \\-#,##0.00_ ;_ "¥"* "-"??_ ;_ @_ ',
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
  50: '[$-411]ge.m.d', 51: '[$-411]ggge"年"m"月"d"日"', 52: 'yyyy"年"m"月"', 53: 'm"月"d"日"', 54: '[$-411]ggge"年"m"月"d"日"',
  55: 'yyyy"年"m"月"', 56: 'm"月"d"日"', 57: '[$-411]ge.m.d', 58: '[$-411]ggge"年"m"月"d"日"',
};

export const builtinFormat = (id: number): string | undefined => BUILTIN[id];

/** 書式コードを「;」でセクションに分ける。引用符の中と \ _ * の直後の「;」は区切りではない。 */
const splitSections = (code: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (quoted) {
      cur += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if ((ch === "\\" || ch === "_" || ch === "*") && i + 1 < code.length) {
      cur += ch + code[i + 1];
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
};

/** 引用符・エスケープ・幅指定・通貨指定を同じ長さの \u0001 で塗り、書式記号だけを探せるようにする。 */
const mask = (s: string): string => s.replace(/"[^"]*"?|\\.|[_*].|\[\$[^\]]*\]/g, (m) => "\u0001".repeat(m.length));

/** 書式の断片をリテラルとして表示する文字列にする。at を渡すと @ をその文字列に置き換える。 */
const literal = (s: string, at?: string): string =>
  s.replace(/"([^"]*)"?|\\(.)|_.|\*.|\[\$([^\]-]*)[^\]]*\]|@/g, (m, q?: string, e?: string, cur?: string) => {
    if (q !== undefined) return q;
    if (e !== undefined) return e;
    if (cur !== undefined) return cur;
    if (m === "@") return at ?? "@";
    return m[0] === "_" ? " " : "";
  });

const hasAt = (section: string): boolean => mask(section).includes("@");

/** 色・条件・[DBNum1] などの未対応の角括弧を除く。経過時間 ([h] [m] [s]) と [$…] は残す。 */
const cleanSection = (s: string): string =>
  s.replace(/"[^"]*"?|\\.|\[(?!\$|[hms]+\])[^\]]*\]/gi, (m) => (m[0] === '"' || m[0] === "\\" ? m : ""));

type Cond = { op: string; n: number };

const parseCond = (section: string): Cond | null => {
  const m = /\[(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:E[+-]?\d+)?)\]/i.exec(mask(section));
  return m ? { op: m[1]!, n: Number(m[2]) } : null;
};

const testCond = ({ op, n }: Cond, v: number): boolean =>
  op === "<" ? v < n : op === "<=" ? v <= n : op === ">" ? v > n : op === ">=" ? v >= n : op === "=" ? v === n : v !== n;

/**
 * 値に使うセクションを選ぶ。正・負・ゼロ・テキストの最大 4 セクション。
 * 負のセクションを使うときは符号を書式側に任せるため、絶対値を返す。
 */
const pickSection = (value: number, code: string): { section: string; value: number } | null => {
  const all = splitSections(code);
  const numeric = all.slice(0, 3).filter((s) => !hasAt(s));
  if (numeric.length === 0) return null;
  const conds = numeric.map(parseCond);
  if (conds.some((c) => c !== null)) {
    // 条件付き (簡易対応): 条件の合う最初のセクション。条件のないセクションは「それ以外」
    for (let i = 0; i < numeric.length; i++) {
      const c = conds[i];
      if (c && testCond(c, value)) return { section: numeric[i]!, value };
    }
    const rest = numeric.findIndex((_, i) => conds[i] === null);
    return rest >= 0 ? { section: numeric[rest]!, value } : null;
  }
  if (numeric.length === 1) return { section: numeric[0]!, value };
  if (value > 0 || (value === 0 && numeric.length === 2)) return { section: numeric[0]!, value };
  if (value < 0) return { section: numeric[1]!, value: -value };
  return { section: numeric[2]!, value };
};

const isDateCode = (section: string): boolean => {
  const bare = mask(section).replace(/\u0001/g, "").replace(/general/gi, "").replace(/\[(h+|m+|s+)\]/gi, "$1");
  return /[ymdhsge]|AM\/PM|A\/P|aaa/i.test(bare) && !/[#0?]/.test(bare.replace(/s\]?\.0+/gi, "s"));
};

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** 和暦。開始日の新しい順 */
const ERAS: { from: number; y: number; names: [string, string, string] }[] = [
  { from: 20190501, y: 2019, names: ["R", "令", "令和"] },
  { from: 19890108, y: 1989, names: ["H", "平", "平成"] },
  { from: 19261225, y: 1926, names: ["S", "昭", "昭和"] },
  { from: 19120730, y: 1912, names: ["T", "大", "大正"] },
  { from: 18680908, y: 1868, names: ["M", "明", "明治"] },
];

/**
 * シリアル値の整数部 (1900 年システム) を年月日にする。
 * Excel は 1900 年を閏年として扱う (60 = 1900/2/29、0 = 1900/1/0) ので、それに合わせる。
 */
const fromSerialDay = (day: number) => {
  // 曜日も Excel と同じく 1 (1900/1/1) を日曜として数える。61 以降は実際の曜日と一致する
  const wd = (day + 6) % 7;
  if (day === 0) return { y: 1900, mo: 1, d: 0, wd };
  if (day === 60) return { y: 1900, mo: 2, d: 29, wd };
  const dt = new Date(Date.UTC(1899, 11, day < 60 ? 31 : 30) + day * 86400000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd };
};

const formatDate = (serial: number, section: string): string => {
  // 9999/12/31 を超える値と負の値は日付にできない (Excel は #### を表示する)
  if (serial < 0 || serial >= 2958466) return general(serial);
  const src = section.replace(/\[\$([^\]-]*)[^\]]*\]/g, (_m, sym: string) => (sym ? `"${sym}"` : ""));
  const ampm = /AM\/PM|A\/P/i.test(mask(src));
  // 秒の小数桁 (ss.00) まで丸める。小数桁がなければ秒単位に丸める
  const subDigits = Math.min(Math.max(0, ...[...mask(src).matchAll(/s\]?\.(0+)/gi)].map((m) => m[1]!.length)), 3);
  const unit = 10 ** subDigits;
  const total = Math.round(serial * 86400 * unit);
  const totalSec = Math.floor(total / unit);
  const sub = total % unit;
  const day = Math.floor(totalSec / 86400);
  const secOfDay = totalSec - day * 86400;
  const t = { ...fromSerialDay(day), h: Math.floor(secOfDay / 3600), mi: Math.floor(secOfDay / 60) % 60, s: secOfDay % 60 };
  const key = t.y * 10000 + t.mo * 100 + t.d;
  const era = ERAS.find((e) => key >= e.from) ?? ERAS[ERAS.length - 1]!;
  let out = "";
  let prevH = false;
  let prevS = false;
  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i);
    const quoted = /^"([^"]*)"?/.exec(rest);
    if (quoted) { out += quoted[1]; i += quoted[0].length; continue; }
    if (rest[0] === "\\") { out += rest[1] ?? ""; i += 2; continue; }
    if (rest[0] === "_") { out += " "; i += 2; continue; }
    if (rest[0] === "*") { i += 2; continue; }
    const m = /^(\[h+\]|\[m+\]|\[s+\]|AM\/PM|A\/P|yyyy|yyy|yy|y|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|aaaa|aaa|hh|h|ss|s|\.0+|ggg|gg|g|ee|e)/i.exec(rest);
    if (!m || (m[0][0] === "." && !prevS)) { out += rest[0]; i += 1; prevS = false; continue; }
    const tok = m[0];
    const low = tok.toLowerCase();
    i += tok.length;
    if (low[0] === "[") {
      // 経過時間: [h] は通算の時間、[m] は通算の分、[s] は通算の秒
      const w = low.length - 2;
      const n = low[1] === "h" ? Math.floor(totalSec / 3600) : low[1] === "m" ? Math.floor(totalSec / 60) : totalSec;
      out += pad(n, w);
    } else if (low === "yyyy" || low === "yyy") out += pad(t.y, 4);
    else if (low === "yy" || low === "y") out += pad(t.y % 100, 2);
    else if (low[0] === "e") out += pad(t.y - era.y + 1, low.length);
    else if (low[0] === "g") out += era.names[low.length - 1];
    else if (low === "mmmmm") out += MONTHS_EN[t.mo - 1]?.[0] ?? "";
    else if (low === "mmmm") out += MONTHS_EN[t.mo - 1];
    else if (low === "mmm") out += MONTHS_EN[t.mo - 1]?.slice(0, 3);
    else if (low === "mm" || low === "m") {
      // h の直後や s の直前の m は「分」
      const nextIsTime = /^[^a-z]*(s)/i.test(src.slice(i));
      if (prevH || nextIsTime) out += low === "mm" ? pad(t.mi, 2) : String(t.mi);
      else out += low === "mm" ? pad(t.mo, 2) : String(t.mo);
    } else if (low === "dddd") out += DAYS_EN[t.wd];
    else if (low === "ddd") out += DAYS_EN[t.wd]?.slice(0, 3);
    else if (low === "dd") out += pad(t.d, 2);
    else if (low === "d") out += String(t.d);
    else if (low === "aaaa") out += `${DAYS[t.wd]}曜日`;
    else if (low === "aaa") out += DAYS[t.wd];
    else if (low === "hh" || low === "h") {
      const hour = ampm ? t.h % 12 || 12 : t.h;
      out += low === "hh" ? pad(hour, 2) : String(hour);
    } else if (low === "ss") out += pad(t.s, 2);
    else if (low === "s") out += String(t.s);
    else if (low[0] === ".") out += `.${pad(sub, subDigits).slice(0, low.length - 1).padEnd(low.length - 1, "0")}`;
    else if (low === "am/pm") out += t.h < 12 ? "AM" : "PM";
    else if (low === "a/p") out += t.h < 12 ? tok[0] : tok[2];
    prevH = low === "h" || low === "hh" || low.startsWith("[h");
    prevS = low === "s" || low === "ss" || low.startsWith("[s");
  }
  return out;
};

const group = (intPart: string): string => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const isPh = (c: string) => c === "#" || c === "0" || c === "?";
const padChar = (ph: string) => (ph === "0" ? "0" : ph === "?" ? " " : "");

/** 整数部の書式を、書式記号・桁区切り・リテラルの単位に分ける。 */
const tokenize = (pat: string): string[] => pat.match(/"[^"]*"?|\\.|_.|\*.|\[\$[^\]]*\]|./g) ?? [];

/**
 * 整数の桁を書式記号に右から詰める。余った桁は左端の記号の位置に全部置く。
 * 桁が足りない位置は 0 なら「0」、? なら空白、# なら何も出さない。
 */
const fillInt = (digits: string, pat: string): string => {
  const items = tokenize(pat);
  const phCount = items.filter(isPh).length;
  const literals = items.some((it) => !isPh(it) && it !== ",");
  if (!literals && /[#0?],+[#0?]/.test(pat)) {
    // 桁区切りあり: 必要な最小桁数まで 0 で埋めてから 3 桁ごとに区切る
    const minInt = (/[0?][#0?,]*$/.exec(pat)?.[0] ?? "").replace(/[#,]/g, "").length;
    return group(digits.padStart(minInt, "0"));
  }
  let rest = digits;
  let out = "";
  let seen = 0;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it === ",") continue;
    if (!isPh(it)) { out = literal(it) + out; continue; }
    seen++;
    if (seen === phCount) { out = (rest || padChar(it)) + out; rest = ""; }
    else { out = (rest ? rest.slice(-1) : padChar(it)) + out; rest = rest.slice(0, -1); }
  }
  return out;
};

/** 小数部の末尾の 0 を、# なら削り ? なら空白にする。 */
const trimFrac = (frac: string, pat: string): string => {
  let out = frac;
  for (let k = out.length - 1; k >= 0 && out[k] === "0"; k--) {
    if (pat[k] === "#") out = out.slice(0, k);
    else if (pat[k] === "?") out = `${out.slice(0, k)} ${out.slice(k + 1)}`;
    else break;
  }
  return out;
};

/** 絶対値を小数 decimals 桁で、整数部と小数部の文字列にする。1e21 以上は toFixed が指数表記になるので BigInt を使う。 */
const splitFixed = (abs: number, decimals: number): [string, string] => {
  if (abs >= 1e21) return [BigInt(abs).toString(), "0".repeat(decimals)];
  const [i = "0", f = ""] = abs.toFixed(decimals).split(".");
  return [i, f];
};

/** 連分数で、分母が maxDen 以下の最良近似の分数を求める。 */
const approxFraction = (x: number, maxDen: number): [number, number] => {
  let [p0, q0, p1, q1] = [0, 1, 1, 0];
  let r = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(r);
    const q2 = q0 + a * q1;
    if (q2 > maxDen) break;
    [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
    if (r - a < 1e-12) break;
    r = 1 / (r - a);
  }
  // 次の収束分数の手前 (半収束分数) のほうが近いことがある
  const k = Math.floor((maxDen - q0) / q1);
  const [pa, qa] = [p0 + k * p1, q0 + k * q1];
  return qa > 0 && Math.abs(x - pa / qa) < Math.abs(x - p1 / q1) ? [pa, qa] : [p1, q1];
};

/** 分数 (# ?/?、?/8 など)。first は最初の書式記号の位置 */
const formatFraction = (v: number, section: string, masked: string, first: number): string | null => {
  const body = masked.slice(first);
  const m = /^(?:([#0?,]+)([^#0?/]+))?([#0?]+)\/([1-9]\d*|[#0?]+)/.exec(body);
  if (!m) return null;
  const [all, intPat, sepMasked, numPat = "", denPat = ""] = m;
  const abs = Math.abs(v);
  const fixedDen = /^[1-9]/.test(denPat) ? Number(denPat) : 0;
  const maxDen = 10 ** Math.min(denPat.length, 4) - 1;
  const frac = (x: number): [number, number] => (fixedDen ? [Math.round(x * fixedDen), fixedDen] : approxFraction(x, maxDen));
  let intVal = 0;
  let [n, d] = [0, 1];
  if (intPat !== undefined) {
    intVal = Math.floor(abs);
    [n, d] = frac(abs - intVal);
    if (n >= d) { intVal += 1; n = 0; }
  } else [n, d] = frac(abs);
  const prefix = literal(section.slice(0, first));
  const suffix = literal(section.slice(first + all.length));
  const sign = v < 0 && (intVal !== 0 || n !== 0) ? "-" : "";
  const fracWidth = numPat.length + 1 + denPat.length;
  const numStr = String(n).padStart(numPat.length, numPat.includes("?") ? " " : numPat.includes("0") ? "0" : "");
  const denStr = fixedDen ? String(d) : String(d).padEnd(denPat.length, denPat.includes("?") ? " " : "");
  if (intPat === undefined) return `${sign}${prefix}${numStr}/${denStr}${suffix}`;
  const sep = literal(section.slice(first + intPat.length, first + intPat.length + (sepMasked?.length ?? 0)));
  // 分数部が 0 なら整数だけ (分数の幅は空白で確保する)
  if (n === 0) return `${sign}${prefix}${intVal !== 0 ? String(intVal) : "0"}${" ".repeat(sep.length + fracWidth)}${suffix}`;
  const intStr = intVal !== 0 ? fillInt(String(intVal), intPat) : intPat.includes("0") ? "0" : "";
  return `${sign}${prefix}${intStr ? `${intStr}${sep}` : ""}${numStr}/${denStr}${suffix}`;
};

/** 指数表記 (0.00E+00、##0.0E+0)。e は E の位置 */
const formatScientific = (v: number, section: string, masked: string, first: number, e: number): string => {
  const mant = masked.slice(first, e);
  const expSign = masked[e + 1];
  const expPat = /^[#0?]*/.exec(masked.slice(e + 2))?.[0] ?? "";
  const dot = mant.indexOf(".");
  const intPat = dot >= 0 ? mant.slice(0, dot) : mant;
  const fracPat = (dot >= 0 ? mant.slice(dot + 1) : "").replace(/[^#0?]/g, "").slice(0, 30);
  const k = Math.max(intPat.replace(/[^#0?]/g, "").length, 1);
  // 整数部が # 始まりで 2 桁以上なら、指数をその桁数の倍数にする (工学表記)
  const eng = k > 1 && intPat.trimStart()[0] === "#";
  const abs = Math.abs(v);
  let exp = abs === 0 ? 0 : Math.floor(Math.log10(abs));
  exp = eng ? Math.floor(exp / k) * k : exp - (k - 1);
  let fixed = (abs / 10 ** exp).toFixed(fracPat.length);
  if (abs !== 0 && Number(fixed) >= 10 ** k) {
    exp += eng ? k : 1;
    fixed = (abs / 10 ** exp).toFixed(fracPat.length);
  }
  const [intRaw = "0", fracRaw = ""] = fixed.split(".");
  const intStr = fillInt(intRaw === "0" ? "" : intRaw, section.slice(first, first + intPat.length));
  const frac = trimFrac(fracRaw, fracPat);
  const expStr = `${exp < 0 ? "-" : expSign === "+" ? "+" : ""}${pad(Math.abs(exp), expPat.replace(/[#?]/g, "").length)}`;
  const prefix = literal(section.slice(0, first));
  const suffix = literal(section.slice(e + 2 + expPat.length));
  const sign = v < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${prefix}${intStr}${dot >= 0 ? `.${frac}` : ""}${masked[e]}${expStr}${suffix}`;
};

const formatNumeric = (value: number, section: string): string => {
  const masked = mask(section);
  const gen = masked.search(/general/i);
  if (gen >= 0) return `${literal(section.slice(0, gen))}${general(value)}${literal(section.slice(gen + 7))}`;
  const first = masked.search(/[#0?]/);
  // 書式記号のないセクション ("zero" など) はリテラルだけを表示する
  if (first < 0) return literal(section);
  const percent = (masked.match(/%/g) ?? []).length;
  // 末尾 (小数点の直前) の「,」は 1000 で割る
  let scale = 0;
  for (const m of masked.matchAll(/[#0?](,+)(?![#0?,])/g)) scale += m[1]!.length;
  const v = (value * 100 ** percent) / 1000 ** scale;
  const e = masked.slice(first).search(/[eE][+-]/);
  if (e >= 0) return formatScientific(v, section, masked, first, first + e);
  const fraction = formatFraction(v, section, masked, first);
  if (fraction !== null) return fraction;

  const last = Math.max(masked.lastIndexOf("#"), masked.lastIndexOf("0"), masked.lastIndexOf("?"));
  const dot = masked.indexOf(".", first);
  const hasDot = dot >= 0 && dot <= last + 1;
  const intEnd = hasDot ? dot : last + 1;
  const fracPat = hasDot ? masked.slice(dot + 1, last + 1).replace(/[^#0?]/g, "") : "";
  // toFixed は 100 桁までのため、極端な書式で例外を出さないよう丸める
  const decimals = Math.min(fracPat.length, 30);
  const abs = Math.abs(v);
  const [intRaw, fracRaw] = splitFixed(abs, decimals);
  const intStr = fillInt(intRaw === "0" ? "" : intRaw, section.slice(first, intEnd));
  const number = hasDot ? `${intStr}.${trimFrac(fracRaw, fracPat.slice(0, decimals))}` : intStr;
  // 数値の前後のリテラル (通貨記号・単位) を残す
  const prefix = literal(section.slice(0, first));
  const suffix = literal(section.slice(hasDot && fracPat === "" ? dot + 1 : last + 1).replace(/^,+/, ""));
  const sign = v < 0 && /[1-9]/.test(intRaw + fracRaw) ? "-" : "";
  return `${sign}${prefix}${number}${suffix}`;
};

const general = (v: number): string => {
  if (Number.isInteger(v)) return String(v);
  const s = Number(v.toPrecision(10));
  return String(s);
};

/** 数値セルを、書式コードに従って表示用の文字列にする。 */
export const formatNumber = (value: number, code: string | undefined): string => {
  if (!code || code === "General" || code === "@" || !Number.isFinite(value)) return general(value);
  const picked = pickSection(value, code);
  if (!picked) return general(value);
  const section = cleanSection(picked.section);
  if (isDateCode(section)) return formatDate(picked.value, section);
  return formatNumeric(picked.value, section);
};

/** 文字列セルを、書式のテキストセクション (第 4 セクションか @ を含むセクション) に従って表示用の文字列にする。 */
export const formatText = (text: string, code: string | undefined): string => {
  if (!code || code === "General" || code === "@") return text;
  const sections = splitSections(code);
  const section = sections[3] ?? sections.find(hasAt);
  return section === undefined ? text : literal(cleanSection(section), text);
};
