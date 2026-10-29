/** 組み込みの数値書式 (numFmtId) */
const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  14: "yyyy/m/d", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy/m/d h:mm",
  37: "#,##0;-#,##0", 38: "#,##0;-#,##0", 39: "#,##0.00;-#,##0.00", 40: "#,##0.00;-#,##0.00", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0",
};

export const builtinFormat = (id: number): string | undefined => BUILTIN[id];

/** 書式コードの先頭セクションから、引用符・色・条件・ロケールの指定を除いたトークン列にする。 */
const stripSection = (code: string): string => {
  const first = code.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0] ?? code;
  return first.replace(/\[(?:Red|Black|Blue|Green|Yellow|White|Cyan|Magenta|Color\d+)\]/gi, "").replace(/\[[<>=][^\]]*\]/g, "");
};

const isDateCode = (code: string): boolean => {
  const bare = stripSection(code).replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[\$[^\]]*\]/g, "").replace(/\[(h+|m+|s+)\]/gi, "$1");
  return /[ymdhs]|AM\/PM/i.test(bare) && !/^[#0?,.%E+\-() ]*$/i.test(bare);
};

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** シリアル値 (1900 年システム) を UTC の日時要素にする。 */
const fromSerial = (serial: number) => {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() };
};

const formatDate = (serial: number, code: string): string => {
  const t = fromSerial(serial);
  const src = stripSection(code).replace(/\[\$[^\]-]*(?:-[0-9A-Fa-f]+)?\]/g, "").replace(/\[(h+|m+|s+)\]/gi, "$1");
  const ampm = /AM\/PM|A\/P/i.test(src);
  let out = "";
  let prevH = false;
  for (let i = 0; i < src.length; ) {
    const rest = src.slice(i);
    const quoted = /^"([^"]*)"/.exec(rest);
    if (quoted) { out += quoted[1]; i += quoted[0].length; continue; }
    if (rest[0] === "\\" || rest[0] === "_") { out += rest[1] ?? ""; i += 2; continue; }
    const m = /^(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|ggg|gg|g|e+)/i.exec(rest);
    if (!m) { out += rest[0]; i += 1; continue; }
    const tok = m[0];
    const low = tok.toLowerCase();
    i += tok.length;
    if (low === "yyyy") out += pad(t.y, 4);
    else if (low === "yy") out += pad(t.y % 100, 2);
    else if (low[0] === "e") out += String(t.y);
    else if (low[0] === "g") out += "";
    else if (low === "mmmm") out += MONTHS_EN[t.mo - 1];
    else if (low === "mmm") out += MONTHS_EN[t.mo - 1]?.slice(0, 3);
    else if (low === "mm" || low === "m") {
      // h や s の隣の m は「分」
      const nextIsTime = /^[^a-z]*(s)/i.test(src.slice(i));
      if (prevH || nextIsTime) out += low === "mm" ? pad(t.mi, 2) : String(t.mi);
      else out += low === "mm" ? pad(t.mo, 2) : String(t.mo);
    } else if (low === "dddd") out += `${DAYS[t.wd]}曜日`;
    else if (low === "ddd") out += `${DAYS[t.wd]}`;
    else if (low === "dd") out += pad(t.d, 2);
    else if (low === "d") out += String(t.d);
    else if (low === "hh" || low === "h") {
      const hour = ampm ? t.h % 12 || 12 : t.h;
      out += low === "hh" ? pad(hour, 2) : String(hour);
    } else if (low === "ss") out += pad(t.s, 2);
    else if (low === "s") out += String(t.s);
    else if (low === "am/pm" || low === "a/p") out += t.h < 12 ? "AM" : "PM";
    prevH = low === "h" || low === "hh";
    if (!prevH && low !== "mm" && low !== "m" && low !== ":") prevH = false;
  }
  return out;
};

const group = (intPart: string): string => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const formatNumeric = (value: number, code: string): string => {
  const section = stripSection(code);
  const percent = /%/.test(section.replace(/"[^"]*"/g, ""));
  const v = percent ? value * 100 : value;
  const body = section.replace(/"[^"]*"/g, (q) => `\u0000${q.slice(1, -1)}\u0000`);
  const decimalMatch = /\.([0#?]+)/.exec(body.replace(/\u0000[^\u0000]*\u0000/g, ""));
  // toFixed は 100 桁までのため、極端な書式で例外を出さないよう丸める
  const decimals = decimalMatch ? Math.min(decimalMatch[1]!.length, 30) : 0;
  const thousands = /[#0?],[#0?]/.test(body) || /[#0?],$/.test(body.split(".")[0] ?? "");
  const minInt = (/([0?]+)(?:\.|$|[^0#?])/.exec(body.split(".")[0]!.replace(/\u0000[^\u0000]*\u0000/g, "")) ?? [])[1]?.length ?? 0;
  const abs = Math.abs(v);
  const fixed = abs.toFixed(decimals);
  const [intRaw = "0", frac = ""] = fixed.split(".");
  let intPart = intRaw.length < minInt ? intRaw.padStart(minInt, "0") : intRaw;
  if (minInt === 0 && intRaw === "0" && decimals > 0) intPart = "";
  if (thousands) intPart = group(intPart);
  const number = decimals > 0 ? `${intPart || "0"}.${frac}` : intPart || (minInt === 0 && abs === 0 ? "" : "0");
  // 数値の前後のリテラル (通貨記号・単位) を残す
  const literal = (s: string) => s.replace(/\u0000([^\u0000]*)\u0000/g, "$1").replace(/\\(.)/g, "$1").replace(/_./g, " ").replace(/\*./g, "").replace(/\[\$([^\]-]*)(?:-[0-9A-Fa-f]+)?\]/g, "$1");
  const firstDigit = body.search(/[#0?]/);
  const lastDigit = Math.max(body.lastIndexOf("#"), body.lastIndexOf("0"), body.lastIndexOf("?"));
  const prefix = firstDigit > 0 ? literal(body.slice(0, firstDigit)) : "";
  const suffix = lastDigit >= 0 ? literal(body.slice(lastDigit + 1).replace(/^[.,#0?]*/, "")) : "";
  const sign = v < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${prefix}${number}${percent && !suffix.includes("%") ? "%" : ""}${suffix}`;
};

const general = (v: number): string => {
  if (Number.isInteger(v)) return String(v);
  const s = Number(v.toPrecision(10));
  return String(s);
};

/** 数値セルを、書式コードに従って表示用の文字列にする。 */
export const formatNumber = (value: number, code: string | undefined): string => {
  if (!code || code === "General" || code === "@") return general(value);
  if (isDateCode(code)) return formatDate(value, code);
  return formatNumeric(value, code);
};
