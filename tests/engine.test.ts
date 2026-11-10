import { describe, expect, it } from "vitest";
import { analyze, bahtText, dueDate, exportRows, learn, maskTin, parseTable, suggest, tinValid, toIso, toSatang, vatOf, withCheckDigit, type ClientCtx, type Doc } from "../src/engine";

const CLIENT_TIN = withCheckDigit("099999900002");
const ctx = (): ClientCtx => ({
  tin: CLIENT_TIN, capThreshold: toSatang(10000), assetCode: "1250", miscCode: "5990", vatxCodes: ["5340"],
  accounts: [
    { code: "1250", name: "เครื่องมือและอุปกรณ์", keywords: "เครื่อง|อุปกรณ์" },
    { code: "5130", name: "วัสดุสิ้นเปลือง", keywords: "กระดาษ|หมึก" },
    { code: "5210", name: "ค่าขนส่ง", keywords: "ขนส่ง" },
    { code: "5310", name: "ค่าเช่า", keywords: "เช่า" },
    { code: "5340", name: "ค่ารับรอง", keywords: "รับรอง|เลี้ยง" },
    { code: "5990", name: "ค่าใช้จ่ายเบ็ดเตล็ด", keywords: "" },
  ],
  vendorRules: {},
});
let n = 0;
const doc = (o: Partial<Doc>): Doc => ({
  id: "d" + ++n, date: "2026-10-15", no: "INV-" + n, vendor: "บจ. ทดสอบ", tin: withCheckDigit("099999900012"), buyerTin: CLIENT_TIN, vatReg: true,
  desc: "กระดาษ A4", base: toSatang(1000), vat: toSatang(70), wht: 0, type: "full", status: "ready", code: null, codeEdited: false, ...o,
});
const TM = "2026-10";

describe("identifiers and money", () => {
  it("validates the TIN check digit", () => {
    expect(tinValid(withCheckDigit("010555601234"))).toBe(true);
    expect(tinValid("0105556012340")).toBe(false);
    expect(tinValid("12345")).toBe(false);
  });
  it("masks individuals' IDs but not juristic TINs", () => {
    expect(maskTin("1234567890121")).toBe("1-2345-xxxxx-xx-1");
    expect(maskTin("0999999000012")).toBe("0999999000012");
  });
  it("computes VAT in satang without float drift", () => {
    expect(vatOf(toSatang(186.92))).toBe(1308);
    expect(toSatang("1,234.56")).toBe(123456);
  });
  it("writes baht text", () => {
    expect(bahtText(toSatang(185))).toBe("หนึ่งร้อยแปดสิบห้าบาทถ้วน");
    expect(bahtText(toSatang(21.5))).toBe("ยี่สิบเอ็ดบาทห้าสิบสตางค์");
    expect(bahtText(toSatang(1000001))).toBe("หนึ่งล้านเอ็ดบาทถ้วน");
  });
  it("parses BE and CE dates", () => {
    expect(toIso("02/10/2569", "x")).toBe("2026-10-02");
    expect(toIso("2026-10-31", "x")).toBe("2026-10-31");
  });
});

