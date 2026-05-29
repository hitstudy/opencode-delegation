/**
 * delegate_task tool definition.
 *
 * This tool is registered by the plugin and exposed to the main agent.
 * It wraps OpenCode's native `task` tool with enhanced behavior:
 * - Injects execution constraints into the worker prompt
 * - Filters/summarizes the result before returning
 * - Provides structured input/output
 */

import type { TaskType } from "../detection/patterns.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DelegateTaskInput = {
  task_type: TaskType;
  command?: string;
  prompt: string;
  timeout?: number;
  on_failure?: "report" | "retry" | "abort";
  max_retries?: number;
  output_filter?: string;
};

export type DelegateTaskOutput = {
  status: "success" | "failure" | "timeout" | "anomaly";
  summary: string;
  details?: string;
  anomalies: string[];
  duration: number;
};

// ---------------------------------------------------------------------------
// Prompt templates per task type
// ---------------------------------------------------------------------------

const TASK_TYPE_INSTRUCTIONS: Record<TaskType, string> = {
  run_and_observe: `
You are executing a command and observing its output.
- Run the command exactly as specified.
- Watch for errors, warnings, and non-zero exit codes.
- If output is very long (>200 lines), summarize it: total lines, pass/fail counts, first 5 errors.
- Report the structured result at the end.`,

  wait_and_monitor: `
You are monitoring a long-running process.
- Start the command as specified.
- Observe the output for the specified duration.
- Flag any errors, warnings, or anomalies you see.
- When done (or when timeout is reached), report what you observed.
- If the process hangs or produces excessive output, report that.`,

  filter_and_summarize: `
You are processing output to extract specific information.
- Run the command or read the specified data.
- Extract only the information requested in the prompt.
- Discard noise and irrelevant lines.
- Present the extracted information concisely.`,

  process_batch: `
You are performing a batch operation.
- Execute the operation on each item as specified.
- Track success/failure counts.
- Report failures with their specific error messages.
- Provide a summary at the end.`,
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the complete prompt for the worker subagent.
 *
 * Combines:
 * 1. Task-type-specific instructions
 * 2. Execution constraints (output limits, timeout, anomaly detection)
 * 3. The user's task description
 */
export function buildWorkerPrompt(input: DelegateTaskInput): string {
  const typeInstructions = TASK_TYPE_INSTRUCTIONS[input.task_type] ?? TASK_TYPE_INSTRUCTIONS.run_and_observe;

  const constraints: string[] = [];

  // Output constraint
  constraints.push("Maximum output: 200 lines. If exceeded, summarize instead of dumping.");

  // Timeout constraint
  if (input.timeout) {
    const seconds = Math.round(input.timeout / 1000);
    constraints.push(`Timeout: ${seconds} seconds. If the command does not complete within this time, report timeout status.`);
  }

  // Output filter
  if (input.output_filter) {
    constraints.push(`Output filter: apply regex "${input.output_filter}" to filter output lines. Only include matching lines in details.`);
  }

  // Command
  if (input.command) {
    constraints.push(`Command to execute: ${input.command}`);
  }

  const sections = [
    "## Task Type Instructions",
    typeInstructions.trim(),
    "",
    "## Execution Constraints",
    constraints.map((c) => `- ${c}`).join("\n"),
    "",
    "## Task Description",
    input.prompt.trim(),
    "",
    "## Required Output Format",
    "Always end with this block:",
    "```",
    "RESULT: [success | failure | timeout | anomaly]",
    "SUMMARY: [one-line summary]",
    "DETAILS: [key details, truncated to 50 lines]",
    "ANOMALIES: [comma-separated list, or 'none']",
    "```",
  ];

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Result parser — with fallback strategies
// ---------------------------------------------------------------------------

const RESULT_REGEX = /RESULT:\s*(success|failure|timeout|anomaly)/i;
const SUMMARY_REGEX = /SUMMARY:\s*(.+)/i;
const DETAILS_REGEX = /DETAILS:\s*([\s\S]*?)(?=ANOMALIES:|$)/i;
const ANOMALIES_REGEX = /ANOMALIES:\s*(.+)/i;

/**
 * Parse the worker's structured output into a DelegateTaskOutput.
 *
 * Parsing strategy (in order):
 * 1. Try strict structured format (RESULT/SUMMARY/DETAILS/ANOMALIES)
 * 2. Try partial structured format (any 2+ fields present)
 * 3. Try heuristic inference from raw text
 * 4. Fall back to treating the entire raw text as a summary
 */
export function parseWorkerResult(raw: string, duration: number): DelegateTaskOutput {
  // --- Strategy 1: Full structured format ---
  const resultMatch = raw.match(RESULT_REGEX);
  const summaryMatch = raw.match(SUMMARY_REGEX);
  const detailsMatch = raw.match(DETAILS_REGEX);
  const anomaliesMatch = raw.match(ANOMALIES_REGEX);

  if (resultMatch && summaryMatch) {
    // Good enough — we have RESULT and SUMMARY
    const status = resultMatch[1].toLowerCase() as DelegateTaskOutput["status"];
    const summary = summaryMatch[1].trim();
    const details = detailsMatch?.[1]?.trim() ?? undefined;
    const anomaliesRaw = anomaliesMatch?.[1]?.trim() ?? "none";
    const anomalies =
      anomaliesRaw.toLowerCase() === "none"
        ? []
        : anomaliesRaw.split(",").map((a) => a.trim()).filter(Boolean);

    return { status, summary, details, anomalies, duration };
  }

  // --- Strategy 2: Heuristic inference ---
  return inferFromRawText(raw, duration);
}

/**
 * Infer result structure from raw text when structured format is missing.
 *
 * Heuristics:
 * - Look for common failure indicators to determine status
 * - Use first non-empty line as summary
 * - Use remaining text as details
 * - Look for error indicators to populate anomalies
 */
function inferFromRawText(raw: string, duration: number): DelegateTaskOutput {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {
      status: "failure",
      summary: "Worker returned empty output",
      anomalies: ["empty_output"],
      duration,
    };
  }

  // Detect status from content
  const status = inferStatus(trimmed);

  // Use first non-empty line as summary, rest as details
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const summary = lines[0]?.slice(0, 500) ?? "No summary";
  const details = lines.length > 1 ? lines.slice(1).join("\n") : undefined;

  // Detect anomalies from content
  const anomalies = inferAnomalies(trimmed);

  return { status, summary, details, anomalies, duration };
}

/**
 * Infer status from text content.
 */
function inferStatus(text: string): DelegateTaskOutput["status"] {
  const lower = text.toLowerCase();

  // Strong failure indicators
  if (/\b(fatal|panic|crash|segfault|killed|oom)\b/.test(lower)) return "failure";
  if (/\bexit\s*(code|status)\s*[^0]/.test(text)) return "failure";

  // Timeout indicators
  if (/\btimeout|timed?\s*out|deadline\s*exceeded\b/.test(lower)) return "timeout";

  // Anomaly indicators (warnings, non-critical errors)
  if (/\b(warning|warn|deprecated|unexpected)\b/.test(lower)) return "anomaly";
  if (/\b(error|err|fail)\b/.test(lower)) return "anomaly";

  // Default: success
  return "success";
}

/**
 * Infer anomalies from text content.
 */
function inferAnomalies(text: string): string[] {
  const anomalies: string[] = [];
  const lower = text.toLowerCase();

  if (/\berror\b/.test(lower)) anomalies.push("error_detected");
  if (/\bfail/.test(lower)) anomalies.push("failure_detected");
  if (/\bwarning\b/.test(lower)) anomalies.push("warning_detected");
  if (/\btimeout\b/.test(lower)) anomalies.push("timeout_risk");
  if (/\bstderr\b/.test(lower)) anomalies.push("stderr_present");

  return anomalies;
}
