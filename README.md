# ปิดงวด (Pidngod), by bancheesolution

The monthly workbench for Thai bookkeepers and small accounting firms. It checks documents against the Revenue Code, catches duplicates, suggests account codes from each client's own chart of accounts, learns from corrections, and exports files for PEAK or a debit/credit journal.

Stack: **Cloudflare Workers** (Hono API + static React app), **D1** (database) and **R2** (original documents). The AI is **Gemini**, called server-side only.

## What works (v0.1, core loop)
- **Accounts and access:** email + password sign-up and login.
  - Firms are isolated from each other: every query is scoped to the signed-in firm.
  - Sessions are HttpOnly cookies that expire after 12 hours idle.
  - Passwords are hashed with PBKDF2.
  - Login is rate-limited, and there is a CSRF header check.
- **Clients:** create a client with a starter chart of accounts (service, restaurant, construction), or import the real chart (`code,name`). Set the capitalisation rule.
- **Documents:** paste from Excel/Google Sheets or CSV (Thai/English headers auto-mapped; BE and CE dates), add by hand, or upload a photo or PDF. With a Gemini key, AI reads the upload; the original is stored in R2.
- **Checks** (shared engine in `src/engine`, unit-tested):
  - TIN check digit
  - buyer TIN (s.86/4)
  - seller VAT registration
  - VAT 7%
  - 6-month window
  - duplicates
  - disallowed input VAT folded into the expense
  - PP36 for foreign services
  - WHT rate and form (PND3/53/54)
  - "WHT may be required" hints
- **Account codes:** suggested in this order: vendor history → capitalisation rule → keywords → fallback. Each comes with a reason and a confidence.
  - Corrections teach a per-client vendor rule.
  - Optional "Ask AI" (Gemini) only accepts codes that exist in the chart.
- **Review queue:** filters; ↑ ↓ Enter; bulk-confirm only clean documents with ≥90% confidence; edit a document; request a new one.
- **Export:** PEAK import-file layout (**sample columns; match to the real PEAK template before production use**) or a debit/credit journal. Rows are never exported twice.
- **Deadline board:** PP30, PND3/53/54 and PP36 per client, with due dates for online or paper filing (weekends moved), statuses computed from documents, and filed/paid marking via the API.
- **Audit log:** append-only, per client.
- **Money** is stored as integer satang everywhere.

Not yet: PND1/SSO (payroll), bank reconciliation, the PP30 worksheet UI, 50 ทวิ, LINE, roles beyond owner, the holiday calendar, password reset. See `planning/pidngod/PLAN.md` in the Wutcharin repo for the roadmap.

## Run locally
```bash
npm ci
npm test
cp .dev.vars.example .dev.vars   # optional: add GEMINI_API_KEY for AI features
npm run dev                      # builds the web app, applies local D1 migrations, starts http://localhost:8787
```
Sign up with "ใส่ข้อมูลตัวอย่าง" (add demo data) ticked, then pick เดือนภาษี (tax month) ต.ค. 2569.

## Deploy (Cloudflare free plan)
1. Create the resources once:
   ```bash
   npx wrangler login
   npx wrangler d1 create bancheesolution        # copy the database_id into wrangler.jsonc
   npx wrangler r2 bucket create bancheesolution-files
   npx wrangler secret put GEMINI_API_KEY         # paste the key when prompted
   ```
2. Deploy: `npm run deploy` (migrations + deploy). The app is served at `https://bancheesolution.<your-subdomain>.workers.dev`.
3. Optional automatic deploys: in the GitHub repo settings, add secrets `CLOUDFLARE_API_TOKEN` (with Workers Scripts, D1 and R2 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`, and a repository variable `DEPLOY_ENABLED=true`. Every push to `main` then tests, migrates and deploys.

`GEMINI_MODEL` is set in `wrangler.jsonc`. Check that the model name is current in Google AI Studio.

## Security notes
- The Gemini key lives only in the Worker; the browser never sees it. Document text is treated as data, and model output is validated and always confirmed by a person.
- Individuals' national ID numbers are masked in the UI. Exports contain full numbers, as the RD and PEAK require.
- Before real client data: a PDPA review, a DPA, a pen test, password reset and MFA (see `docs/security-privacy.md` in the planning repo).
