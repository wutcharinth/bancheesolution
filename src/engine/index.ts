// Pidngod tax engine. Pure functions, shared by the Worker (authoritative) and the web app (preview).
// Money is always integer satang (1 baht = 100 satang). Never use floats for stored amounts.

export type DocType = "full" | "abb" | "cash" | "etax" | "foreign";
export type DocStatus = "new" | "ready" | "confirmed" | "requested";
export type Severity = "ok" | "info" | "warn" | "block";

export interface Doc {
  id: string;
  date: string; // ISO yyyy-mm-dd (Gregorian)
  no: string;
  vendor: string;
  tin: string;
  buyerTin: string;
  vatReg: boolean;
  desc: string;
  base: number; // satang
  vat: number; // satang
  wht: number; // satang
  type: DocType;
  status: DocStatus;
  code: string | null;
  codeEdited: boolean;
}
export interface Account { code: string; name: string; keywords: string }
export interface VendorRule { code: string; n: number; src: "hist" | "edit" }
export interface ClientCtx {
  tin: string;
  capThreshold: number; // satang
  assetCode: string;
  miscCode: string;
  vatxCodes: string[];
  accounts: Account[];
  vendorRules: Record<string, VendorRule>;
}
export interface Finding { sev: Severity; text: string }
export interface Suggestion { code: string; score: number; why: string }
export interface Analysis {
  findings: Finding[];
  dupOf: string | null;
  sugg: Suggestion[];
  code: string | null;
  conf: number;
  blocks: number;
  warns: number;
  claimVat: boolean;
  vatx: boolean;
  expense: number; // satang posted to the expense / asset account
  whtForm: "" | "ภ.ง.ด.3" | "ภ.ง.ด.53" | "ภ.ง.ด.54";
  whtRate: number;
  pp36: number; // satang
  review: boolean;
}

/** Statutory values. Effective-dated in the real system (ADR-0003); verify with the RD before production. */
export const RULES = {
  vatRatePct: 7,
  inputVatWindowMonths: 6,
  whtThreshold: 100000, // 1,000 baht in satang
  foreignWhtPct: 15,
  whtRateHints: [[/ขนส่ง/, 1], [/เช่า/, 5], [/โฆษณา|advertis/i, 2]] as [RegExp, number][],
  defaultServiceWhtPct: 3,
};

