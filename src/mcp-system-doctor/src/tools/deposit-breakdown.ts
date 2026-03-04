/**
 * Tool: calculate_deposit_breakdown / post_deposit_to_gl
 *
 * Given a product type, loan amount, and total amount received from client,
 * computes the full DR/CR GL posting breakdown (fees, insurance, CRB,
 * arrangement fees, tracking payable, loan wallet, etc.)
 * and optionally posts the journal entry to Fineract.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { FineractClient } from "../utils/fineract-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = resolve(__dirname, "../../config/product-fee-schedules.json");

export interface FeeComponent {
  name: string;
  glCode: string;
  glType: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE";
  direction: "DR" | "CR";
  calcType: "fixed" | "pct_loan" | "pct_dp" | "remainder";
  value: number;
  note?: string;
}

export interface ProductSchedule {
  label: string;
  loanGlCode: string;
  currency: string;
  downPaymentPct: number;
  components: FeeComponent[];
}

export interface BreakdownLine {
  name: string;
  glCode: string;
  glType: string;
  direction: "DR" | "CR";
  amount: number;
  note?: string;
}

export interface DepositBreakdown {
  product: string;
  productLabel: string;
  loanAmount: number;
  amountReceived: number;
  expectedDownPayment: number;
  paymentChannel: string;
  date: string;
  clientName?: string;
  clientPhone?: string;
  loanAccountNo?: string;
  debitLines: BreakdownLine[];
  creditLines: BreakdownLine[];
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
  variance: number;
  walletAmount: number;
  formatted: string;
}

function loadSchedules(): { products: Record<string, ProductSchedule>; paymentChannels: Record<string, { glCode: string; name: string }> } {
  const raw = readFileSync(SCHEDULE_PATH, "utf-8");
  return JSON.parse(raw);
}

export function calculateDepositBreakdown(params: {
  product: string;
  loanAmount: number;
  amountReceived: number;
  paymentChannel?: string;
  date?: string;
  clientName?: string;
  clientPhone?: string;
  loanAccountNo?: string;
}): DepositBreakdown {
  const schedules = loadSchedules();
  const productKey = params.product.toUpperCase().replace(/[\s\-]+/g, "_");
  const schedule = schedules.products[productKey];

  if (!schedule) {
    const available = Object.keys(schedules.products).join(", ");
    throw new Error(`Product '${params.product}' not found. Available: ${available}`);
  }

  const channel = params.paymentChannel?.toUpperCase() ?? "CASH";
  const channelConfig = schedules.paymentChannels[channel] ?? { glCode: "1001", name: "Cash at Hand" };
  const date = params.date ?? new Date().toISOString().split("T")[0];
  const loanAmount = params.loanAmount;
  const amountReceived = params.amountReceived;
  const expectedDP = Math.round(loanAmount * schedule.downPaymentPct);

  // Build credit lines (how the amount is distributed)
  const creditLines: BreakdownLine[] = [];
  let allocatedSoFar = 0;

  for (const comp of schedule.components) {
    if (comp.calcType === "remainder") continue; // Handle at end

    let amount = 0;
    if (comp.calcType === "fixed") {
      amount = comp.value;
    } else if (comp.calcType === "pct_loan") {
      amount = Math.round(loanAmount * comp.value);
    } else if (comp.calcType === "pct_dp") {
      amount = Math.round(amountReceived * comp.value);
    }

    allocatedSoFar += amount;
    creditLines.push({
      name: comp.name,
      glCode: comp.glCode,
      glType: comp.glType,
      direction: "CR",
      amount,
      note: comp.note,
    });
  }

  // Remainder goes to loan wallet
  const remainderComp = schedule.components.find((c) => c.calcType === "remainder");
  const walletAmount = Math.max(0, amountReceived - allocatedSoFar);
  if (remainderComp) {
    creditLines.push({
      name: remainderComp.name,
      glCode: remainderComp.glCode,
      glType: remainderComp.glType,
      direction: "CR",
      amount: walletAmount,
      note: remainderComp.note ?? "Remainder applied to loan repayment wallet",
    });
    allocatedSoFar += walletAmount;
  }

  // Debit line: Bank/Channel account (total received)
  const debitLines: BreakdownLine[] = [
    {
      name: channelConfig.name,
      glCode: channelConfig.glCode,
      glType: "ASSET",
      direction: "DR",
      amount: amountReceived,
      note: `${channel} payment received`,
    },
  ];

  const totalDebits = debitLines.reduce((s, l) => s + l.amount, 0);
  const totalCredits = creditLines.reduce((s, l) => s + l.amount, 0);
  const variance = totalDebits - totalCredits;
  const balanced = Math.abs(variance) <= 1; // Allow 1 UGX rounding

  // Format the breakdown as a readable table
  const formatted = formatBreakdown({
    product: productKey,
    productLabel: schedule.productLabel ?? schedule.label,
    loanAmount,
    amountReceived,
    debitLines,
    creditLines,
    clientName: params.clientName,
    loanAccountNo: params.loanAccountNo,
    date,
    channel,
    balanced,
    variance,
    walletAmount,
  });

  return {
    product: productKey,
    productLabel: schedule.label,
    loanAmount,
    amountReceived,
    expectedDownPayment: expectedDP,
    paymentChannel: channel,
    date,
    clientName: params.clientName,
    clientPhone: params.clientPhone,
    loanAccountNo: params.loanAccountNo,
    debitLines,
    creditLines,
    totalDebits,
    totalCredits,
    balanced,
    variance,
    walletAmount,
    formatted,
  };
}

function formatBreakdown(data: {
  product: string;
  productLabel: string;
  loanAmount: number;
  amountReceived: number;
  debitLines: BreakdownLine[];
  creditLines: BreakdownLine[];
  clientName?: string;
  loanAccountNo?: string;
  date: string;
  channel: string;
  balanced: boolean;
  variance: number;
  walletAmount: number;
}): string {
  const fmt = (n: number) => n.toLocaleString("en-UG");
  const pad = (s: string, w: number) => s.padEnd(w);
  const lpad = (s: string, w: number) => s.padStart(w);

  const lines: string[] = [];
  lines.push("═".repeat(72));
  lines.push(`  POSTING DOWN PAYMENT BREAKDOWN – ${data.productLabel}`);
  lines.push(`  Loan Amount: UGX ${fmt(data.loanAmount)}   Received: UGX ${fmt(data.amountReceived)}`);
  if (data.clientName) lines.push(`  Client: ${data.clientName}${data.loanAccountNo ? ` | Loan: ${data.loanAccountNo}` : ""}`);
  lines.push(`  Date: ${data.date}   Channel: ${data.channel}`);
  lines.push("═".repeat(72));
  lines.push(`  ${pad("ACCOUNT / GL", 38)}  ${lpad("DR", 12)}  ${lpad("CR", 12)}`);
  lines.push("─".repeat(72));

  // DR lines
  for (const line of data.debitLines) {
    lines.push(`  ${pad(line.name, 38)}  ${lpad(fmt(line.amount), 12)}  ${lpad("", 12)}`);
  }

  // CR lines
  for (const line of data.creditLines) {
    lines.push(`  ${pad(line.name, 38)}  ${lpad("", 12)}  ${lpad(fmt(line.amount), 12)}`);
  }

  lines.push("─".repeat(72));
  const totalDR = data.debitLines.reduce((s, l) => s + l.amount, 0);
  const totalCR = data.creditLines.reduce((s, l) => s + l.amount, 0);
  lines.push(`  ${pad("TOTAL", 38)}  ${lpad(fmt(totalDR), 12)}  ${lpad(fmt(totalCR), 12)}`);
  lines.push("═".repeat(72));
  lines.push(`  Wallet/Down Payment: UGX ${fmt(data.walletAmount)}`);
  lines.push(`  Balance Check: ${data.balanced ? "✅ BALANCED" : `❌ VARIANCE: ${fmt(data.variance)} UGX`}`);
  lines.push("═".repeat(72));

  return lines.join("\n");
}

/** Post the breakdown as a Fineract journal entry */
export async function postDepositToGL(
  client: FineractClient,
  breakdown: DepositBreakdown,
  officeId: number = 1
): Promise<{ success: boolean; transactionId?: string; message: string }> {
  const debits = breakdown.debitLines.map((l) => ({
    glAccountId: await resolveGlId(client, l.glCode),
    amount: l.amount,
    comments: l.name,
  }));

  const credits = breakdown.creditLines
    .filter((l) => l.amount > 0)
    .map((l) => ({
      glAccountId: await resolveGlId(client, l.glCode),
      amount: l.amount,
      comments: l.name,
    }));

  try {
    const result = await client.post<{ transactionId: string }>("/journalentries", {
      officeId,
      transactionDate: breakdown.date.split("-").reverse().join(" "),
      dateFormat: "dd MM yyyy",
      locale: "en",
      currencyCode: "UGX",
      debits: await Promise.all(debits),
      credits: await Promise.all(credits),
      referenceNumber: breakdown.loanAccountNo
        ? `DP-${breakdown.loanAccountNo}-${breakdown.date}`
        : `DP-${breakdown.product}-${Date.now()}`,
      comments: `Down payment: ${breakdown.productLabel}${breakdown.clientName ? ` – ${breakdown.clientName}` : ""} via ${breakdown.paymentChannel}`,
    });

    return {
      success: true,
      transactionId: result.transactionId,
      message: `Journal entry posted. Transaction ID: ${result.transactionId}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to post journal entry: ${(err as Error).message}`,
    };
  }
}

const glIdCache = new Map<string, number>();

async function resolveGlId(client: FineractClient, glCode: string): Promise<number> {
  if (glIdCache.has(glCode)) return glIdCache.get(glCode)!;
  const accounts = await client.get<Array<{ id: number; glCode: string }>>(`/glaccounts?glCode=${glCode}`);
  const account = Array.isArray(accounts) ? accounts.find((a) => a.glCode === glCode) : null;
  if (!account) throw new Error(`GL account with code '${glCode}' not found. Configure it in Fineract first.`);
  glIdCache.set(glCode, account.id);
  return account.id;
}

/** Update a product fee schedule in the config file */
export function updateProductFeeSchedule(productKey: string, schedule: ProductSchedule): void {
  const data = loadSchedules() as Record<string, unknown>;
  (data.products as Record<string, ProductSchedule>)[productKey.toUpperCase()] = schedule;
  writeFileSync(SCHEDULE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** List all configured products */
export function listProductSchedules(): Array<{ key: string; label: string; downPaymentPct: number; componentCount: number }> {
  const { products } = loadSchedules();
  return Object.entries(products).map(([key, p]) => ({
    key,
    label: p.label,
    downPaymentPct: p.downPaymentPct,
    componentCount: p.components.length,
  }));
}
