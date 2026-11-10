import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { analyze, exportRows, learn, obligations, toCsv, toSatang, vendorKey, type Analysis, type ClientCtx, type Doc, type ObStatus } from "../engine";
import { extractReceipt, suggestCode } from "./ai";
import { hashPassword, newToken, sessionCookie, SESSION_COOKIE, SESSION_HOURS, sha256, timingSafeEqual } from "./auth";
import { DEMO, TEMPLATES, demoMoney } from "./templates";

type Env = { DB: D1Database; FILES: R2Bucket; ASSETS: Fetcher; GEMINI_API_KEY?: string; GEMINI_MODEL?: string };
type User = { id: string; firm_id: string; name: string; email: string; role: string };
type Vars = { user: User };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const uid = () => crypto.randomUUID();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const bad = (msg: string, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json" } });
const isSecure = (url: string) => url.startsWith("https://");

/* ---------- security middleware ---------- */
app.use("/api/*", async (c, next) => {
  // CSRF: mutating requests must carry a custom header, which a cross-site form cannot send.
  if (c.req.method !== "GET" && c.req.header("x-pidngod") !== "1") return bad("missing request header", 403);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return bad("not signed in", 401);
  const th = await sha256(token);
  const row = await c.env.DB.prepare("SELECT u.id, u.firm_id, u.name, u.email, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").bind(th).first<User & { expires_at: string }>();
  if (!row || row.expires_at < new Date().toISOString()) return bad("session expired", 401);
  // sliding expiry
  await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString(), th).run();
  c.set("user", { id: row.id, firm_id: row.firm_id, name: row.name, email: row.email, role: row.role });
  await next();
});

async function audit(env: Env, u: User, clientId: string | null, action: string) {
  await env.DB.prepare("INSERT INTO audit (firm_id, client_id, user_id, user_name, action) VALUES (?, ?, ?, ?, ?)").bind(u.firm_id, clientId, u.id, u.name, action).run();
}
async function startSession(env: Env, userId: string, firmId: string, url: string) {
  const token = newToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, firm_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), userId, firmId, new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString()).run();
  return sessionCookie(token, isSecure(url));
}

/* ---------- auth ---------- */
app.post("/api/auth/signup", async c => {
  const b = await c.req.json<{ firmName?: string; name?: string; email?: string; password?: string; demo?: boolean }>().catch(() => ({} as any));
  const email = String(b.email || "").trim().toLowerCase(), name = String(b.name || "").trim(), firmName = String(b.firmName || "").trim();
  if (!firmName || !name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("กรอกชื่อสำนักงาน ชื่อ และอีเมลให้ครบ");
  if (String(b.password || "").length < 10) return bad("รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร");
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return bad("อีเมลนี้มีบัญชีแล้ว");
  const firmId = uid(), userId = uid(), pw = await hashPassword(String(b.password));
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO firms (id, name) VALUES (?, ?)").bind(firmId, firmName),
    c.env.DB.prepare("INSERT INTO users (id, firm_id, email, name, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?, ?, ?, 'owner')").bind(userId, firmId, email, name, pw.hash, pw.salt),
  ]);
  const u: User = { id: userId, firm_id: firmId, name, email, role: "owner" };
  await audit(c.env, u, null, `สร้างสำนักงาน ${firmName}`);
  if (b.demo) await seedDemo(c.env, u);
  c.header("Set-Cookie", await startSession(c.env, userId, firmId, c.req.url));
  return c.json({ ok: true });
});
app.post("/api/auth/login", async c => {
  const b = await c.req.json<{ email?: string; password?: string }>().catch(() => ({} as any));
  const email = String(b.email || "").trim().toLowerCase();
  const recent = await c.env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE email = ? AND at > datetime('now', '-15 minutes')").bind(email).first<{ n: number }>();
  if ((recent?.n || 0) >= 10) return bad("ลองเข้าสู่ระบบหลายครั้งเกินไป รอ 15 นาที", 429);
  const u = await c.env.DB.prepare("SELECT id, firm_id, pw_hash, pw_salt FROM users WHERE email = ?").bind(email).first<{ id: string; firm_id: string; pw_hash: string; pw_salt: string }>();
  const check = await hashPassword(String(b.password || ""), u?.pw_salt);
  if (!u || !timingSafeEqual(check.hash, u.pw_hash)) {
    await c.env.DB.prepare("INSERT INTO login_attempts (email) VALUES (?)").bind(email).run();
    return bad("อีเมลหรือรหัสผ่านไม่ถูกต้อง", 401);
  }
  c.header("Set-Cookie", await startSession(c.env, u.id, u.firm_id, c.req.url));
  return c.json({ ok: true });
});
app.post("/api/auth/logout", async c => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  c.header("Set-Cookie", sessionCookie("", isSecure(c.req.url), 0));
  return c.json({ ok: true });
});
app.get("/api/me", async c => {
  const u = c.get("user");
  const firm = await c.env.DB.prepare("SELECT id, name FROM firms WHERE id = ?").bind(u.firm_id).first();
  return c.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, firm, ai: !!c.env.GEMINI_API_KEY });
});

