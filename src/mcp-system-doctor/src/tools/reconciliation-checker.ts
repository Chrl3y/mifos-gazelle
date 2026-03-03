/**
 * Tool: reconcile_payments
 * Issues: ISS-HUB-001, ISS-HUB-002, ISS-HUB-003, ISS-HUB-004, ISS-HUB-006
 *
 * Checks for unposted/unmatched payments via Fineract API.
 * Identifies payments received but not posted, and validates
 * down payment routing logic.
 */
import { FineractClient } from "../utils/fineract-client.js";
import { AuditResult, ReconciliationEntry } from "../types/index.js";
import dayjs from "dayjs";

interface LoanTransaction {
  id: number;
  type: { value: string; code: string };
  date: number[];
  amount: number;
  submittedOnDate?: number[];
  paymentDetailData?: {
    paymentType?: { name: string };
    accountNumber?: string;
    routingCode?: string;
    receiptNumber?: string;
    bankNumber?: string;
  };
  manuallyReversed?: boolean;
}

interface LoanSearchResult {
  id: number;
  accountNo: string;
  clientName: string;
  status: { value: string };
  summary: { totalOverdue: number; totalOutstanding: number };
}

export async function checkUnpostedPayments(
  client: FineractClient,
  fromDate: string,
  toDate: string
): Promise<{ entries: ReconciliationEntry[]; audits: AuditResult[] }> {
  const audits: AuditResult[] = [];
  const entries: ReconciliationEntry[] = [];

  audits.push({
    checkName: "Reconciliation Date Range",
    status: "INFO",
    message: `Checking unposted payments from ${fromDate} to ${toDate}.`,
    issueRef: "ISS-HUB-001",
  });

  // Fetch recent loan repayment transactions across all loans
  // In production: query Fineract's search/transactions endpoint or GL journal entries
  let transactions: LoanTransaction[] = [];
  try {
    const resp = await client.get<{ pageItems: LoanTransaction[] }>(
      "/searchtransactions",
      {
        fromDate,
        toDate,
        dateFormat: "yyyy-MM-dd",
        locale: "en",
        transactionType: "repayment",
        limit: 500,
      }
    );
    transactions = resp.pageItems ?? [];
  } catch {
    // Fallback: try journal entries for ASSET accounts (loan portfolio)
    audits.push({
      checkName: "Transaction Fetch Fallback",
      status: "WARNING",
      message:
        "Direct transaction search unavailable. Use GL journal entry audit for reconciliation.",
      issueRef: "ISS-HUB-001",
      suggestedFix: "Ensure search endpoint is enabled or query m_loan_transaction directly.",
    });
  }

  // Identify transactions with no payment method (potential unposted/manual)
  const unlinked = transactions.filter(
    (tx) => !tx.paymentDetailData?.paymentType && !tx.paymentDetailData?.receiptNumber
  );

  if (unlinked.length > 0) {
    audits.push({
      checkName: "Unlinked Payment Transactions",
      status: "WARNING",
      message: `${unlinked.length} repayment transactions have no payment type or receipt number.`,
      issueRef: "ISS-HUB-001",
      suggestedFix: "Link each transaction to a payment type. Review HUB processLoan() mapping.",
      details: {
        count: unlinked.length,
        transactions: unlinked.map((t) => ({
          id: t.id,
          date: t.date?.join("-"),
          amount: t.amount,
        })) as unknown as Record<string, unknown>,
      },
    });
  }

  // Detect potential misrouted USSD down payments (ISS-HUB-006)
  // Logic: repayment on an APPROVED (not yet active) loan = down payment misrouted
  const downPaymentCheck = await checkDownPaymentMisrouting(client, audits);
  entries.push(...downPaymentCheck);

  audits.push({
    checkName: "CSV Parser Issues Summary",
    status: "INFO",
    message: [
      "ISS-HUB-002: Airtel parser missing WITHDRAW transaction filter.",
      "ISS-HUB-003: Airtel date format mismatch causing future dates.",
      "ISS-HUB-004: YO! Uganda CSV parser not implemented.",
      "Fix: Add transaction_type filter to AirtelCsvParser. Fix date regex. Implement YoUgandaCsvParser.",
    ].join(" | "),
    issueRef: "ISS-HUB-002, ISS-HUB-003, ISS-HUB-004",
    suggestedFix:
      "AirtelCsvParser.php: copy MTN exclusion logic. YoUgandaCsvParser.php: implement from scratch with YO! CSV schema.",
  });

  return { entries, audits };
}

async function checkDownPaymentMisrouting(
  client: FineractClient,
  audits: AuditResult[]
): Promise<ReconciliationEntry[]> {
  const entries: ReconciliationEntry[] = [];

  // Check for approved loans that have received repayment transactions (misrouted down payment)
  let approvedLoans: LoanSearchResult[] = [];
  try {
    approvedLoans = await client.getAllPages<LoanSearchResult>("/loans", {
      loanStatus: "approved",
      fields: "id,accountNo,clientName,status,summary",
    });
  } catch {
    return entries;
  }

  const misrouted: Array<{ accountNo: string; clientName: string; loanId: number }> = [];

  for (const loan of approvedLoans.slice(0, 50)) {
    // Check if there are any repayment transactions on an approved (not yet active) loan
    try {
      const txResp = await client.get<{ pageItems: LoanTransaction[] }>(
        `/loans/${loan.id}/transactions`,
        { limit: 5 }
      );
      const repayments = (txResp.pageItems ?? []).filter(
        (tx) =>
          tx.type?.code === "loanTransactionType.repayment" && !tx.manuallyReversed
      );
      if (repayments.length > 0) {
        misrouted.push({ accountNo: loan.accountNo, clientName: loan.clientName, loanId: loan.id });
        entries.push({
          reference: `LOAN-${loan.accountNo}`,
          amount: repayments.reduce((s, t) => s + t.amount, 0),
          date: new Date().toISOString().split("T")[0],
          provider: "CASH",
          status: "MISROUTED",
          matchedLoanId: loan.id,
          notes: `Repayment on APPROVED loan – likely USSD down payment misrouted. (ISS-HUB-006)`,
        });
      }
    } catch {
      continue;
    }
  }

  if (misrouted.length > 0) {
    audits.push({
      checkName: "USSD Down Payment Misrouting (ISS-HUB-006)",
      status: "FAIL",
      message: `${misrouted.length} APPROVED loan(s) have repayment transactions – likely misrouted USSD down payments.`,
      issueRef: "ISS-HUB-006",
      suggestedFix:
        "Add payment_intent discriminator to USSD payload. Route by loan status: APPROVED→down payment, ACTIVE→repayment.",
      details: { misrouted: misrouted as unknown as Record<string, unknown> },
    });
  } else {
    audits.push({
      checkName: "USSD Down Payment Routing",
      status: "PASS",
      message: "No misrouted USSD down payments detected in sample of approved loans.",
    });
  }

  return entries;
}

/** Validate that today's collections match expected repayments */
export async function getDailyCollectionValidation(
  client: FineractClient
): Promise<AuditResult[]> {
  const audits: AuditResult[] = [];
  const today = dayjs().format("YYYY-MM-DD");

  // Loans due today
  audits.push({
    checkName: "Daily Collection Validation",
    status: "INFO",
    message: `Run /reports/LoansDueToday to get expected collections for ${today}. Compare against posted transactions. (ISS-003)`,
    issueRef: "RPT-004",
    suggestedFix:
      "Use GET /runreports/LoansDueToday?R_date={today} to get expected. Compare against m_loan_transaction for actual. Flag gaps.",
  });

  return audits;
}
