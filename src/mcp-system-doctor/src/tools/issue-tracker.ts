/**
 * Tool: track_issue / list_issues / update_issue_status
 *
 * In-process issue tracker backed by the issues-register.json.
 * Allows the MCP server to list, query, and update issue statuses
 * without needing an external system.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { IssueRecord, IssuePriority, IssueStatus } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTER_PATH = resolve(
  __dirname,
  "../../../../../../docs/issues/issues-register.json"
);

interface IssueRegister {
  meta: Record<string, string>;
  issues: IssueRecord[];
  systemicPatterns: string[];
  priorityMatrix: Record<string, string[]>;
}

function loadRegister(): IssueRegister {
  const raw = readFileSync(REGISTER_PATH, "utf-8");
  return JSON.parse(raw) as IssueRegister;
}

function saveRegister(register: IssueRegister): void {
  writeFileSync(REGISTER_PATH, JSON.stringify(register, null, 2), "utf-8");
}

export function listIssues(filters?: {
  domain?: string;
  priority?: IssuePriority;
  status?: IssueStatus;
  assignedTo?: string;
}): IssueRecord[] {
  const register = loadRegister();
  let issues = register.issues;

  if (filters?.domain) {
    issues = issues.filter((i) =>
      i.domain.toLowerCase().includes(filters.domain!.toLowerCase())
    );
  }
  if (filters?.priority) {
    issues = issues.filter((i) => i.priority === filters.priority);
  }
  if (filters?.status) {
    issues = issues.filter((i) => i.status === filters.status);
  }
  if (filters?.assignedTo) {
    issues = issues.filter((i) =>
      i.assignedTo?.toLowerCase().includes(filters.assignedTo!.toLowerCase())
    );
  }

  return issues;
}

export function getIssue(id: string): IssueRecord | undefined {
  const register = loadRegister();
  return register.issues.find((i) => i.id === id);
}

export function updateIssueStatus(id: string, newStatus: IssueStatus, notes?: string): { success: boolean; message: string } {
  const register = loadRegister();
  const issue = register.issues.find((i) => i.id === id);

  if (!issue) {
    return { success: false, message: `Issue ${id} not found.` };
  }

  const oldStatus = issue.status;
  issue.status = newStatus;
  if (notes) {
    issue.suggestedFix = (issue.suggestedFix ?? "") + `\n[Update ${new Date().toISOString()}]: ${notes}`;
  }

  saveRegister(register);
  return {
    success: true,
    message: `Issue ${id} status updated: ${oldStatus} → ${newStatus}.`,
  };
}

export function getIssueSummary(): {
  total: number;
  byCriticality: Record<string, number>;
  byStatus: Record<string, number>;
  byDomain: Record<string, number>;
} {
  const register = loadRegister();
  const issues = register.issues;

  const byCriticality: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byDomain: Record<string, number> = {};

  for (const issue of issues) {
    byCriticality[issue.priority] = (byCriticality[issue.priority] ?? 0) + 1;
    byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
    byDomain[issue.domain] = (byDomain[issue.domain] ?? 0) + 1;
  }

  return { total: issues.length, byCriticality, byStatus, byDomain };
}

export function getSystemicPatterns(): string[] {
  const register = loadRegister();
  return register.systemicPatterns;
}
