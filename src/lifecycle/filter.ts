/**
 * Result filtering and summarization.
 *
 * Applied in tool.execute.after to truncate long outputs and extract
 * structured information before returning to the main agent.
 */

import type { DelegateTaskOutput } from "../tools/delegate-task.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LINES = 200;
const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter and summarize a delegate_task result.
 *
 * - Truncates details if too long
 * - Extracts key signals per task type (test summary, first error, stderr)
 * - Returns a clean DelegateTaskOutput
 */
export function filterResult(
  result: DelegateTaskOutput,
  taskType?: string,
): DelegateTaskOutput {
  let details = result.details;
  let summary = result.summary;
  const anomalies = [...result.anomalies];
  const facts: string[] = [];

  // --- Task-type-aware extraction ---
  if (details) {
    const raw = details;

    // For test tasks: extract test summary
    if (taskType === "run_and_observe") {
      const testSummary = extractTestSummary(raw);
      if (testSummary && !summary.includes(testSummary)) {
        summary = `${summary} | ${testSummary}`;
        facts.push(`test_summary: ${testSummary}`);
      }
    }

    // For all tasks: extract first error if not already in summary
    const firstError = extractFirstError(raw);
    if (firstError && !summary.includes(firstError)) {
      facts.push(`first_error: ${firstError}`);
    }

    // For all tasks: detect stderr
    const stderr = extractStderr(raw);
    if (stderr) {
      facts.push("stderr detected");
    }
  }

  // --- Truncation ---
  if (details) {
    const lines = details.split("\n");
    if (lines.length > MAX_OUTPUT_LINES) {
      details = [
        `[Output truncated: ${lines.length} lines total, showing first ${MAX_OUTPUT_LINES}]`,
        ...lines.slice(0, MAX_OUTPUT_LINES),
      ].join("\n");
    }
  }

  if (summary.length > MAX_SUMMARY_LENGTH) {
    summary = summary.slice(0, MAX_SUMMARY_LENGTH) + "...";
  }

  if (facts.length > 0) {
    details = details ? `${details}\n\nFACTS:\n${facts.join("\n")}` : `FACTS:\n${facts.join("\n")}`;
  }

  return { ...result, summary, details, anomalies };
}

/**
 * Extract structured information from raw test output.
 * Looks for common test result patterns (pass/fail counts, error summaries).
 */
export function extractTestSummary(raw: string): string | null {
  // Jest / Vitest pattern: "Tests: 2 failed, 48 passed, 50 total"
  const jestMatch = raw.match(/Tests:\s*(.+)/i);
  if (jestMatch) return jestMatch[1];

  // pytest pattern: "===== 45 passed, 2 failed in 12.34s ====="
  const pytestMatch = raw.match(/=+\s*(\d+ passed.*?\d+ failed.*?)\s*in\s*[\d.]+s\s*=+/i);
  if (pytestMatch) return pytestMatch[1];

  // Go test pattern: "ok  	pkg/name	0.123s" or "FAIL	pkg/name	0.123s"
  const goMatch = raw.match(/(ok|FAIL)\s+\S+\s+[\d.]+s/g);
  if (goMatch) {
    const ok = goMatch.filter((m) => m.startsWith("ok")).length;
    const fail = goMatch.filter((m) => m.startsWith("FAIL")).length;
    return `${ok} passed, ${fail} failed (${goMatch.length} total packages)`;
  }

  // Cargo test pattern: "test result: ok. 42 passed; 1 failed; 0 ignored"
  const cargoMatch = raw.match(/test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed/);
  if (cargoMatch) {
    return `${cargoMatch[2]} passed, ${cargoMatch[3]} failed (${cargoMatch[1]})`;
  }

  return null;
}

/**
 * Extract the first error message from output.
 */
export function extractFirstError(raw: string): string | null {
  const lines = raw.split("\n");
  for (const line of lines) {
    if (/\b(error|fatal|panic|FAIL)\b/i.test(line)) {
      return line.trim();
    }
  }
  return null;
}

/**
 * Extract stderr content from combined output.
 */
export function extractStderr(raw: string): string | null {
  // Look for common stderr markers
  const stderrMatch = raw.match(/stderr[:\s]*([\s\S]*?)(?=stdout|$)/i);
  if (stderrMatch) return stderrMatch[1].trim();

  // Look for lines that appear to be stderr (prefixed with "Error:", "ERR:", etc.)
  const errorLines = raw
    .split("\n")
    .filter((line) => /^(Error|ERR|FATAL|WARN):\s/i.test(line));

  return errorLines.length > 0 ? errorLines.join("\n") : null;
}
