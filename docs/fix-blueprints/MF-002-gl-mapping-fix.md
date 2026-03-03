# Fix Blueprint: MF-002 – Product Accounting Mapping Fails

**Priority:** HIGH
**System:** Helaplus – Loan Products / GL Mapping
**Status:** OPEN
**Affects:** ALL HAOJUE, TVS, HONDA boda products

---

## Problem Summary

`productToAccountMapping.not.found` error thrown despite all GL fields appearing filled in UI. Blocks product configuration for multiple boda-boda loan products.

---

## Diagnostic Checklist (Run in Order)

### Step 1: Confirm accounting rule is set

```bash
# Via API
curl -u mifos:password \
  -H "Fineract-Platform-TenantId: default" \
  "http://localhost:8080/fineract-provider/api/v1/loanproducts/{productId}" \
  | jq '.accountingRule'
# Expected: {"id":2,"code":"accountingRuleType.cash","value":"CASH BASED"}
# If: {"id":1,"code":"accountingRuleType.none","value":"NONE"} → this is the bug
```

### Step 2: Verify all 8 required GL mappings exist

```bash
curl -u mifos:password \
  -H "Fineract-Platform-TenantId: default" \
  "http://localhost:8080/fineract-provider/api/v1/loanproducts/{productId}" \
  | jq '.accountingMappings'
```

**All 8 fields must be present and non-null:**

| Field | GL Type | Direction |
|-------|---------|-----------|
| `fundSourceAccountId` | ASSET | Debit on disbursement |
| `loanPortfolioAccountId` | ASSET | Credit on disbursement |
| `transfersInSuspenseAccountId` | ASSET | Intermediate |
| `interestOnLoanAccountId` | INCOME | Credit on interest |
| `incomeFromFeeAccountId` | INCOME | Credit on fee |
| `incomeFromPenaltyAccountId` | INCOME | Credit on penalty |
| `writeOffAccountId` | EXPENSE | Debit on write-off |
| `overpaymentLiabilityAccountId` | LIABILITY | Credit on overpayment |

### Step 3: Check each GL account is active

```bash
# Get all disabled GL accounts
curl -u mifos:password \
  -H "Fineract-Platform-TenantId: default" \
  "http://localhost:8080/fineract-provider/api/v1/glaccounts?disabled=true" \
  | jq '.[] | {id, glCode, name}'
```

If any mapped GL appears here → **re-enable it** or remap to an active account.

### Step 4: Verify Cash vs Accrual consistency

- If product uses **CASH_BASED** accounting: interest income posted on receipt
- If product uses **ACCRUAL_PERIODIC**: additional mappings required (`receivableInterestAccountId`, `receivableFeeAccountId`, `receivablePenaltyAccountId`)

---

## Fix: Correct PUT Payload for Boda Products

```json
PUT /api/v1/loanproducts/{productId}
Content-Type: application/json

{
  "name": "HAOJUE Boda Loan",
  "currencyCode": "UGX",
  "locale": "en",
  "accountingRule": 2,

  "fundSourceAccountId": <CASH_AND_BANK_GL_ID>,
  "loanPortfolioAccountId": <LOAN_PORTFOLIO_GL_ID>,
  "transfersInSuspenseAccountId": <SUSPENSE_GL_ID>,
  "interestOnLoanAccountId": <INTEREST_INCOME_GL_ID>,
  "incomeFromFeeAccountId": <FEE_INCOME_GL_ID>,
  "incomeFromPenaltyAccountId": <PENALTY_INCOME_GL_ID>,
  "writeOffAccountId": <LOAN_WRITEOFF_EXPENSE_GL_ID>,
  "overpaymentLiabilityAccountId": <OVERPAYMENT_LIABILITY_GL_ID>
}
```

**accountingRule values:**
- `1` = NONE (no GL posting)
- `2` = CASH BASED
- `3` = ACCRUAL_PERIODIC
- `4` = ACCRUAL_UPFRONT

---

## GL Structure Recommendation for Nova

### Suggested Chart of Accounts for Boda Products

```
ASSETS
  1000 – Cash and Bank (Fund Source)
  1100 – Loan Portfolio – Boda (HAOJUE)
  1101 – Loan Portfolio – Boda (TVS)
  1102 – Loan Portfolio – Boda (HONDA)
  1200 – Transfers in Suspense

LIABILITIES
  2000 – Client Overpayment Reserve

INCOME
  4000 – Interest Income – Boda Loans
  4100 – Fee Income – Processing Fees
  4200 – Penalty Income

EXPENSES
  5000 – Loan Write-Off – Boda
  5100 – Loan Loss Provision
```

---

## Root Cause in Code

**File:** `fineract-accounting/src/main/java/org/apache/fineract/accounting/producttoaccountmapping/`
**Class:** `ProductToGLAccountMappingWritePlatformServiceImpl`
**Method:** `createLoanProductToGLAccountMapping()`

**Validation class:** `LoanProductAccountingDataValidator`

The validator throws `productToAccountMapping.not.found` when:
1. Accounting rule != NONE but any of the 8 required mappings is missing
2. The GL account ID is invalid or references a disabled account
3. The accounting rule code doesn't match the expected enum value

---

## MCP System Doctor Integration

```bash
# Run full GL audit via MCP server
curl -X POST http://localhost:3000/tools/audit_gl_mapping \
  -H 'Content-Type: application/json' \
  -d '{"productId": 5}'  # omit productId to audit ALL products
```

---

## Acceptance Criteria

- [ ] All HAOJUE, TVS, HONDA products configured with accounting rule = CASH_BASED
- [ ] All 8 required GL mappings present per product
- [ ] All mapped GL accounts are active (not disabled)
- [ ] Test disbursement posts correctly to GL
- [ ] Test repayment posts correctly to GL
- [ ] `audit_gl_mapping` MCP tool returns all PASS for boda products
