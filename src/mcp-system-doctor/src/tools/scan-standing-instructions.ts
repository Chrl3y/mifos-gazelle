/**
 * Tool: scan_standing_instructions
 * Issue: ISS-006
 *
 * Scans all active standing instructions that auto-debit savings accounts.
 * Flags instructions where the savings balance is below the instruction amount
 * (indicating a pre-deposit trigger risk) and where the linked savings
 * account has no confirmed deposit in the last N hours.
 */
import { FineractClient } from "../utils/fineract-client.js";
import { AuditResult, StandingInstruction } from "../types/index.js";

interface SavingsAccount {
  id: number;
  accountNo: string;
  clientName: string;
  summary: { availableBalance: number; accountBalance: number };
  status: { value: string };
}

interface SavingsTransaction {
  id: number;
  type: { value: string; deposit: boolean };
  date: number[];
  amount: number;
  runningBalance: number;
}

export async function scanStandingInstructions(
  client: FineractClient,
  lookbackHours: number = 24
): Promise<AuditResult[]> {
  const results: AuditResult[] = [];

  // Fetch all standing instructions
  let instructions: StandingInstruction[] = [];
  try {
    const resp = await client.get<{ pageItems: StandingInstruction[] }>(
      "/standinginstructions",
      { status: "active", limit: 500 }
    );
    instructions = resp.pageItems ?? [];
  } catch {
    results.push({
      checkName: "Standing Instructions Fetch",
      status: "WARNING",
      message: "Could not retrieve standing instructions. Check API permissions.",
      issueRef: "ISS-006",
    });
    return results;
  }

  results.push({
    checkName: "Standing Instructions Count",
    status: "INFO",
    message: `Found ${instructions.length} active standing instructions.`,
  });

  const cutoffMs = Date.now() - lookbackHours * 3600 * 1000;
  let riskCount = 0;

  for (const si of instructions) {
    if (!si.fromAccount?.id) continue;

    // Fetch savings account balance
    let savings: SavingsAccount;
    try {
      savings = await client.get<SavingsAccount>(`/savingsaccounts/${si.fromAccount.id}`, {
        fields: "id,accountNo,clientName,summary,status",
      });
    } catch {
      continue;
    }

    const available = savings.summary?.availableBalance ?? 0;
    const instructionAmount = si.amount ?? 0;

    // Check if balance insufficient before instruction fires
    if (available < instructionAmount) {
      riskCount++;
      results.push({
        checkName: `Pre-Deposit Risk – SI #${si.id}`,
        status: "FAIL",
        message: `Standing instruction (${si.name}) for ${instructionAmount.toLocaleString()} UGX will auto-fire but savings balance is only ${available.toLocaleString()} UGX.`,
        issueRef: "ISS-006",
        suggestedFix:
          "Disable standing instruction execution until deposit confirmation. Requires deposit_confirmed flag on SavingsAccountTransaction.",
        details: {
          siId: si.id,
          siName: si.name,
          fromAccountNo: savings.accountNo,
          clientName: savings.clientName,
          availableBalance: available,
          instructionAmount,
          deficit: instructionAmount - available,
        },
      });
      continue;
    }

    // Check for recent confirmed deposit
    let transactions: SavingsTransaction[] = [];
    try {
      const txResp = await client.get<{ pageItems: SavingsTransaction[] }>(
        `/savingsaccounts/${si.fromAccount.id}/transactions`,
        { limit: 20 }
      );
      transactions = txResp.pageItems ?? [];
    } catch {
      continue;
    }

    const recentDeposit = transactions.find((tx) => {
      if (!tx.type?.deposit) return false;
      const txDate = Array.isArray(tx.date)
        ? new Date(tx.date[0], tx.date[1] - 1, tx.date[2]).getTime()
        : 0;
      return txDate > cutoffMs;
    });

    if (!recentDeposit) {
      results.push({
        checkName: `No Recent Deposit – SI #${si.id}`,
        status: "WARNING",
        message: `Standing instruction '${si.name}' has sufficient balance but no deposit confirmed in last ${lookbackHours}h. Book balance only.`,
        issueRef: "ISS-006",
        suggestedFix:
          "Verify physical deposit has been received. Consider requiring deposit confirmation before auto-execution.",
        details: {
          siId: si.id,
          fromAccountNo: savings.accountNo,
          clientName: savings.clientName,
          availableBalance: available,
        },
      });
    } else {
      results.push({
        checkName: `SI Deposit Confirmed – SI #${si.id}`,
        status: "PASS",
        message: `Standing instruction '${si.name}' has recent deposit of ${recentDeposit.amount.toLocaleString()} UGX. Safe to execute.`,
      });
    }
  }

  results.push({
    checkName: "Standing Instructions Risk Summary",
    status: riskCount > 0 ? "FAIL" : "PASS",
    message: `${riskCount} standing instruction(s) at risk of pre-deposit auto-execution.`,
    issueRef: "ISS-006",
    details: { riskCount, total: instructions.length },
  });

  return results;
}