/* ---------- data helpers (always scoped by firm) ---------- */
type ClientRow = { id: string; firm_id: string; name: string; full_name: string; tin: string; software: string; biz: string; cap_threshold: number; asset_code: string; misc_code: string; vatx_codes: string; ctrl: string };
async function clientOf(env: Env, u: User, id: string) {
  return env.DB.prepare("SELECT * FROM clients WHERE id = ? AND firm_id = ?").bind(id, u.firm_id).first<ClientRow>();
}
async function ctxOf(env: Env, cl: ClientRow): Promise<ClientCtx> {
  const [acc, vr] = await env.DB.batch([
    env.DB.prepare("SELECT code, name, keywords FROM accounts WHERE client_id = ? AND firm_id = ? ORDER BY code").bind(cl.id, cl.firm_id),
    env.DB.prepare("SELECT vendor_key, code, n, src FROM vendor_rules WHERE client_id = ? AND firm_id = ?").bind(cl.id, cl.firm_id),
  ]);
  const vendorRules: ClientCtx["vendorRules"] = {};
  for (const r of vr.results as any[]) vendorRules[r.vendor_key] = { code: r.code, n: r.n, src: r.src };
  return { tin: cl.tin, capThreshold: cl.cap_threshold, assetCode: cl.asset_code, miscCode: cl.misc_code, vatxCodes: JSON.parse(cl.vatx_codes), accounts: acc.results as any, vendorRules };
}
type DocRow = { id: string; seq: number; date: string; no: string; vendor: string; tin: string; buyer_tin: string; vat_reg: number; description: string; base: number; vat: number; wht: number; type: string; status: string; code: string | null; code_edited: number; exported: number; src: string; file_key: string | null; tax_month: string; client_id: string };
const toDoc = (r: DocRow): Doc & { seq: number; src: string; exported: boolean; hasFile: boolean } => ({
  id: r.id, seq: r.seq, date: r.date, no: r.no, vendor: r.vendor, tin: r.tin, buyerTin: r.buyer_tin, vatReg: !!r.vat_reg, desc: r.description,
  base: r.base, vat: r.vat, wht: r.wht, type: r.type as Doc["type"], status: r.status as Doc["status"], code: r.code, codeEdited: !!r.code_edited,
  src: r.src, exported: !!r.exported, hasFile: !!r.file_key,
});
async function docsOf(env: Env, cl: ClientRow, month: string) {
  const r = await env.DB.prepare("SELECT * FROM documents WHERE client_id = ? AND firm_id = ? AND tax_month = ? ORDER BY seq").bind(cl.id, cl.firm_id, month).all<DocRow>();
  return r.results.map(toDoc);
}
function analyzeAll(ctx: ClientCtx, docs: Doc[], month: string) {
  const an: Record<string, Analysis> = {};
  for (const d of docs) an[d.id] = analyze(ctx, d, docs, month);
  return an;
}
async function docOf(env: Env, u: User, id: string) {
  return env.DB.prepare("SELECT * FROM documents WHERE id = ? AND firm_id = ?").bind(id, u.firm_id).first<DocRow>();
}
const monthOf = (v: string | undefined) => (v && MONTH_RE.test(v) ? v : "2026-10");
async function nextSeq(env: Env, clientId: string, month: string) {
  const r = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM documents WHERE client_id = ? AND tax_month = ?").bind(clientId, month).first<{ n: number }>();
  return r?.n || 1;
}
type NewDoc = { date: string; no?: string; vendor: string; tin?: string; buyerTin?: string; vatReg?: boolean; desc?: string; base: number; vat: number; wht: number; type: string; src: string; fileKey?: string | null };
function insertDoc(env: Env, cl: ClientRow, month: string, seq: number, d: NewDoc) {
  const type = ["full", "abb", "cash", "etax", "foreign"].includes(d.type) ? d.type : "full";
  return env.DB.prepare("INSERT INTO documents (id, firm_id, client_id, tax_month, seq, date, no, vendor, tin, buyer_tin, vat_reg, description, base, vat, wht, type, src, file_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(uid(), cl.firm_id, cl.id, month, seq, /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : `${month}-01`, String(d.no || "-").slice(0, 60), String(d.vendor).slice(0, 200),
      String(d.tin || "").replace(/\D/g, "").slice(0, 13), d.buyerTin === undefined ? cl.tin : String(d.buyerTin).replace(/\D/g, "").slice(0, 13), d.vatReg === false ? 0 : 1,
      String(d.desc || "-").slice(0, 300), Math.round(+d.base || 0), Math.round(+d.vat || 0), Math.round(+d.wht || 0), type, d.src, d.fileKey || null);
}

