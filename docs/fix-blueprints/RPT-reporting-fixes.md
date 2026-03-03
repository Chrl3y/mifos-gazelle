# Fix Blueprint: Reporting Issues (RPT-001 through RPT-008)

**Priority:** HIGH/MEDIUM
**System:** Helaplus Reports / Apache Fineract Reporting
**Status:** ENHANCEMENT / BUG

---

## RPT-003: Aging Summary Returns Blank (BUG – Fix First)

### Diagnosis Steps

```bash
# 1. Test report directly via API
curl -u mifos:password \
  -H "Fineract-Platform-TenantId: default" \
  "http://localhost:8080/fineract-provider/api/v1/runreports/LoanAgeingSummary?output-type=JSON"

# 2. Get the report SQL from Fineract DB
SELECT sr.report_sql, sr.report_name, sr.report_parameters
FROM stretchy_report sr
WHERE sr.report_name LIKE '%Aging%' OR sr.report_name LIKE '%Ageing%';
```

### Common Causes of Blank Output

1. **Missing required parameter**: Report SQL uses `${parameter}` but parameter not passed
   ```sql
   -- Fix: check for undefined parameters in SQL
   SELECT ... WHERE l.office_id = ${officeId}  -- if officeId not passed → empty
   -- Fix: add default or make optional: COALESCE(${officeId}, l.office_id)
   ```

2. **GROUP BY without data**: Aggregation on empty set returns no rows
   ```sql
   -- Debug: remove GROUP BY first, check raw data
   SELECT * FROM m_loan WHERE loan_status_id = 300 LIMIT 10;
   ```

3. **Date filter too restrictive**: Default date range excludes all data
   ```sql
   -- Check: does SQL have hardcoded date?
   WHERE l.disbursedon_date BETWEEN '${startDate}' AND '${endDate}'
   -- Fix: add default dates or remove filter for summary view
   ```

### Fix in Stretchy Reports

```sql
-- Updated Aging Summary SQL (add to Fineract via Reports UI or DB update)
UPDATE stretchy_report
SET report_sql = '
SELECT
  CASE
    WHEN DATEDIFF(CURDATE(), ml.last_repayment_date) BETWEEN 1 AND 30 THEN "1-30 Days"
    WHEN DATEDIFF(CURDATE(), ml.last_repayment_date) BETWEEN 31 AND 60 THEN "31-60 Days"
    WHEN DATEDIFF(CURDATE(), ml.last_repayment_date) BETWEEN 61 AND 90 THEN "61-90 Days"
    WHEN DATEDIFF(CURDATE(), ml.last_repayment_date) BETWEEN 91 AND 180 THEN "91-180 Days"
    WHEN DATEDIFF(CURDATE(), ml.last_repayment_date) > 180 THEN "180+ Days"
    ELSE "Current"
  END AS aging_bucket,
  COUNT(DISTINCT ml.id) AS loan_count,
  SUM(ls.principal_outstanding) AS principal_outstanding,
  SUM(ls.total_overdue) AS total_overdue
FROM m_loan ml
JOIN m_loan_summary ls ON ls.loan_id = ml.id
WHERE ml.loan_status_id = 300
  AND (${officeId} IS NULL OR ml.office_id = ${officeId})
GROUP BY aging_bucket
ORDER BY FIELD(aging_bucket, "Current","1-30 Days","31-60 Days","61-90 Days","91-180 Days","180+ Days")
'
WHERE report_name = 'LoanAgeingSummary';
```

---

## RPT-001 & RPT-002: Aging Reports – Add Date Range & Filters

### Enhancement: Add Parameters to Aging Report

```sql
-- Update LoanArrearsAging report to include date parameter and product filter
UPDATE stretchy_report
SET report_parameters = 'officeId,asOfDate,loanProductId,loanOfficerId'
WHERE report_name = 'LoanArrearsAging';

-- Update SQL to use new parameters
-- Replace hardcoded CURDATE() with ${asOfDate}
-- Add product and officer filters

SELECT
  c.display_name AS client_name,
  ml.account_no,
  mp.name AS product_name,
  s.display_name AS loan_officer,
  DATEDIFF(
    COALESCE(${asOfDate}, CURDATE()),
    COALESCE(ml.last_repayment_date, ml.disbursedon_date)
  ) AS days_overdue,
  ls.principal_outstanding,
  ls.total_overdue
FROM m_loan ml
JOIN m_client c ON c.id = ml.client_id
JOIN m_product_loan mp ON mp.id = ml.product_id
LEFT JOIN m_staff s ON s.id = ml.loan_officer_id
JOIN m_loan_summary ls ON ls.loan_id = ml.id
WHERE ml.loan_status_id = 300
  AND ls.total_overdue > 0
  AND (${loanProductId} IS NULL OR ml.product_id = ${loanProductId})
  AND (${loanOfficerId} IS NULL OR ml.loan_officer_id = ${loanOfficerId})
  AND (${officeId} IS NULL OR ml.office_id = ${officeId})
ORDER BY days_overdue DESC;
```

### Add Parameters via Fineract Reports UI

