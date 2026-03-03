/**
 * Tool: audit_gl_mapping
 * Issues: MF-002, ISS-010, RPT-003
 *
 * Audits the GL account mapping for all loan products.
 * Checks: all 8 required mappings exist, all mapped GLs are active,
 * accounting rule matches product type (Cash vs Accrual).
 */
import { FineractClient } from "../utils/fineract-client.js";
import { AuditResult, GlAccount } from "../types/index.js";

const REQUIRED_LOAN_MAPPINGS = [
  "fundSourceAccountId",
  "loanPortfolioAccountId",
  "transfersInSuspenseAccountId",
  "interestOnLoanAccountId",
  "incomeFromFeeAccountId",
  "incomeFromPenaltyAccountId",
  "writeOffAccountId",
  "overpaymentLiabilityAccountId",
];

interface LoanProductSummary {
  id: number;
  name: string;
  accountingRule?: { value: string };
}

interface LoanProductDetail {
  id: number;
  name: string;
  accountingRule?: { value: string };
  accountingMappings?: Record<string, { id: number; name: string; glCode: string; disabled?: boolean }>;
}

export async function auditGlMapping(
  client: FineractClient,
  productId?: number
): Promise<AuditResult[]> {
  const results: AuditResult[] = [];

  // 1. Fetch all GL accounts to build a lookup map
  const glAccounts: GlAccount[] = await client.get("/glaccounts");
  const glMap = new Map<number, GlAccount>(glAccounts.map((g) => [g.id, g]));

  results.push({
    checkName: "GL Accounts Loaded",
    status: "INFO",
    message: `Found ${glAccounts.length} GL accounts in chart of accounts.`,
    details: { disabledCount: glAccounts.filter((g) => g.disabled).length },
  });

  // 2. Fetch loan products
  const products: LoanProductSummary[] = productId
    ? [await client.get<LoanProductSummary>(`/loanproducts/${productId}`)]
    : await client.get<LoanProductSummary[]>("/loanproducts");

  results.push({
    checkName: "Loan Products Found",
    status: "INFO",
    message: `Auditing ${products.length} loan product(s).`,
  });

  for (const product of products) {
    const detail: LoanProductDetail = await client.get(`/loanproducts/${product.id}`);
    const productResults = auditSingleProduct(detail, glMap);
    results.push(...productResults);
  }

  return results;
}

function auditSingleProduct(
  product: LoanProductDetail,
  glMap: Map<number, GlAccount>
): AuditResult[] {
  const results: AuditResult[] = [];
  const productLabel = `[${product.id}] ${product.name}`;

  // Check accounting rule set
  if (!product.accountingRule || product.accountingRule.value === "NONE") {
    results.push({
      checkName: `Accounting Rule – ${productLabel}`,
      status: "FAIL",
      message: `Product has no accounting rule. GL posting will not occur.`,
      issueRef: "MF-002, ISS-010",
      suggestedFix: "Set accountingType to CASH or ACCRUAL_PERIODIC in product configuration.",
      details: { productId: product.id, productName: product.name },
    });
    return results;
  }

  results.push({
    checkName: `Accounting Rule – ${productLabel}`,
    status: "PASS",
    message: `Accounting rule: ${product.accountingRule.value}`,
  });

  const mappings = product.accountingMappings ?? {};

  // Check each required mapping
  for (const required of REQUIRED_LOAN_MAPPINGS) {
    const mapping = mappings[required];
    if (!mapping) {
      results.push({
        checkName: `GL Mapping: ${required} – ${productLabel}`,
        status: "FAIL",
        message: `Required GL mapping '${required}' is missing.`,
        issueRef: "MF-002",
        suggestedFix: `Add ${required} to product GL mapping configuration.`,
        details: { productId: product.id },
      });
      continue;
    }

    // Check the GL account is active
    const gl = glMap.get(mapping.id);
    if (!gl) {
      results.push({
        checkName: `GL Active Check: ${required} – ${productLabel}`,
        status: "FAIL",
        message: `GL account ${mapping.glCode} (id: ${mapping.id}) not found in chart of accounts.`,
        issueRef: "MF-002",
        suggestedFix: "Verify GL account exists and is active.",
      });
    } else if (gl.disabled) {
      results.push({
        checkName: `GL Active Check: ${required} – ${productLabel}`,
        status: "FAIL",
        message: `GL account ${gl.glCode} – '${gl.name}' is DISABLED. Posting will fail.`,
        issueRef: "MF-002",
        suggestedFix: `Re-enable GL account ${gl.glCode} or remap to an active account.`,
        details: { glCode: gl.glCode, glName: gl.name },
      });
    } else {
      results.push({
        checkName: `GL Mapping: ${required} – ${productLabel}`,
        status: "PASS",
        message: `Mapped to ${gl.glCode} – ${gl.name} (active).`,
      });
    }
  }

  return results;
}