/* ---------- clients ---------- */
app.get("/api/clients", async c => {
  const u = c.get("user"), month = monthOf(c.req.query("month"));
  const rows = await c.env.DB.prepare(`SELECT c.id, c.name, c.software, c.tin,
      (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id AND d.tax_month = ?) AS docs,
      (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id AND d.tax_month = ? AND d.status = 'new') AS new_docs
    FROM clients c WHERE c.firm_id = ? ORDER BY c.created_at`).bind(month, month, u.firm_id).all();
  return c.json({ clients: rows.results, templates: Object.entries(TEMPLATES).map(([k, t]) => ({ key: k, label: t.label })) });
});
app.post("/api/clients", async c => {
  const u = c.get("user"), b = await c.req.json<any>().catch(() => ({}));
  const t = TEMPLATES[b.template] || TEMPLATES.service, name = String(b.name || "").trim();
  if (!name) return bad("ใส่ชื่อลูกค้า");
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO clients (id, firm_id, name, full_name, tin, software, biz, cap_threshold, asset_code, misc_code, vatx_codes, ctrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, u.firm_id, name, String(b.fullName || name), String(b.tin || "").replace(/\D/g, "").slice(0, 13), ["PEAK", "Express", "FlowAccount", "Excel"].includes(b.software) ? b.software : "PEAK", String(b.biz || t.label), toSatang(b.capThreshold ?? 10000), t.assetCode, t.miscCode, JSON.stringify(t.vatx), JSON.stringify(t.ctrl)),
    ...t.accounts.map(a => c.env.DB.prepare("INSERT INTO accounts (client_id, firm_id, code, name, keywords) VALUES (?, ?, ?, ?, ?)").bind(id, u.firm_id, a[0], a[1], a[2])),
  ]);
  await audit(c.env, u, id, `เพิ่มลูกค้า ${name} (ผังบัญชีตั้งต้น: ${t.label})`);
  return c.json({ id });
});
app.get("/api/clients/:id", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const ctx = await ctxOf(c.env, cl);
  return c.json({ client: { id: cl.id, name: cl.name, fullName: cl.full_name, tin: cl.tin, software: cl.software, biz: cl.biz, capThreshold: cl.cap_threshold, assetCode: cl.asset_code, miscCode: cl.misc_code, ctrl: JSON.parse(cl.ctrl) }, accounts: ctx.accounts, vendorRules: ctx.vendorRules });
});
app.patch("/api/clients/:id", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const b = await c.req.json<any>().catch(() => ({}));
  await c.env.DB.prepare("UPDATE clients SET name = ?, full_name = ?, tin = ?, biz = ?, cap_threshold = ?, asset_code = ?, misc_code = ? WHERE id = ? AND firm_id = ?")
    .bind(String(b.name ?? cl.name), String(b.fullName ?? cl.full_name), String(b.tin ?? cl.tin).replace(/\D/g, "").slice(0, 13), String(b.biz ?? cl.biz), b.capThreshold !== undefined ? Math.round(+b.capThreshold) : cl.cap_threshold, String(b.assetCode ?? cl.asset_code), String(b.miscCode ?? cl.misc_code), cl.id, u.firm_id).run();
  await audit(c.env, u, cl.id, "แก้ไขข้อมูลและกฎของลูกค้า");
  return c.json({ ok: true });
});
app.put("/api/clients/:id/accounts", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  type In = { code: string; name: string; keywords?: string };
  const b = await c.req.json<{ accounts?: In[] }>().catch(() => ({} as { accounts?: In[] }));
  const list: In[] = (b.accounts || []).filter((a: In) => a && a.code && a.name).slice(0, 2000);
  if (!list.length) return bad("ไม่พบรายการผังบัญชี");
  const old = await c.env.DB.prepare("SELECT code, keywords FROM accounts WHERE client_id = ?").bind(cl.id).all<{ code: string; keywords: string }>();
  const kw = new Map(old.results.map(r => [r.code, r.keywords]));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM accounts WHERE client_id = ? AND firm_id = ?").bind(cl.id, u.firm_id),
    ...list.map(a => c.env.DB.prepare("INSERT OR REPLACE INTO accounts (client_id, firm_id, code, name, keywords) VALUES (?, ?, ?, ?, ?)").bind(cl.id, u.firm_id, String(a.code).trim(), String(a.name).trim(), a.keywords ?? kw.get(String(a.code).trim()) ?? String(a.name).replace(/^ค่า/, "").replace(/[()]/g, "").split(/\s+/)[0])),
  ]);
  const codes = new Set(list.map(a => String(a.code).trim()));
  if (!codes.has(cl.misc_code) || !codes.has(cl.asset_code)) await c.env.DB.prepare("UPDATE clients SET misc_code = ?, asset_code = ? WHERE id = ?").bind(codes.has(cl.misc_code) ? cl.misc_code : String(list[list.length - 1].code), codes.has(cl.asset_code) ? cl.asset_code : String(list[0].code), cl.id).run();
  await audit(c.env, u, cl.id, `นำเข้าผังบัญชี ${list.length} รหัส`);
  return c.json({ ok: true, count: list.length });
});
app.delete("/api/clients/:id/vendor-rules", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const key = c.req.query("key") || "";
  await c.env.DB.prepare("DELETE FROM vendor_rules WHERE client_id = ? AND firm_id = ? AND vendor_key = ?").bind(cl.id, u.firm_id, key).run();
  await audit(c.env, u, cl.id, `ลบกฎผู้ขาย ${key}`);
  return c.json({ ok: true });
});

