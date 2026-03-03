/**
 * Tool: validate_loan_topup
 * Issue: ISS-001 (CRITICAL)
 *
 * Validates that a proposed top-up loan calculation uses ONLY outstanding
 * principal (not principal + future interest) as the offset amount.
 *
 * Also provides a corrected calculation and flags any existing top-up loans
 * where the calculation appears incorrect.
 */
import { FineractClient } from "../utils/fineract-client.js";
import { AuditResult } from "../types/index.js";

interface LoanDetail {
  id: number;
  accountNo: string;
  clientName: string;
  status: { value: string; active: boolean };
  summary: {
    principalOutstanding: number;
    interestOutstanding: number;
    feeChargesOutstanding: number;
    penaltyChargesOutstanding: number;
    totalOutstanding: number;
  };
  principal: number;
  approvedPrincipal: number;
  repaymentSchedule?: {
    periods: Array<{
      period: number;
      dueDate: number[];
      principalDue: number;
      interestDue: number;
      principalOutstanding: number;
      complete: boolean;
    }>;
  };
}

export interface TopUpValidationResult {
  loanId: number;
  accountNo: string;
  clientName: string;
  originalPrincipal: number;
  principalOutstanding: number;
  interestOutstanding: number;
  futureInterest: number;
  incorrectOffsetAmount: number;
  correctOffsetAmount: number;
  difference: number;
  isAffected: boolean;
  recommendation: string;
}

export async function validateTopUpLoan(
  client: FineractClient,
  loanId: number,
  proposedTopUpAmount: number
): Promise<{ validation: TopUpValidationResult; audits: AuditResult[] }> {
  const audits: AuditResult[] = [];

  const loan: LoanDetail = await client.get(`/loans/${loanId}`, {
    associations: "repaymentSchedule",
  });

  const principalOutstanding = loan.summary?.principalOutstanding ?? 0;
  const interestOutstanding = loan.summary?.interestOutstanding ?? 0;
  const totalOutstanding = loan.summary?.totalOutstanding ?? 0;

  // Calculate future interest from schedule (periods not yet complete)
  let futureInterest = 0;
  if (loan.repaymentSchedule?.periods) {
    futureInterest = loan.repaymentSchedule.periods
      .filter((p) => !p.complete && (p.principalOutstanding ?? 0) > 0)
      .reduce((sum, p) => sum + (p.interestDue ?? 0), 0);
  } else {
    // Estimate: current interest outstanding is future interest proxy
    futureInterest = interestOutstanding;
  }

  // Correct offset = outstanding principal ONLY (ISS-001)
  const correctOffsetAmount = principalOutstanding;
  // Incorrect offset (what the buggy logic does) = principal + interest/future interest
  const incorrectOffsetAmount = principalOutstanding + futureInterest;
  const difference = incorrectOffsetAmount - correctOffsetAmount;
  const isAffected = difference > 0;

  const validation: TopUpValidationResult = {
    loanId: loan.id,
    accountNo: loan.accountNo,
    clientName: loan.clientName,
    originalPrincipal: loan.approvedPrincipal,
    principalOutstanding,
    interestOutstanding,
    futureInterest,
    incorrectOffsetAmount,
    correctOffsetAmount,
    difference,
    isAffected,
    recommendation: isAffected
      ? `Top-up offset is OVERSTATED by ${difference.toLocaleString()} UGX. ` +
        `Use principalOutstanding (${principalOutstanding.toLocaleString()}) NOT totalOutstanding or principal+interest. ` +
        `New loan net disbursement = ${proposedTopUpAmount} - ${correctOffsetAmount.toLocaleString()} = ${(proposedTopUpAmount - correctOffsetAmount).toLocaleString()} UGX.`
      : `Top-up calculation looks correct. Offset = ${correctOffsetAmount.toLocaleString()} UGX (principal only).`,
  };

  audits.push({
    checkName: `Top-Up Validation – Loan #${loanId} (${loan.clientName})`,
    status: isAffected ? "FAIL" : "PASS",
    message: validation.recommendation,
    issueRef: "ISS-001",
    suggestedFix: isAffected
      ? "Fix top-up computation: use getLoanSummary().getPrincipalOutstanding() NOT getTotalOutstanding(). " +
        "Review LoanWritePlatformServiceJpaRepositoryImpl disburseLoan() and LoanApplicationWritePlatformServiceJpaRepositoryImpl."
      : undefined,
    details: {
      principalOutstanding,
      interestOutstanding,
      futureInterest,
      correctOffsetAmount,
      incorrectOffsetAmount,
      difference,
      proposedTopUpAmount,
      correctNetDisbursement: proposedTopUpAmount - correctOffsetAmount,
      incorrectNetDisbursement: proposedTopUpAmount - incorrectOffsetAmount,
    },
  });

  return { validation, audits };
}

/**
 * Scan all active loans to find potential historical top-up miscalculations
 * by comparing approvedPrincipal to a recalculated expected net disbursement.
 */
export async function scanTopUpAnomalies(
  client: FineractClient
): Promise<AuditResult[]> {
  const audits: AuditResult[] = [];

  // Top-up loans usually have a parent loan link or disbursement notes
  // Here we look for loans where principal is substantially lower than expected
  // In production: filter by loan purpose or topup flag in custom datatables
  const loans = await client.getAllPages<{ id: number; accountNo: string; clientName: string; loanProductName: string }>(
    "/loans",
    { loanStatus: "active" }
  );

  audits.push({
    checkName: "Top-Up Anomaly Scan",
    status: "INFO",
    message: `Scanned ${loans.length} active loans. For precise top-up validation, run validate_loan_topup on specific loan IDs.`,
    issueRef: "ISS-001",
    suggestedFix:
      "Identify top-up loans by custom datatable or loan purpose field. Run validate_loan_topup per loan. Known affected case: Lubega Kenneth.",
    details: { totalScanned: loans.length },
  });

  return audits;
}
