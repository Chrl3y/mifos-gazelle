# Mifos System Doctor – MCP Server

An **MCP (Model Context Protocol) server** that acts as an intelligent system doctor for Mifos X / Apache Fineract / Helaplus microfinance platform deployments.

It enables any MCP-compatible AI assistant (Claude, etc.) to **audit, scan, track, fix, and scale** activities across the platform in real time.

---

## What It Does

| Tool | Issue(s) Addressed | Description |
|------|--------------------|-------------|
| `audit_gl_mapping` | MF-002, ISS-010 | Audit all loan product GL mappings |
| `scan_standing_instructions` | ISS-006 | Detect pre-deposit auto-pay risks |
| `get_portfolio_snapshot` | RPT-001, RPT-006, ISS-013 | PAR, aging, per-product/officer breakdown |
| `validate_loan_topup` | ISS-001 | Validate top-up loan offset (principal only) |
| `scan_topup_anomalies` | ISS-001 | Find historical top-up miscalculations |
| `reconcile_payments` | ISS-HUB-001 to HUB-006 | Detect misrouted/unposted payments |
| `daily_collection_validation` | RPT-004 | Daily collections vs expected repayments |
| `list_issues` | All | Query the issue register |
| `get_issue` | All | Get full issue detail |
| `update_issue_status` | All | Update issue tracking status |
| `issue_summary` | All | Dashboard: issues by priority/status/domain |
| `systemic_patterns` | All | Major structural weaknesses |

---

## Quick Start

### 1. Install Dependencies

```bash
cd src/mcp-system-doctor
npm install
npm run build
```

### 2. Configure Environment

```bash
export FINERACT_BASE_URL="http://your-helaplus-server:8080/fineract-provider/api/v1"
export FINERACT_TENANT_ID="default"
export FINERACT_USERNAME="mifos"
export FINERACT_PASSWORD="your-password"
```

### 3. Register with Claude Desktop

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mifos-system-doctor": {
      "command": "node",
      "args": ["/path/to/mifos-gazelle/src/mcp-system-doctor/dist/index.js"],
      "env": {
        "FINERACT_BASE_URL": "http://your-server:8080/fineract-provider/api/v1",
        "FINERACT_TENANT_ID": "default",
        "FINERACT_USERNAME": "mifos",
        "FINERACT_PASSWORD": "password"
      }
    }
  }
}
```

### 4. Use in Claude

Once connected, you can ask Claude:

```
"Run a full GL mapping audit across all loan products"
"Check if any standing instructions will fire before deposits are confirmed today"
"Give me a portfolio snapshot with aging breakdown"
"Validate the top-up loan calculation for loan ID 1234 with a proposed amount of 5,000,000 UGX"
"List all CRITICAL issues in the system"
"What are the systemic weaknesses we need to address?"
```

---

## Issue Register

Located at: `docs/issues/issues-register.json`

The register contains **all tracked issues** with:
- Codebase mapping (exact file/class/method)
- Root cause analysis
- Suggested fix
- Priority and status

### Issue Domains

| Domain | Issues |
|--------|--------|
| Core Banking | ISS-001, ISS-004, ISS-006, ISS-010, ISS-011, ISS-013 |
| HUB Reconciliation | ISS-HUB-001, ISS-HUB-002, ISS-HUB-003, ISS-HUB-004, ISS-HUB-006 |
| Helaplus API | MF-001, MF-002 |
| Reporting | RPT-001, RPT-002, RPT-003, RPT-004, RPT-005, RPT-006, RPT-008 |

---

## API Samples

Postman collection at: `docs/api-samples/nova-mifos-api-collection.json`

Import into Postman and set variables:
- `baseUrl`: Your Fineract API base URL
- `tenantId`: Your tenant ID
- `loanId`: Target loan ID

---

## Fix Blueprints

Detailed fix documentation in `docs/fix-blueprints/`:

| Blueprint | Issues |
|-----------|--------|
| `ISS-001-topup-loan-fix.md` | Top-up loan offset bug |
| `ISS-006-standing-instructions-fix.md` | Pre-deposit standing instruction risk |
| `ISS-HUB-payments-controller-fix.md` | All HUB payment processing fixes |
| `MF-002-gl-mapping-fix.md` | GL mapping configuration fix |
| `RPT-reporting-fixes.md` | All reporting enhancements and bugs |

---

## System Doctor Conversation Starters

| Scenario | Ask Claude |
|----------|-----------|
| Morning health check | "Run a complete system health audit – check GL mappings, standing instructions, and portfolio snapshot" |
| Before disbursing a top-up | "Validate top-up loan for loan {ID} with amount {X}" |
| HUB reconciliation blocked | "What's the fix for the Airtel CSV upload failure?" |
| Board reporting | "Give me a portfolio snapshot as of 2026-02-28 with aging breakdown by product" |
| Issue tracking | "List all CRITICAL issues and their current status" |
| Freeze candidates | "Which loans should be frozen based on the current portfolio?" |

---

## Architecture

```
mcp-system-doctor/
├── src/
│   ├── index.ts                    ← MCP server entry point
│   ├── types/index.ts              ← Shared TypeScript types
│   ├── utils/fineract-client.ts    ← Fineract REST API client
│   └── tools/
│       ├── audit-gl-mapping.ts     ← GL audit tool
│       ├── scan-standing-instructions.ts
│       ├── portfolio-snapshot.ts
│       ├── validate-topup-loan.ts
│       ├── reconciliation-checker.ts
│       └── issue-tracker.ts        ← Issue register CRUD
├── docs/
│   ├── issues/issues-register.json
│   ├── api-samples/nova-mifos-api-collection.json
│   └── fix-blueprints/*.md
└── README.md
```

---

## Roadmap: System Doctor v2

- [ ] **Wallet Accounting Module** – GL structure for client wallets, suspense accounts
- [ ] **Commission Automation** – Collection efficiency + officer performance
- [ ] **SMS Gateway Monitor** – Track balance, alert before depletion (ISS-008)
- [ ] **Data Warehouse Connector** – Metabase integration with snapshot tables
- [ ] **Automated GL Reconciliation** – Daily debit/credit balance validation
- [ ] **Repossession Module** – Asset bucket management (ISS-004)
- [ ] **Loan Lifecycle Governance** – Freeze/restructure/write-off workflow audit