export const vatOf = (baseSatang: number) => Math.round((baseSatang * RULES.vatRatePct) / 100);
export const baht = (s: number) => (s / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const toSatang = (v: string | number) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(/[,฿\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export function tinValid(t: string): boolean {
  if (!/^\d{13}$/.test(t)) return false;
  let s = 0;
  for (let i = 0; i < 12; i++) s += +t[i] * (13 - i);
  return (11 - (s % 11)) % 10 === +t[12];
}
export const withCheckDigit = (s12: string) => {
  let t = 0;
  for (let i = 0; i < 12; i++) t += +s12[i] * (13 - i);
  return s12 + ((11 - (t % 11)) % 10);
};
/** Individuals' national ID numbers are masked on screen (PDPA, ADR-0010). Juristic TINs start with 0 and stay visible. */
export const maskTin = (t: string) => (/^\d{13}$/.test(t) && t[0] !== "0" ? `${t[0]}-${t.slice(1, 5)}-xxxxx-xx-${t[12]}` : t);

export const monthsBetween = (isoDate: string, taxMonth: string) => {
  const [y, m] = isoDate.split("-").map(Number);
  const [ty, tm] = taxMonth.split("-").map(Number);
  return (ty - y) * 12 + (tm - m);
};
export const vendorKey = (v: string) => v.trim().replace(/\s+/g, " ");
export const payable = (d: Pick<Doc, "base" | "vat" | "wht" | "type">) => d.base + (d.type === "foreign" ? 0 : d.vat) - d.wht;

export function suggest(c: ClientCtx, d: Doc): Suggestion[] {
  const cand: Record<string, Suggestion> = {};
  const has = (code: string) => c.accounts.some(a => a.code === code);
  const add = (code: string, score: number, why: string) => {
    if (!has(code)) return;
    if (!cand[code] || cand[code].score < score) cand[code] = { code, score, why };
  };
  const vr = c.vendorRules[vendorKey(d.vendor)];
  if (vr) add(vr.code, Math.min(99, 86 + vr.n * 2), vr.src === "edit" ? "ผู้ทำบัญชีกำหนดไว้สำหรับผู้ขายรายนี้" : `ผู้ขายรายนี้เคยบันทึกเป็น ${vr.code} มาแล้ว ${vr.n} ครั้ง`);
  const text = `${d.desc} ${d.vendor}`.toLowerCase();
  const asset = c.accounts.find(a => a.code === c.assetCode);
  if (asset && asset.keywords && d.base >= c.capThreshold && new RegExp(asset.keywords).test(text)) {
    add(c.assetCode, 80, `ราคาเกิน ${baht(c.capThreshold)} บาทตามนโยบายบันทึกสินทรัพย์ของลูกค้า`);
  }
  for (const a of c.accounts) {
    if (!a.keywords || a.code === c.assetCode) continue;
    const hits = a.keywords.split("|").filter(k => k && text.includes(k.toLowerCase()));
    if (hits.length) add(a.code, Math.min(93, 70 + hits.length * 10 + (hits[0].length > 4 ? 6 : 0)), `พบคำว่า "${hits.join('", "')}" ในรายการ`);
  }
  add(c.miscCode, 38, "ไม่พบรูปแบบที่ชัดเจน ควรให้คนตรวจ");
  const list = Object.values(cand).sort((a, b) => b.score - a.score);
  if (list.length > 1 && list[0].score - list[1].score < 6 && list[0].score < 95) {
    list[0] = { ...list[0], score: list[0].score - 8, why: list[0].why + " · มีรหัสอื่นใกล้เคียง" };
  }
  return list;
}

export function whtFormOf(d: Pick<Doc, "type" | "tin">): Analysis["whtForm"] {
  return d.type === "foreign" ? "ภ.ง.ด.54" : d.tin && d.tin[0] === "0" ? "ภ.ง.ด.53" : "ภ.ง.ด.3";
}

/** Analyse one document in the context of its client and the client's other documents for the same tax month. */
export function analyze(c: ClientCtx, d: Doc, all: Doc[], taxMonth: string): Analysis {
  const F: Finding[] = [];
  const add = (sev: Severity, text: string) => F.push({ sev, text });
  const calc = vatOf(d.base);
  let dupOf: string | null = null;
  for (const o of all) {
    if (o.id === d.id) break;
    if (vendorKey(o.vendor) === vendorKey(d.vendor) && o.no === d.no && o.no !== "-" && o.no !== "") { dupOf = o.id; break; }
  }
  if (dupOf) add("block", "ซ้ำกับเอกสารที่บันทึกแล้ว (ผู้ขายและเลขที่เดียวกัน) ไม่บันทึกซ้ำ");
  const sugg = suggest(c, d);
  const code = d.code || (sugg[0] ? sugg[0].code : null);
  const conf = d.code ? 100 : sugg[0] ? sugg[0].score : 0;

  if (d.type === "full" || d.type === "etax") {
    if (d.type === "etax") add("ok", "e-Tax Invoice ลายมือชื่อดิจิทัลถูกต้อง");
    if (!d.tin) add("block", "ไม่มีเลขผู้เสียภาษีผู้ขาย");
    else if (!tinValid(d.tin)) add("block", "เลขผู้เสียภาษีผู้ขายผิดหลักตรวจสอบ");
    else add("ok", "เลขผู้เสียภาษีผู้ขายถูกต้อง");
    if (d.buyerTin !== c.tin) add("block", "ไม่มีหรือไม่ตรงเลขผู้เสียภาษีของผู้ซื้อ รายการไม่ครบตามมาตรา 86/4");
    if (!d.vatReg) add("block", "ผู้ขายไม่ได้จดทะเบียน VAT ใบกำกับภาษีใช้ไม่ได้");
    if (Math.abs(calc - d.vat) > 1) add("warn", `VAT ควรเป็น ${baht(calc)} แต่เอกสารระบุ ${baht(d.vat)}`);
    const mb = monthsBetween(d.date, taxMonth);
    if (mb > RULES.inputVatWindowMonths) add("block", `เกินกำหนดใช้ภาษีซื้อ ${RULES.inputVatWindowMonths} เดือน (ห่าง ${mb} เดือน)`);
  } else if (d.type === "abb") add("info", "ใบกำกับภาษีอย่างย่อ ภาษีซื้อรวมเข้าค่าใช้จ่าย");
  else if (d.type === "cash") add("info", "ไม่มี VAT · เป็นหลักฐานค่าใช้จ่าย");
  else if (d.type === "foreign") add("info", `บริการจากต่างประเทศ ต้องยื่น ภ.พ.36 นำส่ง VAT ${baht(calc)} แยกต่างหาก`);

  const vatx = (code !== null && c.vatxCodes.includes(code)) || /รถยนต์นั่ง/.test(d.desc);
  if (vatx && d.vat > 0 && (d.type === "full" || d.type === "etax")) add("info", "ภาษีซื้อต้องห้าม (มาตรา 82/5) รวมเข้าค่าใช้จ่ายให้แล้ว");

  let whtForm: Analysis["whtForm"] = "";
  let whtRate = 0;
  if (d.wht > 0) {
    whtForm = whtFormOf(d);
    whtRate = d.type === "foreign" ? RULES.foreignWhtPct : (RULES.whtRateHints.find(([re]) => re.test(d.desc)) || [null, RULES.defaultServiceWhtPct])[1];
    const expect = Math.round((d.base * whtRate) / 100);
    if (Math.abs(d.wht - expect) > 100) add("warn", `หัก ณ ที่จ่ายควรเป็น ${whtRate}% = ${baht(expect)}`);
    else add("ok", `หัก ณ ที่จ่าย ${whtRate}% ถูกต้อง · ${whtForm}`);
  } else if (d.base >= RULES.whtThreshold && /จ้าง|บริการ|ขนส่ง|เช่า|โฆษณา|ค่าแรง/.test(d.desc) && d.type !== "foreign" && !/ไฟฟ้า|ประปา|อินเทอร์เน็ต/.test(d.desc)) {
    add("warn", "รายการนี้อาจต้องหัก ณ ที่จ่าย ตรวจสอบกับลูกค้า");
  }

  const blocks = F.filter(f => f.sev === "block").length;
  const warns = F.filter(f => f.sev === "warn").length;
  const claimVat = !blocks && !vatx && d.vat > 0 && (d.type === "full" || d.type === "etax");
  const expense = d.base + (claimVat || d.type === "foreign" ? 0 : d.vat);
  const review = !dupOf && (blocks > 0 || warns > 0 || (!d.code && conf < 85));
  return { findings: F, dupOf, sugg, code, conf, blocks, warns, claimVat, vatx, expense, whtForm, whtRate, pp36: d.type === "foreign" ? calc : 0, review };
}

/** Learn from a Bookkeeper's confirmation: same code again strengthens the rule; a new code replaces it. */
export function learn(rules: Record<string, VendorRule>, vendor: string, code: string, edited: boolean): VendorRule {
  const k = vendorKey(vendor), r = rules[k];
  const next: VendorRule = { code, n: r && r.code === code ? r.n + 1 : 1, src: edited ? "edit" : r && r.code === code ? r.src : "hist" };
  rules[k] = next;
  return next;
}

/* ---------- Deadlines (Obligations) ---------- */
export type ObStatus = "waiting" | "review" | "ready" | "filed" | "paid";
export interface Obligation { form: string; due: string; moved: string; status: ObStatus }
/** Due date for tax month M is in M+1 on `day`; weekends move to the next business day. Holidays come from the Holiday Calendar (not yet wired). */
export function dueDate(taxMonth: string, day: number): { iso: string; moved: string } {
  const [y, m] = taxMonth.split("-").map(Number);
  let d = new Date(Date.UTC(y, m, day)); // month index m = next month
  let moved = "";
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    moved = moved || (d.getUTCDay() === 0 ? "อาทิตย์" : "เสาร์");
    d = new Date(d.getTime() + 864e5);
  }
  return { iso: d.toISOString().slice(0, 10), moved };
}
export function obligations(c: ClientCtx, docs: Doc[], an: Record<string, Analysis>, taxMonth: string, channel: "e" | "p", filed: Record<string, ObStatus>): Obligation[] {
  const live = docs.filter(d => !an[d.id]?.dupOf);
  const stOf = (ds: Doc[]): ObStatus => ds.some(d => d.status === "new") ? "waiting" : ds.some(d => d.status !== "confirmed" && d.status !== "requested") ? "review" : "ready";
  const out: Obligation[] = [];
  const mk = (form: string, paper: number, efile: number, ds: Doc[]) => {
    const due = dueDate(taxMonth, channel === "e" ? efile : paper);
    out.push({ form, due: due.iso, moved: due.moved, status: filed[form] || stOf(ds) });
  };
  mk("ภ.พ.30", 15, 23, live);
  for (const f of ["ภ.ง.ด.3", "ภ.ง.ด.53", "ภ.ง.ด.54"] as const) {
    const ds = live.filter(d => d.wht > 0 && whtFormOf(d) === f);
    if (ds.length) mk(f, 7, 15, ds);
  }
  const fore = live.filter(d => d.type === "foreign");
  if (fore.length) mk("ภ.พ.36", 7, 15, fore);
  return out;
}

/* ---------- Exports ---------- */
export interface Ctrl { vat: string; ap: string; wht: string }
const beSlash = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${+y + 543}`; };
const s2 = (s: number) => (s / 100).toFixed(2);
export function exportRows(format: "peak" | "jv", docs: Doc[], an: Record<string, Analysis>, accounts: Account[], ctrl: Ctrl): string[][] {
  const name = (code: string) => accounts.find(a => a.code === code)?.name || "";
  const out: string[][] = [];
  if (format === "peak") {
    out.push(["วันที่เอกสาร", "เลขที่เอกสาร", "ชื่อผู้ขาย", "เลขประจำตัวผู้เสียภาษี", "รหัสบัญชี", "ชื่อบัญชี", "รายละเอียด", "มูลค่า", "ภาษีซื้อ", "ภาษีหัก ณ ที่จ่าย", "ยอดชำระ"]);
    for (const d of docs) {
      const a = an[d.id], code = d.code || a.code || "", v = a.claimVat ? d.vat : 0;
      out.push([beSlash(d.date), d.no, d.vendor, d.tin, code, name(code), d.desc, s2(a.expense), s2(v), s2(d.wht), s2(a.expense + v - d.wht)]);
    }
  } else {
    out.push(["วันที่", "เลขที่", "รหัสบัญชี", "ชื่อบัญชี", "เดบิต", "เครดิต", "คำอธิบาย"]);
    for (const d of docs) {
      const a = an[d.id], code = d.code || a.code || "", v = a.claimVat ? d.vat : 0, dt = beSlash(d.date);
      out.push([dt, d.no, code, name(code), s2(a.expense), "", `${d.vendor} ${d.desc}`]);
      if (v) out.push([dt, d.no, ctrl.vat, "ภาษีซื้อ", s2(v), "", ""]);
      if (d.wht) out.push([dt, d.no, ctrl.wht, "ภาษีหัก ณ ที่จ่ายค้างจ่าย", "", s2(d.wht), a.whtForm]);
      out.push([dt, d.no, ctrl.ap, "เจ้าหนี้", "", s2(a.expense + v - d.wht), d.vendor]);
    }
  }
  return out;
}
export const toCsv = (rows: string[][]) => "﻿" + rows.map(r => r.map(v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");

/* ---------- Thai baht text (for 50 ทวิ) ---------- */
const DIG = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"], POS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];
function chunk(n: number, higher: boolean) {
  const s = String(n); let o = "";
  for (let i = 0; i < s.length; i++) {
    const d = +s[i], p = s.length - i - 1;
    if (!d) continue;
    if (p === 1) o += d === 1 ? "สิบ" : d === 2 ? "ยี่สิบ" : DIG[d] + "สิบ";
    else if (p === 0) o += d === 1 && (n > 9 || higher) ? "เอ็ด" : DIG[d];
    else o += DIG[d] + POS[p];
  }
  return o;
}
const thNum = (n: number): string => (n >= 1e6 ? thNum(Math.floor(n / 1e6)) + "ล้าน" + (n % 1e6 ? chunk(n % 1e6, true) : "") : chunk(n, false));
export const bahtText = (satang: number) => {
  const b = Math.floor(satang / 100), st = satang % 100;
  if (!b && !st) return "ศูนย์บาทถ้วน";
  return (b ? thNum(b) + "บาท" : "") + (st ? thNum(st) + "สตางค์" : "ถ้วน");
};

/* ---------- Table import (paste from Excel / CSV) ---------- */
const HMAP: Record<string, string[]> = {
  date: ["วันที่", "date", "วันที่เอกสาร", "doc date"], no: ["เลขที่", "invoice no", "เลขที่เอกสาร", "no", "inv", "เลขที่ใบกำกับ"],
  vendor: ["ผู้ขาย", "vendor", "supplier", "ชื่อผู้ขาย", "คู่ค้า"], tin: ["เลขผู้เสียภาษี", "tax id", "tin", "เลขประจำตัวผู้เสียภาษี"],
  desc: ["รายการ", "รายละเอียด", "description", "detail"], base: ["มูลค่า", "amount", "ยอดก่อนภาษี", "มูลค่าก่อนภาษี", "ยอดเงิน"],
  vat: ["vat", "ภาษี", "ภาษีซื้อ", "ภาษีมูลค่าเพิ่ม"], wht: ["หัก ณ ที่จ่าย", "wht", "withholding", "ภาษีหัก ณ ที่จ่าย"],
};
export function parseTable(txt: string) {
  const lines = txt.replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (!lines.length) return null;
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const split = (l: string) => {
    if (sep === "\t") return l.split("\t");
    const out: string[] = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; }
    out.push(cur); return out;
  };
  const head = split(lines[0]).map(h => h.trim().toLowerCase());
  const map: Record<string, number> = {}, used = new Set<number>(), order = ["date", "no", "vendor", "tin", "desc", "base", "wht", "vat"];
  for (const pass of [0, 1]) for (const f of order) {
    if (f in map) continue;
    const i = head.findIndex((h, j) => !used.has(j) && HMAP[f].some(s => (pass === 0 ? h === s.toLowerCase() : h.includes(s.toLowerCase()))));
    if (i >= 0) { map[f] = i; used.add(i); }
  }
  return { head, map, rows: lines.slice(1).map(split) };
}
export function toIso(s: string, fallback: string) {
  s = (s || "").trim(); let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { let y = +m[1]; if (y > 2400) y -= 543; return `${y}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`; }
  if ((m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/))) { let y = +m[3]; if (y < 100) y += 2500; if (y > 2400) y -= 543; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return fallback;
}
