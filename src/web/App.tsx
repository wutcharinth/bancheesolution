import { useCallback, useEffect, useMemo, useState } from "react";
import { baht, maskTin, parseTable, toIso, toSatang, vatOf, type Analysis, type Doc } from "../engine";
import { api, ApiError } from "./api";

type Me = { user: { name: string; email: string; role: string }; firm: { id: string; name: string }; ai: boolean };
type ClientLite = { id: string; name: string; software: string; docs: number; new_docs: number };
type DocA = Doc & { seq: number; src: string; exported: boolean; hasFile: boolean; a: Analysis | null };
type Account = { code: string; name: string; keywords: string };
type View = { page: "board" } | { page: "client"; id: string; tab: Tab };
type Tab = "review" | "import" | "accounts" | "export" | "log";
const TABS: [Tab, string][] = [["review", "ตรวจและจัดประเภท"], ["import", "นำเข้าเอกสาร"], ["accounts", "ผังบัญชีและกฎ"], ["export", "ส่งออก"], ["log", "ประวัติการทำงาน"]];
const TH_M = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const thDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_M[m - 1]} ${y + 543}`; };
const thMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${TH_M[m - 1]} ${y + 543}`; };
const months = () => { const out: string[] = []; const d = new Date(); for (let i = 1; i <= 12; i++) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`); } return out; };
const TYPE_L: Record<string, string> = { full: "ใบกำกับเต็มรูป", etax: "e-Tax Invoice", abb: "ใบกำกับอย่างย่อ", cash: "บิล / ใบเสร็จ", foreign: "ต่างประเทศ" };
const OB_L: Record<string, string> = { waiting: "รอเอกสาร", review: "กำลังตรวจ", ready: "พร้อมยื่น", filed: "ยื่นแล้ว", paid: "ชำระแล้ว" };

function useToast() {
  const [t, setT] = useState<{ m: string; err?: boolean } | null>(null);
  const show = useCallback((m: string, err = false) => { setT({ m, err }); setTimeout(() => setT(null), 3200); }, []);
  const el = t ? <div className={`toast ${t.err ? "err" : ""}`} role="status">{t.m}</div> : null;
  return { show, el };
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => api<Me>("/api/me").then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { load(); }, [load]);
  if (me === undefined) return <div className="empty">กำลังโหลด…</div>;
  if (me === null) return <Auth onDone={load} />;
  return <Shell me={me} onLogout={() => api("/api/auth/logout", { body: {} }).then(() => setMe(null))} />;
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [f, setF] = useState({ firmName: "", name: "", email: "", password: "", demo: true });
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try { await api(`/api/auth/${mode}`, { body: f }); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return <div className="auth"><div className="card"><div className="card-b form">
    <h1>ปิดงวด</h1><p className="muted" style={{ margin: 0 }}>ที่ทำงานรายเดือนของสำนักงานบัญชี</p>
    <div className="chips"><button type="button" aria-pressed={mode === "login"} onClick={() => setMode("login")}>เข้าสู่ระบบ</button><button type="button" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>สร้างสำนักงานใหม่</button></div>
    <form className="form" onSubmit={submit}>
      {mode === "signup" && <><label>ชื่อสำนักงาน<input className="inp" value={f.firmName} onChange={set("firmName")} required /></label><label>ชื่อของคุณ<input className="inp" value={f.name} onChange={set("name")} required /></label></>}
      <label>อีเมล<input className="inp" type="email" autoComplete="email" value={f.email} onChange={set("email")} required /></label>
      <label>รหัสผ่าน{mode === "signup" && " (อย่างน้อย 10 ตัวอักษร)"}<input className="inp" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={f.password} onChange={set("password")} required minLength={mode === "signup" ? 10 : 1} /></label>
      {mode === "signup" && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={f.demo} onChange={set("demo")} /> ใส่ข้อมูลตัวอย่าง 2 ลูกค้าเพื่อทดลองใช้</label>}
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn pri" disabled={busy}>{mode === "login" ? "เข้าสู่ระบบ" : "สร้างสำนักงาน"}</button>
    </form>
  </div></div></div>;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [view, setView] = useState<View>({ page: "board" });
  const [month, setMonth] = useState(months()[0]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [templates, setTemplates] = useState<{ key: string; label: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const reload = useCallback(() => api<{ clients: ClientLite[]; templates: any[] }>(`/api/clients?month=${month}`).then(r => { setClients(r.clients); setTemplates(r.templates); }), [month]);
  useEffect(() => { reload(); }, [reload]);
  const cur = view.page === "client" ? clients.find(c => c.id === view.id) : null;
  return <>
    <header className="top"><div className="gut hd">
      <div className="brand"><svg width="24" height="24" viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15" fill="none" stroke="var(--stamp)" strokeWidth="2.5" /><path d="M11 17.5l4 4 8-9" fill="none" stroke="var(--ledger)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>ปิดงวด</div>
      <span className="muted">{me.firm.name}</span><span className="sp" />
      <label className="muted" htmlFor="month">เดือนภาษี</label>
      <select id="month" className="inp" style={{ width: "auto" }} value={month} onChange={e => setMonth(e.target.value)}>{months().map(m => <option key={m} value={m}>{thMonth(m)}</option>)}</select>
      <span className="muted">{me.user.name}</span><button className="btn sm" type="button" onClick={onLogout}>ออกจากระบบ</button>
    </div></header>
    <div className="gut app">
      <nav className="rail" aria-label="เมนู">
        <button type="button" aria-current={view.page === "board" ? "page" : undefined} onClick={() => setView({ page: "board" })}><b>กระดานกำหนดยื่น</b><span className="ct">{clients.length}</span></button>
        <div className="rail-h">ลูกค้า</div>
        {clients.map(c => <button key={c.id} type="button" aria-current={view.page === "client" && view.id === c.id ? "page" : undefined} onClick={() => setView({ page: "client", id: c.id, tab: "review" })}>{c.name}<span className={`ct ${c.new_docs ? "hot" : ""}`}>{c.docs}</span></button>)}
        <button type="button" onClick={() => setAdding(true)}>+ เพิ่มลูกค้า</button>
        {cur && view.page === "client" && <><div className="rail-h">{cur.name}</div>{TABS.map(([t, l]) => <button key={t} type="button" aria-current={view.tab === t ? "page" : undefined} onClick={() => setView({ ...view, tab: t })}>{l}</button>)}</>}
      </nav>
      <main>
        {view.page === "board" && <Board month={month} open={(id, tab) => setView({ page: "client", id, tab: tab || "review" })} empty={!clients.length} onDemo={async () => { await api("/api/demo", { body: {} }); toast.show("เพิ่มข้อมูลตัวอย่างแล้ว ดูเดือนภาษี ต.ค. 2569"); setMonth("2026-10"); reload(); }} />}
        {view.page === "client" && cur && <ClientView key={cur.id + month} clientId={cur.id} month={month} tab={view.tab} ai={me.ai} toast={toast.show} onChange={reload} setTab={t => setView({ ...view, tab: t })} />}
      </main>
    </div>
    {adding && <AddClient templates={templates} onClose={() => setAdding(false)} onDone={id => { setAdding(false); reload().then(() => setView({ page: "client", id, tab: "import" })); }} />}
    {toast.el}
  </>;
}

function AddClient({ templates, onClose, onDone }: { templates: { key: string; label: string }[]; onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: "", fullName: "", tin: "", software: "PEAK", template: "service", capThreshold: "10000" });
  const [err, setErr] = useState("");
  const save = async (e: React.FormEvent) => { e.preventDefault(); try { const r = await api<{ id: string }>("/api/clients", { body: { ...f, capThreshold: +f.capThreshold } }); onDone(r.id); } catch (x) { setErr((x as Error).message); } };
  return <div className="modal" role="dialog" aria-modal="true"><form className="mbox form" onSubmit={save}>
    <h2 style={{ margin: 0, fontFamily: "var(--f-display)" }}>เพิ่มลูกค้า</h2>
    <div className="mform">
      <label className="w2">ชื่อที่ใช้เรียก<input className="inp" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></label>
      <label className="w2">ชื่อเต็มตามทะเบียน<input className="inp" value={f.fullName} onChange={e => setF({ ...f, fullName: e.target.value })} /></label>
      <label>เลขผู้เสียภาษี<input className="inp num" inputMode="numeric" maxLength={13} value={f.tin} onChange={e => setF({ ...f, tin: e.target.value })} /></label>
      <label>โปรแกรมบัญชี<select className="inp" value={f.software} onChange={e => setF({ ...f, software: e.target.value })}>{["PEAK", "Express", "FlowAccount", "Excel"].map(s => <option key={s}>{s}</option>)}</select></label>
      <label>ผังบัญชีตั้งต้น<select className="inp" value={f.template} onChange={e => setF({ ...f, template: e.target.value })}>{templates.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
      <label>บันทึกเป็นสินทรัพย์ตั้งแต่ (บาท)<input className="inp num" inputMode="decimal" value={f.capThreshold} onChange={e => setF({ ...f, capThreshold: e.target.value })} /></label>
    </div>
    <small className="muted">นำเข้าผังบัญชีจริงจากโปรแกรมของลูกค้าได้ภายหลังในหน้าผังบัญชีและกฎ</small>
    {err && <div className="err">{err}</div>}
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" type="button" onClick={onClose}>ยกเลิก</button><button className="btn pri">เพิ่มลูกค้า</button></div>
  </form></div>;
}

function Board({ month, open, empty, onDemo }: { month: string; open: (id: string, tab?: Tab) => void; empty: boolean; onDemo: () => void }) {
  const [channel, setChannel] = useState<"e" | "p">("e");
  const [data, setData] = useState<{ clients: { id: string; name: string; software: string; docs: number; attention: number; obligations: { form: string; due: string; moved: string; status: string }[] }[] } | null>(null);
  useEffect(() => { api(`/api/board?month=${month}&channel=${channel}`).then(setData); }, [month, channel]);
  const FORMS = ["ภ.พ.30", "ภ.ง.ด.3", "ภ.ง.ด.53", "ภ.ง.ด.54", "ภ.พ.36"];
  const all = data ? data.clients.flatMap(c => c.obligations) : [];
  const dueOf = (f: string) => all.find(o => o.form === f);
  const open_ = all.filter(o => o.status !== "filed" && o.status !== "paid").map(o => o.due).sort();
  if (empty) return <div className="card"><div className="empty"><p>ยังไม่มีลูกค้า เพิ่มลูกค้าจากเมนูด้านซ้าย หรือลองด้วยข้อมูลตัวอย่าง</p><button className="btn pri" type="button" onClick={onDemo}>ใส่ข้อมูลตัวอย่าง 2 ลูกค้า</button></div></div>;
  return <>
    <div className="kpis">
      <div className="kpi"><small>ลูกค้า</small><b>{data?.clients.length ?? "…"}</b><small>เดือนภาษี {thMonth(month)}</small></div>
      <div className="kpi"><small>แบบที่ต้องยื่น</small><b>{all.length}</b><small>ยื่นแล้ว {all.filter(o => o.status === "filed" || o.status === "paid").length}</small></div>
      <div className="kpi"><small>พร้อมยื่น</small><b style={{ color: "var(--ledger)" }}>{all.filter(o => o.status === "ready").length}</b><small>กำลังตรวจ {all.filter(o => o.status === "review").length} · รอเอกสาร {all.filter(o => o.status === "waiting").length}</small></div>
      <div className="kpi"><small>กำหนดยื่นถัดไป</small><b style={{ color: "var(--amber)" }}>{open_[0] ? thDate(open_[0]) : "—"}</b><small>ช่องทาง{channel === "e" ? "ออนไลน์" : "กระดาษ"}</small></div>
    </div>
    <div className="card"><div className="card-h"><h2>กระดานกำหนดยื่น · {thMonth(month)}</h2><div className="chips"><button type="button" aria-pressed={channel === "e"} onClick={() => setChannel("e")}>ยื่นออนไลน์</button><button type="button" aria-pressed={channel === "p"} onClick={() => setChannel("p")}>ยื่นกระดาษ</button></div></div>
      <div className="scroll-x"><table className="t board"><thead><tr><th>ลูกค้า</th>{FORMS.map(f => { const d = dueOf(f); return <th key={f}>{f}{d && <small>{thDate(d.due)}{d.moved && ` · เลื่อนจาก${d.moved}`}</small>}</th>; })}<th>ต้องดู</th></tr></thead>
        <tbody>{data?.clients.map(c => <tr key={c.id}><td style={{ minWidth: 190 }}><button className="btn sm" type="button" onClick={() => open(c.id)}>{c.name}</button><small className="muted" style={{ display: "block" }}>{c.software} · เอกสาร {c.docs}</small></td>
          {FORMS.map(f => { const o = c.obligations.find(x => x.form === f); return <td key={f}>{o ? <button type="button" style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }} onClick={() => open(c.id, o.status === "ready" ? "export" : "review")}><span className={`ob ${o.status}`}>{OB_L[o.status]}</span></button> : <span className="muted">—</span>}</td>; })}
          <td>{c.attention ? <span className="pill a">{c.attention} ใบ</span> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>
      <div className="card-b"><small className="muted">วันครบกำหนดคำนวณจากช่องทางยื่น ถ้าตรงวันหยุดสุดสัปดาห์เลื่อนเป็นวันทำการถัดไป สถานะคำนวณจากเอกสารจริง ภ.ง.ด.1 และประกันสังคมจะเพิ่มเมื่อมีโมดูลเงินเดือน</small></div></div>
  </>;
}

function ClientView({ clientId, month, tab, ai, toast, onChange, setTab }: { clientId: string; month: string; tab: Tab; ai: boolean; toast: (m: string, e?: boolean) => void; onChange: () => void; setTab: (t: Tab) => void }) {
  const [docs, setDocs] = useState<DocA[]>([]);
  const [info, setInfo] = useState<{ client: any; accounts: Account[]; vendorRules: Record<string, { code: string; n: number; src: string }> } | null>(null);
  const reload = useCallback(async () => {
    const [d, i] = await Promise.all([api<{ docs: DocA[] }>(`/api/clients/${clientId}/documents?month=${month}`), api(`/api/clients/${clientId}`)]);
    setDocs(d.docs); setInfo(i);
  }, [clientId, month]);
  useEffect(() => { reload(); }, [reload]);
  const run = useCallback(async (p: Promise<any>, ok?: string) => { try { await p; if (ok) toast(ok); await reload(); onChange(); } catch (e) { toast((e as Error).message, true); } }, [reload, onChange, toast]);
  if (!info) return <div className="empty">กำลังโหลด…</div>;
  if (tab === "review") return <Review docs={docs} accounts={info.accounts} month={month} clientId={clientId} ai={ai} run={run} toast={toast} />;
  if (tab === "import") return <Import clientId={clientId} month={month} ai={ai} run={run} done={() => setTab("review")} />;
  if (tab === "accounts") return <Accounts info={info} clientId={clientId} run={run} />;
  if (tab === "export") return <Export clientId={clientId} month={month} software={info.client.software} run={run} toast={toast} />;
  return <Log clientId={clientId} />;
}

function Review({ docs, accounts, month, clientId, ai, run, toast }: { docs: DocA[]; accounts: Account[]; month: string; clientId: string; ai: boolean; run: (p: Promise<any>, ok?: string) => Promise<void>; toast: (m: string, e?: boolean) => void }) {
  const [filter, setFilter] = useState<"all" | "attention" | "ready" | "confirmed" | "dup">("all");
  const [sel, setSel] = useState<string | null>(null);
  const k = useMemo(() => {
    const c = { all: docs.length, new: 0, attention: 0, ready: 0, confirmed: 0, dup: 0, high: 0 };
    for (const d of docs) { const a = d.a; if (d.status === "new") c.new++; else if (d.status === "confirmed") c.confirmed++; else if (a?.dupOf) c.dup++; else if (a?.review || d.status === "requested") c.attention++; else { c.ready++; if ((a?.conf || 0) >= 90) c.high++; } }
    return c;
  }, [docs]);
  const list = docs.filter(d => filter === "all" ? true : filter === "attention" ? d.status !== "new" && d.status !== "confirmed" && !d.a?.dupOf && (d.a?.review || d.status === "requested") : filter === "ready" ? d.status === "ready" && !d.a?.dupOf && !d.a?.review : filter === "confirmed" ? d.status === "confirmed" : !!d.a?.dupOf);
  const cur = list.find(d => d.id === sel) || list[0];
  const confirm = (d: DocA) => run(api(`/api/documents/${d.id}/confirm`, { body: {} }), `ยืนยันแล้ว · ${d.vendor}`).then(() => { const i = list.findIndex(x => x.id === d.id); setSel(list.slice(i + 1).find(x => x.status !== "confirmed" && !x.a?.dupOf)?.id || null); });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/INPUT|SELECT|TEXTAREA/.test((e.target as HTMLElement).tagName) || !cur) return;
      const i = list.findIndex(d => d.id === cur.id);
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((list[i + 1] || cur).id); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((list[i - 1] || cur).id); }
      else if (e.key === "Enter" && cur.status === "ready" && cur.a && !cur.a.dupOf && !cur.a.blocks) { e.preventDefault(); confirm(cur); }
    };
    addEventListener("keydown", h); return () => removeEventListener("keydown", h);
  });
  return <div className="layout"><div className="card">
    <div className="card-h"><h2>ตรวจและจัดประเภท · {thMonth(month)}</h2><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {k.new > 0 && <button className="btn pri" type="button" onClick={() => run(api(`/api/clients/${clientId}/process`, { body: { month } }), `ประมวลผล ${k.new} เอกสาร`)}>ตรวจและจัดประเภท {k.new} เอกสาร</button>}
      <button className="btn" type="button" disabled={!k.high} onClick={() => run(api(`/api/clients/${clientId}/confirm-high`, { body: { month } }), "ยืนยันรายการที่ไม่มีคำเตือนและมั่นใจ 90% ขึ้นไปแล้ว")}>ยืนยันที่มั่นใจ 90% ขึ้นไป ({k.high})</button></div></div>
    <div className="card-b" style={{ paddingBottom: 6 }}><div className="chips">{([["all", "ทั้งหมด", k.all], ["attention", "ต้องดู", k.attention], ["ready", "รอยืนยัน", k.ready], ["confirmed", "ยืนยันแล้ว", k.confirmed], ["dup", "ซ้ำ", k.dup]] as const).map(([f, l, n]) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{l} {n}</button>)}</div></div>
    <div className="scroll-x"><table className="t"><thead><tr><th>#</th><th>เอกสาร</th><th className="r">ยอดรวม</th><th>ผลตรวจ</th><th>รหัสบัญชีที่เสนอ · มั่นใจ</th><th>สถานะ</th></tr></thead><tbody>
      {list.length ? list.map(d => <Row key={d.id} d={d} sel={cur?.id === d.id} accounts={accounts} onSel={() => setSel(d.id)} onCode={code => run(api(`/api/documents/${d.id}/code`, { body: { code } }), `จำไว้แล้ว: ${d.vendor} → ${code}`)} />) : <tr><td colSpan={6}><div className="empty">ไม่มีเอกสารในมุมมองนี้ {docs.length === 0 && "· ไปที่นำเข้าเอกสารเพื่อเพิ่มเอกสารแรก"}</div></td></tr>}
    </tbody></table></div></div>
    <aside className="drawer">{cur ? <Drawer d={cur} accounts={accounts} ai={ai} run={run} toast={toast} confirm={() => confirm(cur)} /> : <div className="card"><div className="empty">เลือกเอกสาร</div></div>}</aside></div>;
}

function stateOf(d: DocA): [string, string] {
  if (d.status === "new") return ["ยังไม่ประมวลผล", ""];
  if (d.status === "confirmed") return [d.exported ? "ส่งออกแล้ว" : "ยืนยันแล้ว", d.exported ? "b" : "g"];
  if (d.status === "requested") return ["ขอเอกสารใหม่แล้ว", "a"];
  const a = d.a!; if (a.dupOf) return ["ซ้ำ · ข้าม", ""]; if (a.blocks) return ["ติดปัญหา", "r"]; if (a.review) return ["ให้คนตรวจ", "a"]; return ["รอยืนยัน", ""];
}
function Row({ d, sel, accounts, onSel, onCode }: { d: DocA; sel: boolean; accounts: Account[]; onSel: () => void; onCode: (c: string) => void }) {
  const [st, cls] = stateOf(d), a = d.a;
  const vend = <td className="vend"><b>{d.vendor}</b><small>{d.desc} · {d.no} · {thDate(d.date)}<span className="src">{d.src}</span></small></td>;
  if (!a) return <tr className={`row ${sel ? "sel" : ""}`} onClick={onSel}><td className="num">{d.seq}</td>{vend}<td className="r num">{baht(d.base + d.vat)}</td><td colSpan={2}><span className="muted">รอประมวลผล</span></td><td><span className="pill">{st}</span></td></tr>;
  const fs = a.findings.filter(f => f.sev !== "ok"), lo = a.conf < 85 && !d.code;
  return <tr className={`row ${sel ? "sel" : ""} ${a.dupOf ? "dup" : ""}`} onClick={onSel}><td className="num">{d.seq}</td>{vend}<td className="r num">{baht(d.base + d.vat)}</td>
    <td><div className="find">{fs.length ? fs.slice(0, 3).map((f, i) => <span key={i} className={`pill ${f.sev === "block" ? "r" : f.sev === "warn" ? "a" : "b"}`} title={f.text}>{f.sev === "block" ? "ติด" : f.sev === "warn" ? "เตือน" : "ข้อมูล"}: {f.text.slice(0, 22)}{f.text.length > 22 ? "…" : ""}</span>) : <span className="pill g">ผ่านทุกข้อ</span>}</div></td>
    <td className="codecell" onClick={e => e.stopPropagation()}>{a.dupOf ? <span className="muted">—</span> : <>
      <select aria-label={`รหัสบัญชี ${d.vendor}`} value={a.code || ""} disabled={d.exported} onChange={e => onCode(e.target.value)}>{accounts.map(x => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}</select>
      <div className="cf">{d.code && d.codeEdited ? <span className="pill b">แก้โดยผู้ทำบัญชี</span> : <><span className={`conf ${lo ? "lo" : ""}`}><i style={{ width: `${a.conf}%` }} /></span><span className="num">{a.conf}%</span></>}</div>
      <small>{d.codeEdited ? "จำไว้สำหรับผู้ขายรายนี้" : a.sugg[0]?.why}</small></>}</td>
    <td><span className={`pill ${cls}`}>{st}</span></td></tr>;
}

function Drawer({ d, accounts, ai, run, toast, confirm }: { d: DocA; accounts: Account[]; ai: boolean; run: (p: Promise<any>, ok?: string) => Promise<void>; toast: (m: string, e?: boolean) => void; confirm: () => void }) {
  const a = d.a, [edit, setEdit] = useState(false), [aiOut, setAiOut] = useState<string | { code: string; confidence: number; reason: string } | null>(null);
  const name = (c: string) => accounts.find(x => x.code === c)?.name || "";
  useEffect(() => { setEdit(false); setAiOut(null); }, [d.id]);
  if (edit) return <EditDoc d={d} onCancel={() => setEdit(false)} onSave={body => run(api(`/api/documents/${d.id}`, { method: "PATCH", body }), "บันทึกการแก้ไขแล้ว").then(() => setEdit(false))} />;
  return <div className="card"><div className="card-h"><h2 style={{ fontSize: "1rem" }}>{d.vendor}</h2><span className="pill">{TYPE_L[d.type]}</span></div><div className="card-b">
    <dl className="kv"><dt>เลขที่</dt><dd>{d.no}</dd><dt>วันที่</dt><dd>{thDate(d.date)}</dd><dt>เลขผู้เสียภาษี</dt><dd className="num">{d.tin ? maskTin(d.tin) : "—"}</dd><dt>รายการ</dt><dd>{d.desc}</dd><dt>มูลค่า · VAT</dt><dd className="num">{baht(d.base)} · {baht(d.vat)}</dd>{d.wht > 0 && <><dt>หัก ณ ที่จ่าย</dt><dd className="num">{baht(d.wht)} {a?.whtForm}</dd></>}<dt>ที่มา</dt><dd>{d.src}{d.hasFile && <> · <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noopener">ดูไฟล์ต้นฉบับ</a></>}</dd></dl>
    {a && <><div className="sec"><h3>ผลตรวจ</h3><div className="fl">{a.findings.map((f, i) => <div key={i}><span className={`sev ${f.sev}`}>{{ ok: "ผ่าน", warn: "เตือน", block: "ติด", info: "ข้อมูล" }[f.sev]}</span><span>{f.text}</span></div>)}</div></div>
      {!a.dupOf && <div className="sec"><h3>รหัสบัญชีที่เสนอ · ผลต่อการบันทึก</h3>
        <div className="alts">{a.sugg.slice(0, 3).map(s => <button key={s.code} type="button" className={s.code === a.code ? "on" : ""} disabled={d.exported} onClick={() => run(api(`/api/documents/${d.id}/code`, { body: { code: s.code } }), `จำไว้แล้ว: ${d.vendor} → ${s.code}`)}><span><b>{s.code}</b> {name(s.code)}</span><span className="num">{s.score}%</span><small>{s.why}</small></button>)}</div>
        <dl className="kv" style={{ marginTop: 10 }}><dt>Dr {a.code}</dt><dd className="num">{baht(a.expense)}</dd>{a.claimVat && <><dt>Dr ภาษีซื้อ</dt><dd className="num">{baht(d.vat)}</dd></>}{d.wht > 0 && <><dt>Cr WHT ค้างจ่าย</dt><dd className="num">{baht(d.wht)}</dd></>}<dt>Cr เจ้าหนี้</dt><dd className="num">{baht(a.expense + (a.claimVat ? d.vat : 0) - d.wht)}</dd></dl>
        {ai && <><button className="btn" type="button" style={{ marginTop: 10 }} disabled={d.exported} onClick={async () => { setAiOut("กำลังถาม AI…"); try { setAiOut(await api(`/api/documents/${d.id}/ai-suggest`, { body: {} })); } catch (e) { setAiOut((e as Error).message); } }}>ถาม AI ให้เสนอรหัส</button>
          {aiOut && <div className="ai-out">{typeof aiOut === "string" ? aiOut : <>AI เสนอ <b>{aiOut.code} {name(aiOut.code)}</b> ({aiOut.confidence}%)<br />{aiOut.reason}<br /><button className="btn sm" type="button" style={{ marginTop: 6 }} onClick={() => run(api(`/api/documents/${d.id}/code`, { body: { code: aiOut.code } }), "ใช้รหัสที่ AI เสนอแล้ว")}>ใช้รหัสนี้</button></>}</div>}</>}
      </div>}</>}
    <div className="sec" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {d.status === "ready" && a && !a.dupOf && !a.blocks && <button className="btn pri" type="button" onClick={confirm}>ยืนยัน <span className="kbd">Enter</span></button>}
      {d.status === "ready" && a && !a.dupOf && a.blocks > 0 && <><button className="btn" type="button" onClick={() => run(api(`/api/documents/${d.id}/request`, { body: {} }), "บันทึกว่าขอเอกสารใหม่แล้ว")}>ขอเอกสารใหม่</button><button className="btn" type="button" onClick={confirm}>ยืนยันเป็นค่าใช้จ่าย ไม่หักภาษีซื้อ</button></>}
      {d.status === "confirmed" && !d.exported && <button className="btn" type="button" onClick={() => run(api(`/api/documents/${d.id}/unconfirm`, { body: {} }))}>ยกเลิกการยืนยัน</button>}
      {d.status !== "confirmed" && <button className="btn" type="button" onClick={() => setEdit(true)}>แก้ไขข้อมูลเอกสาร</button>}
    </div></div></div>;
}

function EditDoc({ d, onCancel, onSave }: { d: DocA; onCancel: () => void; onSave: (b: any) => void }) {
  const [f, setF] = useState({ date: d.date, no: d.no, vendor: d.vendor, tin: d.tin, buyerTin: d.buyerTin, desc: d.desc, base: (d.base / 100).toFixed(2), vat: (d.vat / 100).toFixed(2), wht: (d.wht / 100).toFixed(2), type: d.type, vatReg: d.vatReg });
  const s = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  return <form className="card" onSubmit={e => { e.preventDefault(); onSave({ ...f, base: toSatang(f.base), vat: toSatang(f.vat), wht: toSatang(f.wht) }); }}><div className="card-h"><h2 style={{ fontSize: "1rem" }}>แก้ไขข้อมูลเอกสาร</h2></div><div className="card-b mform">
    <label>ประเภท<select className="inp" value={f.type} onChange={s("type")}>{Object.entries(TYPE_L).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
    <label>วันที่<input className="inp" type="date" value={f.date} onChange={s("date")} /></label>
    <label className="w2">ผู้ขาย<input className="inp" value={f.vendor} onChange={s("vendor")} /></label>
    <label>เลขผู้เสียภาษีผู้ขาย<input className="inp num" value={f.tin} onChange={s("tin")} maxLength={13} /></label>
    <label>เลขที่<input className="inp" value={f.no} onChange={s("no")} /></label>
    <label className="w2">เลขผู้เสียภาษีผู้ซื้อ (ลูกค้า)<input className="inp num" value={f.buyerTin} onChange={s("buyerTin")} maxLength={13} /></label>
    <label className="w2">รายการ<input className="inp" value={f.desc} onChange={s("desc")} /></label>
    <label>มูลค่า<input className="inp num" value={f.base} onChange={s("base")} /></label>
    <label>VAT<input className="inp num" value={f.vat} onChange={s("vat")} /></label>
    <label>หัก ณ ที่จ่าย<input className="inp num" value={f.wht} onChange={s("wht")} /></label>
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.vatReg} onChange={s("vatReg")} /> ผู้ขายจด VAT</label>
    <div className="w2" style={{ display: "flex", gap: 8 }}><button className="btn pri">บันทึก</button><button className="btn" type="button" onClick={onCancel}>ยกเลิก</button></div>
  </div></form>;
}

const SAMPLE = `วันที่\tเลขที่\tผู้ขาย\tเลขผู้เสียภาษี\tรายการ\tมูลค่า\tVAT\tหัก ณ ที่จ่าย
02/10/2569\tPK-6910-221\tบจ. กล่องกระดาษไทย\t0999999000322\tถุงขยะดำ 20 แพ็ค\t3500\t245\t0
15/10/2569\tLW-2569-15\tบจ. สำนักงานกฎหมายนิติธรรม\t0999999000331\tค่าที่ปรึกษากฎหมาย ต.ค.\t20000\t1400\t600`;
function Import({ clientId, month, ai, run, done }: { clientId: string; month: string; ai: boolean; run: (p: Promise<any>, ok?: string) => Promise<void>; done: () => void }) {
  const [txt, setTxt] = useState(""), [busy, setBusy] = useState(false);
  const p = useMemo(() => (txt.trim() ? parseTable(txt) : null), [txt]);
  const LAB: Record<string, string> = { date: "วันที่", no: "เลขที่", vendor: "ผู้ขาย", tin: "เลขผู้เสียภาษี", desc: "รายการ", base: "มูลค่า", vat: "VAT", wht: "หัก ณ ที่จ่าย" };
  const [m, setM] = useState({ type: "full", date: `${month}-28`, vendor: "", tin: "", no: "", desc: "", base: "", vat: "", wht: "0" });
  const importRows = () => {
    if (!p) return;
    const g = (r: string[], f: string) => (f in p.map ? (r[p.map[f]] || "").trim() : "");
    const rows = p.rows.map(r => ({ date: toIso(g(r, "date"), `${month}-28`), no: g(r, "no") || "-", vendor: g(r, "vendor"), tin: g(r, "tin").replace(/\D/g, ""), desc: g(r, "desc") || "-", base: toSatang(g(r, "base")), vat: toSatang(g(r, "vat")), wht: toSatang(g(r, "wht")), type: toSatang(g(r, "vat")) > 0 ? "full" : "cash" })).filter(r => r.vendor);
    run(api(`/api/clients/${clientId}/documents`, { body: { month, docs: rows, src: "Excel" } }), `นำเข้า ${rows.length} รายการแล้ว`).then(() => { setTxt(""); done(); });
  };
  const upload = async (file: File) => { setBusy(true); const fd = new FormData(); fd.append("file", file); fd.append("month", month); await run(api(`/api/clients/${clientId}/upload`, { form: fd }), "AI อ่านเอกสารแล้ว เข้าคิวตรวจ"); setBusy(false); done(); };
  return <div className="grid2">
    <div className="card"><div className="card-h"><h2>วางจาก Excel หรือ Google Sheets</h2><button className="btn sm" type="button" onClick={() => setTxt(SAMPLE)}>ใส่ข้อมูลตัวอย่าง</button></div><div className="card-b form">
      <input type="file" accept=".csv,.tsv,.txt" aria-label="ไฟล์ CSV" onChange={e => { const f = e.target.files?.[0]; if (f) f.text().then(setTxt); }} />
      <textarea className="inp" aria-label="ตาราง" placeholder="วางตารางที่นี่ บรรทัดแรกเป็นหัวตาราง" value={txt} onChange={e => setTxt(e.target.value)} />
      {p && <><div className="maprow">{Object.keys(LAB).map(f => f in p.map ? <span key={f}>{p.head[p.map[f]]} → {LAB[f]}</span> : <span key={f} className="miss">{LAB[f]}: ไม่พบ</span>)}</div>
        <button className="btn pri" type="button" disabled={!("vendor" in p.map && "base" in p.map)} onClick={importRows}>นำเข้า {p.rows.length} รายการ</button></>}
      <small className="muted">จับคู่หัวตารางไทยหรืออังกฤษอัตโนมัติ วันที่รับได้ทั้ง พ.ศ. และ ค.ศ.</small></div></div>
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <div className="card"><div className="card-h"><h2>อัปโหลดรูปหรือ PDF ให้ AI อ่าน</h2></div><div className="card-b form">{ai ? <><input type="file" accept="image/*,application/pdf" disabled={busy} aria-label="รูปใบเสร็จ" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} /><small className="muted">{busy ? "กำลังอ่าน…" : "ไฟล์ต้นฉบับเก็บไว้ในระบบ ผล AI เข้าคิวตรวจด้วยกฎชุดเดียวกัน และคนต้องยืนยันทุกตัวเลข"}</small></> : <small className="muted">ยังไม่ได้ตั้งค่า GEMINI_API_KEY ของระบบ จึงยังอ่านรูปด้วย AI ไม่ได้ ใช้การวางตารางหรือเพิ่มเองไปก่อน</small>}</div></div>
      <form className="card" onSubmit={e => { e.preventDefault(); const base = toSatang(m.base); run(api(`/api/clients/${clientId}/documents`, { body: { month, src: "เพิ่มเอง", docs: [{ ...m, base, vat: m.vat === "" ? (["full", "etax", "abb"].includes(m.type) ? vatOf(base) : 0) : toSatang(m.vat), wht: toSatang(m.wht) }] } }), "เพิ่มเอกสารแล้ว").then(done); }}>
        <div className="card-h"><h2>เพิ่มเอกสารเอง</h2></div><div className="card-b mform">
          <label>ประเภท<select className="inp" value={m.type} onChange={e => setM({ ...m, type: e.target.value })}>{Object.entries(TYPE_L).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>วันที่<input className="inp" type="date" value={m.date} onChange={e => setM({ ...m, date: e.target.value })} /></label>
          <label className="w2">ผู้ขาย<input className="inp" required value={m.vendor} onChange={e => setM({ ...m, vendor: e.target.value })} /></label>
          <label>เลขผู้เสียภาษี<input className="inp num" maxLength={13} value={m.tin} onChange={e => setM({ ...m, tin: e.target.value })} /></label>
          <label>เลขที่<input className="inp" value={m.no} onChange={e => setM({ ...m, no: e.target.value })} /></label>
          <label className="w2">รายการ<input className="inp" value={m.desc} onChange={e => setM({ ...m, desc: e.target.value })} /></label>
          <label>มูลค่า<input className="inp num" required value={m.base} onChange={e => setM({ ...m, base: e.target.value })} /></label>
          <label>VAT<input className="inp num" placeholder="ว่าง = 7%" value={m.vat} onChange={e => setM({ ...m, vat: e.target.value })} /></label>
          <label>หัก ณ ที่จ่าย<input className="inp num" value={m.wht} onChange={e => setM({ ...m, wht: e.target.value })} /></label>
          <div className="w2"><button className="btn pri">เพิ่มเข้าคิวตรวจ</button></div></div></form>
    </div></div>;
}

function Accounts({ info, clientId, run }: { info: { client: any; accounts: Account[]; vendorRules: Record<string, { code: string; n: number; src: string }> }; clientId: string; run: (p: Promise<any>, ok?: string) => Promise<void> }) {
  const [coa, setCoa] = useState(""), [cap, setCap] = useState(String(info.client.capThreshold / 100)), [asset, setAsset] = useState(info.client.assetCode);
  return <div className="grid2">
    <div className="card"><div className="card-h"><h2>ผังบัญชีของลูกค้า</h2><span className="muted">{info.accounts.length} รหัส · {info.client.software}</span></div>
      <div className="scroll-x"><table className="t"><thead><tr><th>รหัส</th><th>ชื่อบัญชี</th><th>คำที่ใช้จับคู่</th></tr></thead><tbody>{info.accounts.map(a => <tr key={a.code}><td className="num">{a.code}</td><td>{a.name}</td><td><small className="muted">{a.keywords.split("|").filter(Boolean).join(", ") || "—"}</small></td></tr>)}</tbody></table></div>
      <div className="card-b form"><b style={{ fontSize: ".85rem" }}>นำเข้าผังบัญชีที่ส่งออกจาก {info.client.software}</b><textarea className="inp" style={{ minHeight: 90 }} placeholder="รหัส,ชื่อบัญชี บรรทัดละหนึ่งบัญชี" value={coa} onChange={e => setCoa(e.target.value)} aria-label="ผังบัญชี" />
        <div><button className="btn" type="button" onClick={() => { const accounts = coa.split("\n").map(l => l.split(/[,\t]/).map(s => s.trim())).filter(a => a[0] && a[1]).map(([code, name]) => ({ code, name })); run(api(`/api/clients/${clientId}/accounts`, { method: "PUT", body: { accounts } }), `นำเข้าผังบัญชี ${accounts.length} รหัส`).then(() => setCoa("")); }}>แทนที่ผังบัญชี</button></div></div></div>
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <div className="card"><div className="card-h"><h2>กฎของลูกค้า</h2></div><div className="card-b form">
        <label>บันทึกเป็นสินทรัพย์เมื่อราคาตั้งแต่ (บาท)<input className="inp num" value={cap} onChange={e => setCap(e.target.value)} /></label>
        <label>รหัสบัญชีสินทรัพย์<select className="inp" value={asset} onChange={e => setAsset(e.target.value)}>{info.accounts.map(a => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
        <div><button className="btn" type="button" onClick={() => run(api(`/api/clients/${clientId}`, { method: "PATCH", body: { capThreshold: toSatang(cap), assetCode: asset } }), "บันทึกกฎแล้ว")}>บันทึกกฎ</button></div></div></div>
      <div className="card"><div className="card-h"><h2>ผู้ขายที่ระบบจำไว้</h2><span className="muted">{Object.keys(info.vendorRules).length} ราย</span></div>
        <div className="scroll-x"><table className="t"><thead><tr><th>ผู้ขาย</th><th>รหัส</th><th>ที่มา</th><th /></tr></thead><tbody>{Object.entries(info.vendorRules).map(([v, r]) => <tr key={v}><td>{v}</td><td className="num">{r.code}</td><td>{r.src === "edit" ? <span className="pill b">ผู้ทำบัญชีกำหนด</span> : <span className="pill">ประวัติ {r.n} ครั้ง</span>}</td><td><button className="btn sm" type="button" onClick={() => run(api(`/api/clients/${clientId}/vendor-rules?key=${encodeURIComponent(v)}`, { method: "DELETE", body: {} }), "ลบกฎแล้ว")}>ลืม</button></td></tr>)}</tbody></table></div></div>
    </div></div>;
}

function Export({ clientId, month, software, run, toast }: { clientId: string; month: string; software: string; run: (p: Promise<any>, ok?: string) => Promise<void>; toast: (m: string, e?: boolean) => void }) {
  const [fmt, setFmt] = useState<"peak" | "jv">("peak"), [pv, setPv] = useState<{ count: number; table: string[][] } | null>(null);
  useEffect(() => { api(`/api/clients/${clientId}/export`, { body: { month, format: fmt, preview: true } }).then(setPv); }, [clientId, month, fmt]);
  const go = async () => {
    try {
      const r = await api<{ csv: string; filename: string; count: number }>(`/api/clients/${clientId}/export`, { body: { month, format: fmt } });
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" })), a = document.createElement("a");
      a.href = url; a.download = r.filename; a.click(); URL.revokeObjectURL(url);
      toast(`ส่งออก ${r.count} รายการแล้ว`); await run(Promise.resolve()); setPv(await api(`/api/clients/${clientId}/export`, { body: { month, format: fmt, preview: true } }));
    } catch (e) { toast((e as Error).message, true); }
  };
  return <div className="card"><div className="card-h"><h2>ส่งออก · {thMonth(month)}</h2><div className="chips"><button type="button" aria-pressed={fmt === "peak"} onClick={() => setFmt("peak")}>ไฟล์นำเข้า PEAK (ตัวอย่างโครงสร้าง)</button><button type="button" aria-pressed={fmt === "jv"} onClick={() => setFmt("jv")}>สมุดรายวัน เดบิต เครดิต</button></div></div>
    <div className="card-b">{!pv ? "กำลังโหลด…" : pv.count ? <>
      <p style={{ marginTop: 0 }}>{pv.count} รายการที่ยืนยันแล้วและยังไม่เคยส่งออก · {pv.table.length - 1} แถว · ลูกค้าใช้ {software}</p>
      <div className="scroll-x"><table className="t"><thead><tr>{pv.table[0].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{pv.table.slice(1).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={/^-?\d+\.\d\d$/.test(v) ? "r num" : ""}>{/^-?\d+\.\d\d$/.test(v) ? (+v).toLocaleString("en-US", { minimumFractionDigits: 2 }) : maskTin(v)}</td>)}</tr>)}</tbody></table></div>
      <div style={{ marginTop: 12 }}><button className="btn pri" type="button" onClick={go}>ส่งออกและดาวน์โหลด CSV</button></div>
      <small className="muted" style={{ display: "block", marginTop: 8 }}>คอลัมน์ไฟล์ PEAK เป็นตัวอย่างโครงสร้าง ต้องตั้งให้ตรงกับแม่แบบนำเข้าจริงก่อนใช้งาน ไฟล์มีเลขผู้เสียภาษีเต็ม หน้าจอแสดงแบบปิดบัง รายการที่ส่งออกแล้วจะไม่ถูกส่งซ้ำ</small></>
      : <div className="empty">ยังไม่มีรายการที่ยืนยันแล้วและรอส่งออก</div>}</div></div>;
}

function Log({ clientId }: { clientId: string }) {
  const [log, setLog] = useState<{ at: string; user_name: string; action: string }[] | null>(null);
  useEffect(() => { api(`/api/clients/${clientId}/audit`).then(r => setLog(r.log)); }, [clientId]);
  return <div className="card"><div className="card-h"><h2>ประวัติการทำงาน</h2><span className="muted">บันทึกแบบเพิ่มอย่างเดียว แก้ไขไม่ได้</span></div><div className="card-b">{!log ? "กำลังโหลด…" : log.length ? <div className="tl">{log.map((l, i) => <div key={i}><span className="num muted">{l.at.replace("T", " ").slice(0, 16)} UTC</span><b>{l.user_name}</b><span>{l.action}</span></div>)}</div> : <div className="empty">ยังไม่มีประวัติ</div>}</div></div>;
}

export { ApiError };
