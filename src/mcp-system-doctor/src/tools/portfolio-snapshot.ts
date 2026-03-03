/**
 * Tool: get_portfolio_snapshot
 * Issues: RPT-001, RPT-006, ISS-013
 *
 * Returns a point-in-time portfolio snapshot: active loans, PAR calculation,
 * aging buckets, per-product and per-officer breakdown.
 * Also flags loans that should be frozen (ISS-013).
 */
import { FineractClient } from "../utils/fineract-client.js";
import { AuditResult, PortfolioSnapshot } from "../types/index.js";

interface LoanItem {
  id: number;
  accountNo: string;
  clientName: string;
  loanProductName: string;
  loanOfficerName?: string;
  status: { value: string; active: boolean };
  summary: {
    principalOutstanding: number;
    interestOutstanding: number;
    totalOutstanding: number;
    totalOverdue: number;
  };
  timeline: {
    expectedDisbursementDate?: number[];
    actualDisbursementDate?: number[];
    expectedMaturityDate?: number[];
  };
  overdueCharges?: number;
  inArrears?: boolean;
  numberOfRepayments: number;
  repaymentEvery: number;
  repaymentFrequencyType?: { value: string };
}

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "91-180" | "181+";

function classifyAging(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  if (daysOverdue <= 180) return "91-180";
  return "181+";
}

export async function getPortfolioSnapshot(
  client: FineractClient,
  asOfDate?: string
): Promise<{ snapshot: PortfolioSnapshot; audits: AuditResult[] }> {
  const audits: AuditResult[] = [];

  // Fetch all active loans
  let loans: LoanItem[] = [];
  try {
    loans = await client.getAllPages<LoanItem>("/loans", {
      loanStatus: "active",
      fields:
        "id,accountNo,clientName,loanProductName,loanOfficerName,status,summary,timeline,inArrears,numberOfRepayments,repaymentEvery,repaymentFrequencyType",
    });
  } catch (err) {
    audits.push({
      checkName: "Loan Fetch",
      status: "FAIL",
      message: `Failed to fetch loans: ${(err as Error).message}`,
    });
    return {
      snapshot: buildEmptySnapshot(asOfDate ?? new Date().toISOString().split("T")[0]),
      audits,
    };
  }

  audits.push({
    checkName: "Active Loans Loaded",
    status: "INFO",
    message: `Loaded ${loans.length} active loans for portfolio snapshot.`,
  });

  const snapshot: PortfolioSnapshot = buildEmptySnapshot(
    asOfDate ?? new Date().toISOString().split("T")[0]
  );

  const agingBuckets: Record<AgingBucket, { count: number; outstanding: number; overdue: number }> = {
    current: { count: 0, outstanding: 0, overdue: 0 },
    "1-30": { count: 0, outstanding: 0, overdue: 0 },
    "31-60": { count: 0, outstanding: 0, overdue: 0 },
    "61-90": { count: 0, outstanding: 0, overdue: 0 },
    "91-180": { count: 0, outstanding: 0, overdue: 0 },
    "181+": { count: 0, outstanding: 0, overdue: 0 },
  };

  // Loans flagged for freeze (ISS-013)
  const candidatesForFreeze: { id: number; accountNo: string; client: string; daysOverdue: number; outstanding: number }[] = [];

  for (const loan of loans) {
    const outstanding = loan.summary?.totalOutstanding ?? 0;
    const overdue = loan.summary?.totalOverdue ?? 0;

    snapshot.totalActiveLoans++;
    snapshot.totalOutstanding += outstanding;
    snapshot.totalOverdue += overdue;

    // Estimate days overdue from overdue amount (approximate without full schedule)
    // In production: query /loans/{id}/repaymentschedule to get exact past-due days
    const daysOverdue = overdue > 0 ? estimateDaysOverdue(loan) : 0;
    const bucket = classifyAging(daysOverdue);
    agingBuckets[bucket].count++;
    agingBuckets[bucket].outstanding += outstanding;
    agingBuckets[bucket].overdue += overdue;

    // Per-product
    const product = loan.loanProductName ?? "Unknown";
    if (!snapshot.byProduct[product]) {
      snapshot.byProduct[product] = { count: 0, outstanding: 0, overdue: 0 };
    }
    snapshot.byProduct[product].count++;
    snapshot.byProduct[product].outstanding += outstanding;
    snapshot.byProduct[product].overdue += overdue;

    // Per-officer
    const officer = loan.loanOfficerName ?? "Unassigned";
    if (!snapshot.byOfficer[officer]) {
      snapshot.byOfficer[officer] = { count: 0, outstanding: 0, overdue: 0 };
    }
    snapshot.byOfficer[officer].count++;
    snapshot.byOfficer[officer].outstanding += outstanding;
    snapshot.byOfficer[officer].overdue += overdue;

    // Flag for freeze: overdue > 180 days, still active (ISS-013)
    if (daysOverdue > 180) {
      candidatesForFreeze.push({
        id: loan.id,
        accountNo: loan.accountNo,
        client: loan.clientName,
        daysOverdue,
        outstanding,
      });
    }
  }

  // PAR ratio (loans with any overdue / total outstanding)
  const loansWithOverdue = loans.filter((l) => (l.summary?.totalOverdue ?? 0) > 0);
  const totalOverdueOutstanding = loansWithOverdue.reduce(
    (sum, l) => sum + (l.summary?.principalOutstanding ?? 0),
    0
  );
  snapshot.parRatio =
    snapshot.totalOutstanding > 0
      ? Math.round((totalOverdueOutstanding / snapshot.totalOutstanding) * 10000) / 100
      : 0;

  // Add aging audit
  audits.push({
    checkName: "Portfolio Aging Breakdown",
    status: snapshot.parRatio > 10 ? "FAIL" : snapshot.parRatio > 5 ? "WARNING" : "PASS",
    message: `PAR ratio: ${snapshot.parRatio}%. ${loansWithOverdue.length} loans in arrears out of ${loans.length}.`,
    issueRef: "RPT-001, RPT-006",
    details: agingBuckets as unknown as Record<string, unknown>,
  });

  // Flag freeze candidates (ISS-013)
  if (candidatesForFreeze.length > 0) {
    audits.push({
      checkName: "Loans Requiring Freeze (ISS-013)",
      status: "FAIL",
      message: `${candidatesForFreeze.length} loan(s) overdue 180+ days still ACTIVE. Should be frozen or written off.`,
      issueRef: "ISS-013",
      suggestedFix:
        "Use LoanInterestPauseApiResource or implement FROZEN status. Run batch freeze job.",
      details: { candidatesForFreeze: candidatesForFreeze as unknown as Record<string, unknown> },
    });
  }

  return { snapshot, audits };
}

function estimateDaysOverdue(loan: LoanItem): number {
  if (!loan.inArrears) return 0;
  if ((loan.summary?.totalOverdue ?? 0) === 0) return 0;
  // Rough proxy: use repayment frequency
  return loan.repaymentEvery ? loan.repaymentEvery * 35 : 45;
}

function buildEmptySnapshot(date: string): PortfolioSnapshot {
  return {
    asOfDate: date,
    totalActiveLoans: 0,
    totalDisbursed: 0,
    totalOutstanding: 0,
    totalOverdue: 0,
    parRatio: 0,
    byProduct: {},
    byOfficer: {},
  };
}
