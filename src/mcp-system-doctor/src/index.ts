#!/usr/bin/env node
/**
 * Mifos System Doctor – MCP Server
 *
 * A Model Context Protocol server that acts as an intelligent system doctor
 * for Mifos X / Apache Fineract / Helaplus deployments.
 *
 * Capabilities:
 *   - audit_gl_mapping       : Audit GL account mappings for all loan products
 *   - scan_standing_instructions : Detect pre-deposit auto-pay risks
 *   - get_portfolio_snapshot : Point-in-time portfolio health + aging
 *   - validate_loan_topup    : Validate top-up loan offset calculation (ISS-001)
 *   - reconcile_payments     : Detect unposted / misrouted payments
 *   - list_issues            : List issues from the issues register
 *   - get_issue              : Get a single issue with full detail
 *   - update_issue_status    : Update status of a tracked issue
 *   - issue_summary          : Dashboard summary of all tracked issues
 *   - systemic_patterns      : Get systemic weaknesses identified
 *
 * Configuration (environment variables):
 *   FINERACT_BASE_URL  – Fineract API base URL (default: http://localhost:8080/...)
 *   FINERACT_TENANT_ID – Tenant ID (default: default)
 *   FINERACT_USERNAME  – API username
 *   FINERACT_PASSWORD  – API password
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createClientFromEnv } from "./utils/fineract-client.js";
import { auditGlMapping } from "./tools/audit-gl-mapping.js";
import { scanStandingInstructions } from "./tools/scan-standing-instructions.js";
import { getPortfolioSnapshot } from "./tools/portfolio-snapshot.js";
import { validateTopUpLoan, scanTopUpAnomalies } from "./tools/validate-topup-loan.js";
import {
  checkUnpostedPayments,
  getDailyCollectionValidation,
} from "./tools/reconciliation-checker.js";
import {
  listIssues,
  getIssue,
  updateIssueStatus,
  getIssueSummary,
  getSystemicPatterns,
} from "./tools/issue-tracker.js";
import { IssuePriority, IssueStatus } from "./types/index.js";

const server = new Server(
  {
    name: "mifos-system-doctor",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  }
);

// ─── Tool Definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "audit_gl_mapping",
      description:
        "Audit GL account mappings for loan products. Detects missing mappings, disabled GL accounts, and accounting rule mismatches. Addresses issues MF-002 and ISS-010.",
      inputSchema: {
        type: "object",
        properties: {
          productId: {
            type: "number",
            description: "Specific loan product ID to audit. Omit to audit all products.",
          },
        },
      },
    },
    {
      name: "scan_standing_instructions",
      description:
        "Scan active standing instructions for pre-deposit auto-pay risks. Flags instructions where savings balance is below instruction amount or no confirmed deposit exists. Addresses ISS-006.",
      inputSchema: {
        type: "object",
        properties: {
          lookbackHours: {
            type: "number",
            description: "Hours to look back for deposit confirmation (default: 24)",
            default: 24,
          },
        },
      },
    },
    {
      name: "get_portfolio_snapshot",
      description:
        "Get a point-in-time portfolio snapshot: active loan count, PAR ratio, aging buckets (1-30, 31-60, 61-90, 91-180, 181+), per-product and per-officer breakdown. Flags loans requiring freeze. Addresses RPT-001, RPT-006, ISS-013.",
      inputSchema: {
        type: "object",
        properties: {
          asOfDate: {
            type: "string",
            description: "Date for snapshot in YYYY-MM-DD format (default: today)",
          },
        },
      },
    },
    {
      name: "validate_loan_topup",
      description:
        "Validate that a top-up loan offset calculation uses only outstanding principal (not principal + future interest). Catches the ISS-001 bug. Provide loanId of the loan being topped up.",
      inputSchema: {
        type: "object",
        properties: {
          loanId: {
            type: "number",
            description: "ID of the existing (source) loan being topped up",
          },
          proposedTopUpAmount: {
            type: "number",
            description: "The proposed new top-up loan amount",
          },
        },
        required: ["loanId", "proposedTopUpAmount"],
      },
    },
    {
      name: "scan_topup_anomalies",
      description:
        "Scan all active loans to identify potential historical top-up miscalculations. Returns guidance for manual review. Addresses ISS-001.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "reconcile_payments",
      description:
        "Check for unposted/unmatched payments, detect USSD down payment misrouting, and surface CSV parser issues (Airtel/YO!/MTN). Addresses ISS-HUB-001 through ISS-HUB-006.",
      inputSchema: {
        type: "object",
        properties: {
          fromDate: {
            type: "string",
            description: "Start date for reconciliation range (YYYY-MM-DD)",
          },
          toDate: {
            type: "string",
            description: "End date for reconciliation range (YYYY-MM-DD)",
          },
        },
        required: ["fromDate", "toDate"],
      },
    },
    {
      name: "daily_collection_validation",
      description:
        "Get guidance for validating today's collections against expected repayments. Addresses ISS-003, RPT-004.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_issues",
      description:
        "List issues from the Mifos System Doctor issue register. Filter by domain, priority, status, or assigned person.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Filter by domain (e.g. 'Core Banking', 'HUB', 'Reporting')" },
          priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
          status: { type: "string", description: "Filter by issue status" },
          assignedTo: { type: "string", description: "Filter by assignee name" },
        },
      },
    },
    {
      name: "get_issue",
      description: "Get full details for a specific issue by ID (e.g. 'ISS-001', 'ISS-HUB-001', 'MF-002').",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
        },
        required: ["issueId"],
      },
    },
    {
      name: "update_issue_status",
      description: "Update the status of a tracked issue in the issue register.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          newStatus: {
            type: "string",
            enum: [
              "OPEN", "NEW", "IDENTIFIED", "ESCALATED", "AWAITING DEV",
              "PENDING GUIDANCE", "IN PROGRESS", "RESOLVED", "ENHANCEMENT", "BUG", "CONFIG",
            ],
          },
          notes: { type: "string", description: "Optional update notes" },
        },
        required: ["issueId", "newStatus"],
      },
    },
    {
      name: "issue_summary",
      description:
        "Get a dashboard summary of all tracked issues: totals by priority, status, and domain.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "systemic_patterns",
      description:
        "List the major systemic weaknesses identified in the Mifos/Helaplus platform that cut across multiple issues.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const client = createClientFromEnv();

  try {
    switch (name) {
      case "audit_gl_mapping": {
        const { productId } = z.object({ productId: z.number().optional() }).parse(args ?? {});
        const results = await auditGlMapping(client, productId);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "scan_standing_instructions": {
        const { lookbackHours } = z.object({ lookbackHours: z.number().default(24) }).parse(args ?? {});
        const results = await scanStandingInstructions(client, lookbackHours);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "get_portfolio_snapshot": {
        const { asOfDate } = z.object({ asOfDate: z.string().optional() }).parse(args ?? {});
        const { snapshot, audits } = await getPortfolioSnapshot(client, asOfDate);
        return { content: [{ type: "text", text: JSON.stringify({ snapshot, audits }, null, 2) }] };
      }

      case "validate_loan_topup": {
        const { loanId, proposedTopUpAmount } = z
          .object({ loanId: z.number(), proposedTopUpAmount: z.number() })
          .parse(args);
        const { validation, audits } = await validateTopUpLoan(client, loanId, proposedTopUpAmount);
        return { content: [{ type: "text", text: JSON.stringify({ validation, audits }, null, 2) }] };
      }

      case "scan_topup_anomalies": {
        const audits = await scanTopUpAnomalies(client);
        return { content: [{ type: "text", text: JSON.stringify(audits, null, 2) }] };
      }

      case "reconcile_payments": {
        const { fromDate, toDate } = z
          .object({ fromDate: z.string(), toDate: z.string() })
          .parse(args);
        const { entries, audits } = await checkUnpostedPayments(client, fromDate, toDate);
        return { content: [{ type: "text", text: JSON.stringify({ entries, audits }, null, 2) }] };
      }

      case "daily_collection_validation": {
        const audits = await getDailyCollectionValidation(client);
        return { content: [{ type: "text", text: JSON.stringify(audits, null, 2) }] };
      }

      case "list_issues": {
        const filters = z
          .object({
            domain: z.string().optional(),
            priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
            status: z.string().optional(),
            assignedTo: z.string().optional(),
          })
          .parse(args ?? {});
        const issues = listIssues({
          ...filters,
          priority: filters.priority as IssuePriority | undefined,
          status: filters.status as IssueStatus | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }] };
      }

      case "get_issue": {
        const { issueId } = z.object({ issueId: z.string() }).parse(args);
        const issue = getIssue(issueId);
        if (!issue) {
          return { content: [{ type: "text", text: `Issue ${issueId} not found.` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }] };
      }

      case "update_issue_status": {
        const { issueId, newStatus, notes } = z
          .object({
            issueId: z.string(),
            newStatus: z.string(),
            notes: z.string().optional(),
          })
          .parse(args);
        const result = updateIssueStatus(issueId, newStatus as IssueStatus, notes);
        return { content: [{ type: "text", text: result.message }], isError: !result.success };
      }

      case "issue_summary": {
        const summary = getIssueSummary();
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "systemic_patterns": {
        const patterns = getSystemicPatterns();
        const text = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Mifos System Doctor MCP server running on stdio.");
