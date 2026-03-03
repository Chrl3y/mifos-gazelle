# Fix Blueprint: ISS-006 – Standing Instructions Auto-Pay Before Deposit

**Priority:** CRITICAL
**System:** Helaplus – Standing Instructions
**Status:** IDENTIFIED

---

## Problem Summary

Standing instructions auto-execute loan repayments from client savings ("wallet") accounts **before physical cash has been deposited**. The trigger fires on book balance, not confirmed deposits.

**Effect:**
- Artificial repayment postings
- Cash flow distortion
- Reconciliation mismatches
- False portfolio performance metrics

---

## Root Cause – Code Location

**Fineract module:** `fineract-savings` + standing instruction batch job

**Key classes to modify:**

| Class | Location | Role |
|-------|----------|------|
| `StandingInstructionJobLauncherTasklet` | `fineract-core/src/...` | Batch job executor |
| `AccountTransferStandingInstructionService` | `fineract-savings/src/...` | Core execution logic |
| `SavingsAccount` | `fineract-savings/src/...` | Balance check |
| `SavingsAccountTransaction` | `fineract-savings/src/...` | Needs `depositConfirmed` flag |

---

## Fix Strategy: Three-Layer Approach

### Layer 1: Add `depositConfirmed` flag to savings transactions (Schema)

```sql
-- Migration: add confirmation flag to savings transactions
ALTER TABLE m_savings_account_transaction
  ADD COLUMN deposit_confirmed TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN confirmed_by BIGINT NULL,
  ADD COLUMN confirmed_on_date DATE NULL;

-- Backfill: treat all historical deposits as confirmed
UPDATE m_savings_account_transaction
SET deposit_confirmed = 1
WHERE transaction_type_enum = 1;  -- 1 = DEPOSIT
```

### Layer 2: Add `requireDepositConfirmation` flag to Savings Products (Schema)

```sql
ALTER TABLE m_savings_product
  ADD COLUMN require_deposit_confirmation TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE m_savings_account
  ADD COLUMN require_deposit_confirmation TINYINT(1) NOT NULL DEFAULT 0;
```

### Layer 3: Modify Standing Instruction Execution Logic

**File:** `AccountTransferStandingInstructionService.java`

```java
// In executeStandingInstruction() method
// BEFORE execution, add this guard:

public void executeStandingInstruction(final StandingInstructionData instruction) {

    SavingsAccount fromSavings = this.savingsAccountRepository
        .findOneWithNotFoundDetection(instruction.fromAccountId());

    // NEW: Check if account requires deposit confirmation
    if (fromSavings.isRequireDepositConfirmation()) {
        BigDecimal confirmedBalance = fromSavings.getConfirmedDepositBalance();
        if (confirmedBalance.compareTo(instruction.amount()) < 0) {
            // Log and skip – do NOT execute
            log.warn("Standing instruction {} skipped: insufficient confirmed balance. " +
                "Confirmed: {}, Required: {}",
                instruction.id(), confirmedBalance, instruction.amount());

            // Record failed execution for notification
            this.standingInstructionHistoryRepository.save(
                StandingInstructionHistory.failed(instruction.id(),
                    "Insufficient confirmed deposit balance"));
            return;
        }
    }

    // Existing execution logic continues...
}
```

### Layer 4: Add `getConfirmedDepositBalance()` to SavingsAccount

```java
// In SavingsAccount.java
public BigDecimal getConfirmedDepositBalance() {
    return this.transactions.stream()
        .filter(tx -> tx.isDeposit() && tx.isDepositConfirmed() && !tx.isReversed())
        .map(SavingsAccountTransaction::getAmount)
        .reduce(BigDecimal.ZERO, BigDecimal::add)
        .subtract(
            this.transactions.stream()
                .filter(tx -> tx.isWithdrawal() && !tx.isReversed())
                .map(SavingsAccountTransaction::getAmount)
                .reduce(BigDecimal.ZERO, BigDecimal::add)
        );
}
```

---

## Configuration Options

**Per-product configuration** (Savings Product settings in web app):

| Setting | Description | Default |
|---------|-------------|---------|
| `requireDepositConfirmation` | Require teller confirmation before balance counts for SI | OFF |
| `confirmationGracePeriodMinutes` | Minutes after deposit to auto-confirm | 0 (manual only) |

**Standing instruction enhancements:**
- Add `executionMode`: `IMMEDIATE` / `CONFIRMED_DEPOSIT_ONLY`
- Add `minimumBalanceBuffer`: minimum buffer above instruction amount

---

## Interim Workaround (Until Fix Deployed)

1. **Disable standing instructions** for wallet accounts that don't have same-day deposits:
   ```
   PUT /api/v1/standinginstructions/{id}?command=disable
   ```
2. **Daily operations check**: Run MCP tool `scan_standing_instructions` each morning before batch job
3. **Manual execution**: Teller confirms deposit → manually executes instruction

---

## Acceptance Criteria

- [ ] `depositConfirmed` flag added to savings transaction schema
- [ ] Standing instruction skips execution when confirmed balance < instruction amount
- [ ] Failed execution logged to `m_standing_instruction_history`
- [ ] Alert/notification generated for skipped instructions
- [ ] Teller workflow updated to confirm deposits before SI execution time
- [ ] MCP `scan_standing_instructions` tool validates all SIs each morning
