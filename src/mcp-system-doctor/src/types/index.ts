export type IssuePriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type IssueStatus =
  | "OPEN"
  | "NEW"
  | "IDENTIFIED"
  | "ESCALATED"
  | "AWAITING DEV"
  | "PENDING GUIDANCE"
  | "IN PROGRESS"
  | "RESOLVED"
  | "ENHANCEMENT"
  | "BUG"
  | "CONFIG";

export interface FineractConfig {
  baseUrl: string;
  tenantId: string;
  username: string;
  password: string;
}

export interface LoanSummary {
  id: number;
  accountNo: string;
  clientName: string;
  productName: string;
  status: { value: string; code: string };
  principal: number;
  totalOutstanding: number;
  totalOverdue: number;
  numberOfRepayments: number;
  arrearsPastDueDays: number;
}

export interface GlAccount {
  id: number;
  glCode: string;
  name: string;
  type: { value: string };
  usage: { value: string };
  disabled: boolean;
  manualEntriesAllowed: boolean;
}

export interface StandingInstruction {
  id: number;
  name: string;
  status: { value: string };
  fromAccountType: { value: string };
  toAccountType: { value: string };
  fromAccount: { id: number; accountNo: string };
  toAccount: { id: number; accountNo: string };
  amount: number;
  transferType: { value: string };
}

export interface AuditResult {
  checkName: string;
  status: "PASS" | "FAIL" | "WARNING" | "INFO";
  message: string;
  details?: Record<string, unknown>;
  issueRef?: string;
  suggestedFix?: string;
}

export interface IssueRecord {
  id: string;
  domain: string;
  category: string;
  title: string;
  priority: IssuePriority;
  status: IssueStatus;
  description: string;
  businessImpact: string;
  rootCause?: string;
  suggestedFix?: string;
  assignedTo?: string;
  codebaseMapping?: {
    repo: string;
    module?: string;
    package?: string;
    file?: string;
    relevantClasses?: string[];
    frontendComponent?: string;
  };
}

export interface PortfolioSnapshot {
  asOfDate: string;
  totalActiveLoans: number;
  totalDisbursed: number;
  totalOutstanding: number;
  totalOverdue: number;
  parRatio: number;
  byProduct: Record<string, { count: number; outstanding: number; overdue: number }>;
  byOfficer: Record<string, { count: number; outstanding: number; overdue: number }>;
}

export interface ReconciliationEntry {
  reference: string;
  amount: number;
  date: string;
  provider: "MTN" | "AIRTEL" | "YO" | "CASH" | "BANK";
  phone?: string;
  status: "MATCHED" | "UNMATCHED" | "PENDING" | "MISROUTED";
  matchedLoanId?: number;
  notes?: string;
}