/* ---------- documents ---------- */
app.get("/api/clients/:id/documents", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const month = monthOf(c.req.query("month")), ctx = await ctxOf(c.env, cl), docs = await docsOf(c.env, cl, month);
  const an = analyzeAll(ctx, docs, month);
  return c.json({ month, docs: docs.map(d => ({ ...d, a: d.status === "new" ? null : an[d.id] })) });
});
app.post("/api/clients/:id/documents", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const b = await c.req.json<{ month?: string; docs?: NewDoc[]; src?: string }>().catch(() => ({} as { month?: string; docs?: NewDoc[]; src?: string }));
  const month = monthOf(b.month), list: NewDoc[] = (b.docs || []).filter((d: NewDoc) => d && d.vendor).slice(0, 1000);
  if (!list.length) return bad("ไม่มีรายการ");
  let seq = await nextSeq(c.env, cl.id, month);
  await c.env.DB.batch(list.map(d => insertDoc(c.env, cl, month, seq++, { ...d, src: String(d.src || b.src || "เพิ่มเอง").slice(0, 30) })));
  await audit(c.env, u, cl.id, `เพิ่มเอกสาร ${list.length} รายการ (${b.src || "เพิ่มเอง"})`);
  return c.json({ ok: true, count: list.length });
});
app.post("/api/clients/:id/upload", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  if (!c.env.GEMINI_API_KEY) return bad("ยังไม่ได้ตั้งค่า GEMINI_API_KEY จึงอ่านรูปด้วย AI ไม่ได้", 503);
  const form = await c.req.formData(), file = form.get("file"), month = monthOf(String(form.get("month") || ""));
  if (!(file instanceof File)) return bad("ไม่พบไฟล์");
  if (file.size > 10 * 1024 * 1024) return bad("ไฟล์ใหญ่เกิน 10 MB");
  if (!/^(image\/(jpeg|png|webp|heic)|application\/pdf)$/.test(file.type)) return bad("รองรับเฉพาะรูปภาพและ PDF");
  const buf = await file.arrayBuffer(), key = `${cl.firm_id}/${cl.id}/${month}/${uid()}`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: file.type }, customMetadata: { name: file.name.slice(0, 200), sha256: await sha256(String(buf.byteLength) + key) } });
  let x;
  try { x = await extractReceipt(c.env, buf, file.type); } catch (e) { return bad("AI อ่านเอกสารไม่สำเร็จ ลองอีกครั้งหรือเพิ่มเอง", 502); }
  const seq = await nextSeq(c.env, cl.id, month);
  await insertDoc(c.env, cl, month, seq, { date: x.date || `${month}-28`, no: x.no, vendor: x.vendor || "(อ่านชื่อผู้ขายไม่ได้)", tin: x.tin, buyerTin: x.buyerTin || cl.tin, desc: x.desc, base: toSatang(x.base), vat: toSatang(x.vat), wht: toSatang(x.wht), type: x.type, src: "รูป · AI", fileKey: key }).run();
  await audit(c.env, u, cl.id, `AI อ่านไฟล์ ${file.name.slice(0, 60)} → ${x.vendor}`);
  return c.json({ ok: true });
});
app.post("/api/clients/:id/process", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const month = monthOf((await c.req.json<any>().catch(() => ({}))).month);
  const r = await c.env.DB.prepare("UPDATE documents SET status = 'ready', updated_at = datetime('now') WHERE client_id = ? AND firm_id = ? AND tax_month = ? AND status = 'new'").bind(cl.id, u.firm_id, month).run();
  await audit(c.env, u, cl.id, `ตรวจและจัดประเภทเอกสาร ${r.meta.changes} ใบ`);
  return c.json({ ok: true, count: r.meta.changes });
});
async function confirmOne(env: Env, u: User, cl: ClientRow, ctx: ClientCtx, d: Doc, a: Analysis) {
  if (a.dupOf || !a.code) return [];
  const code = d.code || a.code, rule = learn(ctx.vendorRules, d.vendor, code, d.codeEdited);
  return [
    env.DB.prepare("UPDATE documents SET status = 'confirmed', code = ?, updated_at = datetime('now') WHERE id = ? AND firm_id = ?").bind(code, d.id, u.firm_id),
    env.DB.prepare("INSERT OR REPLACE INTO vendor_rules (client_id, firm_id, vendor_key, code, n, src) VALUES (?, ?, ?, ?, ?, ?)").bind(cl.id, u.firm_id, vendorKey(d.vendor), rule.code, rule.n, rule.src),
    env.DB.prepare("INSERT INTO audit (firm_id, client_id, user_id, user_name, action) VALUES (?, ?, ?, ?, ?)").bind(u.firm_id, cl.id, u.id, u.name, `ยืนยัน ${d.vendor} ${d.no} → ${code}`),
  ];
}
async function withDoc(c: any, fn: (ctx: { u: User; cl: ClientRow; ctx: ClientCtx; d: Doc; a: Analysis; month: string; row: DocRow }) => Promise<Response>) {
  const u = c.get("user") as User, row = await docOf(c.env, u, c.req.param("id"));
  if (!row) return bad("ไม่พบเอกสาร", 404);
  const cl = (await clientOf(c.env, u, row.client_id))!, ctx = await ctxOf(c.env, cl), docs = await docsOf(c.env, cl, row.tax_month);
  const d = docs.find(x => x.id === row.id)!, a = analyze(ctx, d, docs, row.tax_month);
  return fn({ u, cl, ctx, d, a, month: row.tax_month, row });
}
app.post("/api/documents/:id/confirm", c => withDoc(c, async ({ u, cl, ctx, d, a }) => {
  if (d.status === "new") return bad("ประมวลผลเอกสารก่อน");
  const st = await confirmOne(c.env, u, cl, ctx, d, a);
  if (!st.length) return bad("เอกสารซ้ำหรือยังไม่มีรหัสบัญชี");
  await c.env.DB.batch(st);
  return c.json({ ok: true });
}));
app.post("/api/documents/:id/unconfirm", c => withDoc(c, async ({ u, cl, d, row }) => {
  if (row.exported) return bad("ส่งออกแล้ว ยกเลิกการยืนยันไม่ได้");
  await c.env.DB.prepare("UPDATE documents SET status = 'ready', updated_at = datetime('now') WHERE id = ? AND firm_id = ?").bind(d.id, u.firm_id).run();
  await audit(c.env, u, cl.id, `ยกเลิกการยืนยัน ${d.vendor} ${d.no}`);
  return c.json({ ok: true });
}));
app.post("/api/documents/:id/request", c => withDoc(c, async ({ u, cl, d }) => {
  await c.env.DB.prepare("UPDATE documents SET status = 'requested', updated_at = datetime('now') WHERE id = ? AND firm_id = ?").bind(d.id, u.firm_id).run();
  await audit(c.env, u, cl.id, `ขอเอกสารใหม่: ${d.vendor} ${d.no}`);
  return c.json({ ok: true });
}));
app.post("/api/documents/:id/code", c => withDoc(c, async ({ u, cl, ctx, d, row }) => {
  if (row.exported) return bad("ส่งออกแล้ว แก้รหัสไม่ได้");
  const code = String((await c.req.json<any>().catch(() => ({}))).code || "");
  if (!ctx.accounts.some(a => a.code === code)) return bad("รหัสนี้ไม่อยู่ในผังบัญชีของลูกค้า");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE documents SET code = ?, code_edited = 1, updated_at = datetime('now') WHERE id = ? AND firm_id = ?").bind(code, d.id, u.firm_id),
    c.env.DB.prepare("INSERT OR REPLACE INTO vendor_rules (client_id, firm_id, vendor_key, code, n, src) VALUES (?, ?, ?, ?, 1, 'edit')").bind(cl.id, u.firm_id, vendorKey(d.vendor), code),
  ]);
  await audit(c.env, u, cl.id, `เปลี่ยนรหัสบัญชี ${d.vendor} เป็น ${code} และจำไว้สำหรับผู้ขายรายนี้`);
  return c.json({ ok: true });
}));
app.patch("/api/documents/:id", c => withDoc(c, async ({ u, cl, d, row }) => {
  if (row.status === "confirmed") return bad("ยกเลิกการยืนยันก่อนแก้ไข");
  const b = await c.req.json<any>().catch(() => ({}));
  await c.env.DB.prepare("UPDATE documents SET date = ?, no = ?, vendor = ?, tin = ?, buyer_tin = ?, description = ?, base = ?, vat = ?, wht = ?, type = ?, vat_reg = ?, updated_at = datetime('now') WHERE id = ? AND firm_id = ?")
    .bind(/^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : row.date, String(b.no ?? row.no).slice(0, 60), String(b.vendor ?? row.vendor).slice(0, 200), String(b.tin ?? row.tin).replace(/\D/g, "").slice(0, 13), String(b.buyerTin ?? row.buyer_tin).replace(/\D/g, "").slice(0, 13), String(b.desc ?? row.description).slice(0, 300),
      Math.round(b.base ?? row.base), Math.round(b.vat ?? row.vat), Math.round(b.wht ?? row.wht), ["full", "abb", "cash", "etax", "foreign"].includes(b.type) ? b.type : row.type, b.vatReg === undefined ? row.vat_reg : b.vatReg ? 1 : 0, d.id, u.firm_id).run();
  await audit(c.env, u, cl.id, `แก้ไขข้อมูลเอกสาร ${d.vendor} ${d.no}`);
  return c.json({ ok: true });
}));
app.post("/api/documents/:id/ai-suggest", c => withDoc(c, async ({ cl, ctx, d }) => {
  try { return c.json(await suggestCode(c.env, cl.biz, cl.cap_threshold / 100, ctx.accounts, { vendor: d.vendor, desc: d.desc, base: d.base / 100, vat: d.vat / 100, type: d.type })); }
  catch (e: any) { return bad(e?.message === "NO_KEY" ? "ยังไม่ได้ตั้งค่า GEMINI_API_KEY" : "AI เสนอรหัสไม่สำเร็จ", e?.message === "NO_KEY" ? 503 : 502); }
}));
app.get("/api/documents/:id/file", async c => {
  const u = c.get("user"), row = await docOf(c.env, u, c.req.param("id"));
  if (!row || !row.file_key) return bad("ไม่พบไฟล์", 404);
  const obj = await c.env.FILES.get(row.file_key);
  if (!obj) return bad("ไม่พบไฟล์", 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
app.post("/api/clients/:id/confirm-high", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const month = monthOf((await c.req.json<any>().catch(() => ({}))).month), ctx = await ctxOf(c.env, cl), docs = await docsOf(c.env, cl, month), an = analyzeAll(ctx, docs, month);
  const st: D1PreparedStatement[] = []; let n = 0;
  for (const d of docs) { const a = an[d.id]; if (d.status === "ready" && !a.review && !a.dupOf && a.conf >= 90) { st.push(...await confirmOne(c.env, u, cl, ctx, d, a)); n++; } }
  if (st.length) await c.env.DB.batch(st);
  return c.json({ ok: true, count: n });
});

/* ---------- export ---------- */
app.post("/api/clients/:id/export", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const b = await c.req.json<any>().catch(() => ({})), month = monthOf(b.month), format = b.format === "jv" ? "jv" : "peak", preview = !!b.preview;
  const ctx = await ctxOf(c.env, cl), docs = await docsOf(c.env, cl, month), an = analyzeAll(ctx, docs, month);
  const rows = docs.filter(d => d.status === "confirmed" && !d.exported && !an[d.id].dupOf);
  const table = exportRows(format, rows, an, ctx.accounts, JSON.parse(cl.ctrl));
  if (!preview && rows.length) {
    await c.env.DB.batch(rows.map(d => c.env.DB.prepare("UPDATE documents SET exported = 1 WHERE id = ? AND firm_id = ?").bind(d.id, u.firm_id)));
    await audit(c.env, u, cl.id, `ส่งออก${format === "peak" ? "ไฟล์นำเข้า PEAK" : "สมุดรายวัน"} ${rows.length} รายการ`);
  }
  return c.json({ count: rows.length, table, csv: toCsv(table), filename: `${format === "peak" ? "PEAK_import" : "journal"}_${month}.csv` });
});

/* ---------- deadline board + filings ---------- */
app.get("/api/board", async c => {
  const u = c.get("user"), month = monthOf(c.req.query("month")), channel = c.req.query("channel") === "p" ? "p" : "e";
  const cls = await c.env.DB.prepare("SELECT * FROM clients WHERE firm_id = ? ORDER BY created_at").bind(u.firm_id).all<ClientRow>();
  const fl = await c.env.DB.prepare("SELECT client_id, form, status FROM filings WHERE firm_id = ? AND tax_month = ?").bind(u.firm_id, month).all<{ client_id: string; form: string; status: ObStatus }>();
  const out = [];
  for (const cl of cls.results) {
    const ctx = await ctxOf(c.env, cl), docs = await docsOf(c.env, cl, month), an = analyzeAll(ctx, docs, month);
    const filed: Record<string, ObStatus> = {};
    for (const f of fl.results) if (f.client_id === cl.id) filed[f.form] = f.status;
    const attention = docs.filter(d => d.status !== "new" && d.status !== "confirmed" && !an[d.id].dupOf && an[d.id].review).length;
    out.push({ id: cl.id, name: cl.name, software: cl.software, docs: docs.length, attention, obligations: docs.length ? obligations(ctx, docs, an, month, channel, filed) : [] });
  }
  return c.json({ month, channel, clients: out });
});
app.post("/api/clients/:id/filings", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const b = await c.req.json<any>().catch(() => ({})), month = monthOf(b.month), form = String(b.form || "");
  if (!["ภ.พ.30", "ภ.พ.36", "ภ.ง.ด.3", "ภ.ง.ด.53", "ภ.ง.ด.54"].includes(form)) return bad("แบบไม่ถูกต้อง");
  if (b.status === "filed" || b.status === "paid") await c.env.DB.prepare("INSERT OR REPLACE INTO filings (client_id, firm_id, tax_month, form, status) VALUES (?, ?, ?, ?, ?)").bind(cl.id, u.firm_id, month, form, b.status).run();
  else await c.env.DB.prepare("DELETE FROM filings WHERE client_id = ? AND firm_id = ? AND tax_month = ? AND form = ?").bind(cl.id, u.firm_id, month, form).run();
  await audit(c.env, u, cl.id, `${form}: ${b.status === "filed" ? "บันทึกว่ายื่นแล้ว" : b.status === "paid" ? "บันทึกว่าชำระแล้ว" : "ยกเลิกสถานะ"}`);
  return c.json({ ok: true });
});
app.get("/api/clients/:id/audit", async c => {
  const u = c.get("user"), cl = await clientOf(c.env, u, c.req.param("id"));
  if (!cl) return bad("ไม่พบลูกค้า", 404);
  const r = await c.env.DB.prepare("SELECT at, user_name, action FROM audit WHERE firm_id = ? AND client_id = ? ORDER BY id DESC LIMIT 300").bind(u.firm_id, cl.id).all();
  return c.json({ log: r.results });
});
app.post("/api/demo", async c => {
  await seedDemo(c.env, c.get("user"));
  return c.json({ ok: true });
});