```
System → Reports → Edit Report: LoanArrearsAging
Parameters:
  - Name: asOfDate, Type: Date, Mandatory: No, Default: TODAY
  - Name: loanProductId, Type: Select (Loan Products), Mandatory: No
  - Name: loanOfficerId, Type: Select (Staff), Mandatory: No
```

---

## RPT-004: Loans Due Today – Add Rolling Overdue

```sql
-- Enhanced "Loans Due" report including prior unpaid days
SELECT
  c.display_name AS client_name,
  ml.account_no,
  mp.name AS product_name,
  s.display_name AS officer,
  mlr.duedate AS due_date,
  mlr.principal_amount_outstanding,
  mlr.interest_amount_outstanding,
  (mlr.principal_amount_outstanding + mlr.interest_amount_outstanding) AS total_due,
  DATEDIFF(CURDATE(), mlr.duedate) AS days_overdue
FROM m_loan_repayment_schedule mlr
JOIN m_loan ml ON ml.id = mlr.loan_id
JOIN m_client c ON c.id = ml.client_id
JOIN m_product_loan mp ON mp.id = ml.product_id
LEFT JOIN m_staff s ON s.id = ml.loan_officer_id
WHERE ml.loan_status_id = 300
  AND mlr.completed_derived = 0
  AND mlr.duedate <= COALESCE(${toDate}, CURDATE())
  AND mlr.duedate >= COALESCE(${fromDate}, CURDATE())
  AND (${loanProductId} IS NULL OR ml.product_id = ${loanProductId})
ORDER BY mlr.duedate ASC, days_overdue DESC;
```

---

## RPT-006: Portfolio Historical View / Point-in-Time Snapshot

### New Endpoint Concept

Add to Fineract as a custom report (Stretchy SQL):

```sql
-- Portfolio snapshot as of a given date
-- Uses transaction history to reconstruct balances
SELECT
  mp.name AS product_name,
  s.display_name AS officer,
  COUNT(DISTINCT ml.id) AS active_loans,
  SUM(
    ml.approved_principal -
    COALESCE((
      SELECT SUM(mlt2.amount)
      FROM m_loan_transaction mlt2
      WHERE mlt2.loan_id = ml.id
        AND mlt2.transaction_type_enum = 2  -- REPAYMENT
        AND mlt2.transaction_date <= ${asOfDate}
        AND mlt2.is_reversed = 0
    ), 0)
  ) AS principal_outstanding_asof,
  SUM(
    CASE WHEN EXISTS (
      SELECT 1 FROM m_loan_repayment_schedule mlrs
      WHERE mlrs.loan_id = ml.id
        AND mlrs.duedate < ${asOfDate}
        AND mlrs.completed_derived = 0
    ) THEN 1 ELSE 0 END
  ) AS loans_in_arrears
FROM m_loan ml
JOIN m_product_loan mp ON mp.id = ml.product_id
LEFT JOIN m_staff s ON s.id = ml.loan_officer_id
WHERE ml.loan_status_id IN (300, 600, 700)  -- ACTIVE, OVERPAID, CLOSED (as of date)
  AND ml.disbursedon_date <= ${asOfDate}
GROUP BY mp.name, s.display_name
ORDER BY mp.name;
```

---

## RPT-008: Branded Repayment Schedule Download

### Web App Fix – Add Download Button

**File:** `MIFOS-X-web-app/src/app/loans/loans-view/repayment-schedule-tab/repayment-schedule-tab.component.ts`

```typescript
// Add download method
downloadRepaymentSchedule(loanId: number): void {
  const url = `/api/v1/loans/${loanId}/repayment-schedule-pdf`;
  this.loansService.downloadRepaymentSchedule(loanId).subscribe(blob => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `repayment-schedule-${this.loanDetails.accountNo}.pdf`;
    link.click();
  });
}
```

### Pentaho PRPT Template Update (mifos-reporting-plugin)

In `pentahoReports/RepaymentSchedule.prpt`:
1. Add Nova logo to report header (Image element → `nova-logo.png`)
2. Add parameter `merchant_code` (type: String, default: from loan product custom field)
3. Add merchant code field to header band
4. Add footer with Nova branding

### API Endpoint for Branded Schedule

```bash
GET /api/v1/runreports/RepaymentSchedule?R_loanId={loanId}&output-type=PDF
```

---

## Reporting Enhancement Summary

| Issue | Type | Effort | Impact |
|-------|------|--------|--------|
| RPT-003 Blank Aging Summary | BUG FIX | Low (SQL fix) | HIGH |
| RPT-001 Date Range on Aging | Enhancement | Low (add parameter) | HIGH |
| RPT-002 Product/Officer Filter | Enhancement | Low (add parameter) | HIGH |
| RPT-004 Rolling Overdue | Enhancement | Medium (new SQL) | MEDIUM |
| RPT-005 Report Rename | Enhancement | Trivial | LOW |
| RPT-006 Historical Portfolio | Enhancement | High (new SQL + API) | HIGH |
| RPT-008 Branded Schedule | Enhancement | Medium (PRPT + UI) | MEDIUM |
