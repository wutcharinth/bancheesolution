-- Pidngod core schema (Cloudflare D1 / SQLite).
-- Every tenant-owned row carries firm_id; the Worker scopes every query by the session's firm (ADR-0002).
-- Money columns are INTEGER satang.

CREATE TABLE firms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  email TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX login_attempts_email ON login_attempts(email, at);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  tin TEXT NOT NULL DEFAULT '',
  software TEXT NOT NULL DEFAULT 'PEAK',
  biz TEXT NOT NULL DEFAULT '',
  cap_threshold INTEGER NOT NULL DEFAULT 1000000,
  asset_code TEXT NOT NULL DEFAULT '',
  misc_code TEXT NOT NULL DEFAULT '',
  vatx_codes TEXT NOT NULL DEFAULT '[]',
  ctrl TEXT NOT NULL DEFAULT '{"vat":"1154","ap":"2110","wht":"2132"}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX clients_firm ON clients(firm_id);

CREATE TABLE accounts (
  client_id TEXT NOT NULL REFERENCES clients(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (client_id, code)
);

CREATE TABLE vendor_rules (
  client_id TEXT NOT NULL REFERENCES clients(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  vendor_key TEXT NOT NULL,
  code TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1,
  src TEXT NOT NULL DEFAULT 'hist',
  PRIMARY KEY (client_id, vendor_key)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  tax_month TEXT NOT NULL,
  seq INTEGER NOT NULL,
  date TEXT NOT NULL,
  no TEXT NOT NULL DEFAULT '-',
  vendor TEXT NOT NULL,
  tin TEXT NOT NULL DEFAULT '',
  buyer_tin TEXT NOT NULL DEFAULT '',
  vat_reg INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '-',
  base INTEGER NOT NULL DEFAULT 0,
  vat INTEGER NOT NULL DEFAULT 0,
  wht INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'full',
  src TEXT NOT NULL DEFAULT 'เพิ่มเอง',
  status TEXT NOT NULL DEFAULT 'new',
  code TEXT,
  code_edited INTEGER NOT NULL DEFAULT 0,
  exported INTEGER NOT NULL DEFAULT 0,
  file_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX documents_client_month ON documents(client_id, tax_month, seq);

CREATE TABLE filings (
  client_id TEXT NOT NULL REFERENCES clients(id),
  firm_id TEXT NOT NULL REFERENCES firms(id),
  tax_month TEXT NOT NULL,
  form TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (client_id, tax_month, form)
);

-- Append-only audit trail (ADR-0007). The app never updates or deletes rows here.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id TEXT NOT NULL,
  client_id TEXT,
  user_id TEXT,
  user_name TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL
);
CREATE INDEX audit_firm_client ON audit(firm_id, client_id, id);