describe("analysis", () => {
  it("passes a clean full tax invoice and claims input VAT", () => {
    const d = doc({});
    const a = analyze(ctx(), d, [d], TM);
    expect(a.blocks).toBe(0);
    expect(a.claimVat).toBe(true);
    expect(a.expense).toBe(toSatang(1000));
  });
  it("blocks a missing buyer TIN and an invoice older than 6 months", () => {
    const d = doc({ buyerTin: "", date: "2026-03-14" });
    const a = analyze(ctx(), d, [d], TM);
    expect(a.blocks).toBe(2);
    expect(a.claimVat).toBe(false);
    expect(a.expense).toBe(toSatang(1070));
  });
  it("detects duplicates by vendor and number", () => {
    const d1 = doc({ no: "X-1" }), d2 = doc({ no: "X-1" });
    expect(analyze(ctx(), d2, [d1, d2], TM).dupOf).toBe(d1.id);
  });
  it("warns on wrong VAT and needs review", () => {
    const d = doc({ vat: toSatang(72) });
    const a = analyze(ctx(), d, [d], TM);
    expect(a.warns).toBe(1);
    expect(a.review).toBe(true);
  });
  it("folds disallowed input VAT (entertainment) into the expense", () => {
    const d = doc({ desc: "เลี้ยงรับรองลูกค้า", base: toSatang(4800), vat: toSatang(336) });
    const a = analyze(ctx(), d, [d], TM);
    expect(a.code).toBe("5340");
    expect(a.claimVat).toBe(false);
    expect(a.expense).toBe(toSatang(5136));
  });
  it("routes foreign services to PP36 and PND54", () => {
    const d = doc({ type: "foreign", tin: "", vat: 0, base: toSatang(20000), wht: toSatang(3000), desc: "software subscription" });
    const a = analyze(ctx(), d, [d], TM);
    expect(a.pp36).toBe(toSatang(1400));
    expect(a.whtForm).toBe("ภ.ง.ด.54");
  });
  it("checks the WHT rate by income type", () => {
    const d = doc({ desc: "ค่าขนส่งสินค้า", base: toSatang(18500), vat: toSatang(1295), wht: toSatang(555) });
    const a = analyze(ctx(), d, [d], TM);
    expect(a.findings.some(f => f.sev === "warn" && f.text.includes("1%"))).toBe(true);
  });
});

describe("account-code suggestions", () => {
  it("prefers vendor history, then the asset rule, then keywords", () => {
    const c = ctx();
    c.vendorRules["บจ. ทดสอบ"] = { code: "5130", n: 6, src: "hist" };
    expect(suggest(c, doc({}))[0]).toMatchObject({ code: "5130", score: 98 });
    expect(suggest(ctx(), doc({ vendor: "บจ. อื่น", desc: "เครื่องขัดพื้น", base: toSatang(25000) }))[0].code).toBe("1250");
    expect(suggest(ctx(), doc({ vendor: "บจ. อื่น", desc: "ค่าขนส่งสินค้า" }))[0].code).toBe("5210");
    expect(suggest(ctx(), doc({ vendor: "ร้าน", desc: "ปูนกาว" }))[0].code).toBe("5990");
  });
  it("learns from confirmations and edits", () => {
    const rules = {};
    expect(learn(rules, "บจ. ก", "5130", false)).toMatchObject({ n: 1, src: "hist" });
    expect(learn(rules, "บจ. ก", "5130", false)).toMatchObject({ n: 2 });
    expect(learn(rules, "บจ. ก", "5210", true)).toMatchObject({ code: "5210", n: 1, src: "edit" });
  });
});

describe("deadlines, exports and import", () => {
  it("moves weekend due dates to Monday", () => {
    expect(dueDate("2026-10", 15)).toEqual({ iso: "2026-11-16", moved: "อาทิตย์" });
    expect(dueDate("2026-10", 23)).toEqual({ iso: "2026-11-23", moved: "" });
  });
  it("produces a balanced journal", () => {
    const c = ctx(), d = doc({ desc: "ค่าขนส่ง", base: toSatang(18500), vat: toSatang(1295), wht: toSatang(185) });
    const an = { [d.id]: analyze(c, d, [d], TM) };
    const rows = exportRows("jv", [d], an, c.accounts, { vat: "1154", ap: "2110", wht: "2132" }).slice(1);
    const dr = rows.reduce((s, r) => s + toSatang(r[4] || 0), 0), cr = rows.reduce((s, r) => s + toSatang(r[5] || 0), 0);
    expect(dr).toBe(cr);
  });
  it("maps Thai headers without confusing VAT and TIN columns", () => {
    const p = parseTable("วันที่\tผู้ขาย\tเลขผู้เสียภาษี\tมูลค่า\tVAT\n01/10/2569\tบจ. ก\t0999999000012\t100\t7")!;
    expect(p.map).toMatchObject({ date: 0, vendor: 1, tin: 2, base: 3, vat: 4 });
  });
});
