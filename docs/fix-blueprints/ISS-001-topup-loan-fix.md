# Fix Blueprint: ISS-001 – Top-Up Loan Logic Error

**Priority:** CRITICAL
**System:** Helaplus / Apache Fineract – Loan Disbursement
**Status:** ESCALATED

---

## Problem Summary

When processing a **top-up loan**, the system deducts **both outstanding principal AND outstanding interest** (including future interest for remaining periods) from the new loan amount. It should deduct **outstanding principal only**.

**Confirmed case:** Client Lubega Kenneth
**Effect:** Artificially reduces the net disbursement, creating phantom debt on the new loan.

---

## Root Cause – Code Location

### Fineract Backend
**File:** `fineract-loan/src/main/java/org/apache/fineract/portfolio/loanaccount/service/`
**Class:** `LoanWritePlatformServiceJpaRepositoryImpl`
**Method:** `disburseLoan()` → top-up offset calculation section

**Secondary location:**
**Class:** `LoanApplicationWritePlatformServiceJpaRepositoryImpl`
**Method:** `submitApplication()` for top-up loans

**The bug pattern:**
```java
// WRONG – current logic (uses totalOutstanding which includes interest)
BigDecimal topUpOffset = existingLoan.getTotalOutstanding();  // BUG

// CORRECT – should use principal only
BigDecimal topUpOffset = existingLoan.getLoanSummary().getPrincipalOutstanding();
```

**Additional suspect:** `LoanRepaymentScheduleInstallment` – when summing "remaining amount", ensure only principal buckets are included.

---

## Fix Steps

### Step 1: Locate the offset calculation

Search for the top-up disbursement path:
```bash
grep -r "topup\|top_up\|getOutstandingAmount\|getTotalOutstanding" \
  fineract-loan/src/main/java/ --include="*.java" -l
```

### Step 2: Replace the offset logic

```java
// In LoanWritePlatformServiceJpaRepositoryImpl.disburseLoan()
// Find the block that calculates amount to close existing loan

// BEFORE (buggy):
final BigDecimal amountToClose = existingLoan.getTotalOutstanding();

// AFTER (fixed):
final BigDecimal amountToClose = existingLoan.getLoanSummary().getPrincipalOutstanding();
```

### Step 3: Verify LoanSummaryWrapper

In `LoanSummaryWrapper.java` or `LoanSummaryData.java`:
```java
// Confirm getPrincipalOutstanding() returns:
// principalDisbursed - principalRepaid  (NOT including any interest component)
public BigDecimal getPrincipalOutstanding() {
    return this.principalDisbursed.subtract(this.principalRepaid);
    // Ensure no interestOutstanding is added here
}
```

### Step 4: Test the fix

**Test case:**
- Existing loan: 3,000,000 UGX principal, 2,000,000 UGX remaining principal, 150,000 UGX interest outstanding
- Top-up amount: 5,000,000 UGX

| Scenario | Offset Used | Net Disbursement | Correct? |
|----------|-------------|------------------|----------|
| **Buggy** | 2,150,000 (principal + interest) | 2,850,000 | ❌ |
| **Fixed** | 2,000,000 (principal only) | 3,000,000 | ✅ |

### Step 5: Remediate affected cases

```sql
-- Find potentially affected top-up loans (custom datatable or note query)
-- Replace with your actual Helaplus column for "top-up" flag
SELECT l.id, l.account_no, c.display_name,
       ls.principal_outstanding, ls.interest_outstanding,
       ls.principal_outstanding + ls.interest_outstanding AS incorrect_offset
FROM m_loan l
JOIN m_client c ON l.client_id = c.id
JOIN m_loan_summary ls ON ls.loan_id = l.id
WHERE l.loan_status_id = 300  -- ACTIVE
  AND l.loan_type_enum = 3    -- INDIVIDUAL (adjust for top-up type if flagged)
ORDER BY l.id;
```

**For confirmed case – Lubega Kenneth:**
1. Calculate the overclaimed amount
2. Create a manual journal entry to reverse the artificial interest deduction
3. Post a loan transaction adjustment

---

## API Sample (MCP System Doctor)

```bash
# Validate top-up calculation before disbursement
curl -X POST http://localhost:3000/tools/validate_loan_topup \
  -H 'Content-Type: application/json' \
  -d '{"loanId": 123, "proposedTopUpAmount": 5000000}'
```

---

## Acceptance Criteria

- [ ] Top-up net disbursement = Proposed Amount − Principal Outstanding (only)
- [ ] Interest outstanding not included in offset
- [ ] Lubega Kenneth case reviewed and corrected
- [ ] Unit test added for top-up disbursement calculation
- [ ] Regression test: existing standard repayments unaffected