async function seedDemo(env: Env, u: User) {
  for (const dc of DEMO) {
    const t = TEMPLATES[dc.template], id = uid();
    const cl: ClientRow = { id, firm_id: u.firm_id, name: dc.name, full_name: dc.full, tin: dc.tin, software: dc.software, biz: dc.biz, cap_threshold: toSatang(dc.cap), asset_code: t.assetCode, misc_code: t.miscCode, vatx_codes: JSON.stringify(t.vatx), ctrl: JSON.stringify(t.ctrl) };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO clients (id, firm_id, name, full_name, tin, software, biz, cap_threshold, asset_code, misc_code, vatx_codes, ctrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, u.firm_id, cl.name, cl.full_name, cl.tin, cl.software, cl.biz, cl.cap_threshold, cl.asset_code, cl.misc_code, cl.vatx_codes, cl.ctrl),
      ...t.accounts.map(a => env.DB.prepare("INSERT INTO accounts (client_id, firm_id, code, name, keywords) VALUES (?, ?, ?, ?, ?)").bind(id, u.firm_id, a[0], a[1], a[2])),
      ...dc.rules.map(r => env.DB.prepare("INSERT INTO vendor_rules (client_id, firm_id, vendor_key, code, n, src) VALUES (?, ?, ?, ?, ?, 'hist')").bind(id, u.firm_id, r[0], r[1], r[2])),
      ...dc.docs.map((d, i) => insertDoc(env, cl, "2026-10", i + 1, { date: d[0], no: d[1], vendor: d[2], tin: d[3], desc: d[4], base: demoMoney(d[5]), vat: demoMoney(d[6]), wht: demoMoney(d[7]), type: d[8], src: d[9], buyerTin: d[10]?.buyerTin, vatReg: d[10]?.vatReg })),
    ]);
  }
  await audit(env, u, null, "โหลดข้อมูลตัวอย่าง 2 ลูกค้า");
}

app.all("/api/*", c => bad("not found", 404));
export default app;
