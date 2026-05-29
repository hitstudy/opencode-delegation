/**
 * delegation-lifecycle — OpenCode plugin for task delegation to low-cost worker subagents.
 *
 * MVP: foreground-only blocking delegation.
 *
 * Design notes on tool.execute.before:
 *   OpenCode's plugin hooks can mutate tool args but CANNOT redirect one tool
 *   to another.  Setting `_delegated` flags on bash args does nothing — bash
 *   still executes and ignores unknown fields.
 *
 *   Therefore the plugin takes a two-pronged approach:
 *   1. tool.definition — inject a hint into bash's description so the main
 *      model sees "use delegate_task for long commands" every time it considers
 *      bash.  Combined with the Skill, this steers the model toward delegation.
 *   2. tool.execute.after — for bash outputs that are very long, truncate and
 *      attach a structured summary so the main model's context isn't polluted.
 *   3. delegate_task tool — the explicit delegation mechanism for the main
 *      model to call when it decides a task is worth delegating.
 *
 * Hooks:
 * - tool.definition:    inject delegation hint into bash tool description
 * - tool.execute.before: no-op for bash (command runs normally)
 * - tool.execute.after:  truncate long bash outputs, attach summaries
 * - event:               optional session error logging (debug only)
 * - tool:                register delegate_task custom tool
 */

import type { Plugin } from "@opencode-ai/plugin";
import { analyzeCommand } from "./detection/patterns.js";
import {
  buildWorkerPrompt,
  parseWorkerResult,
  type DelegateTaskInput,
  type DelegateTaskOutput,
} from "./tools/delegate-task.js";
import { filterResult, extractTestSummary, extractFirstError, extractStderr } from "./lifecycle/filter.js";
import { recordSessionError } from "./lifecycle/monitor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_RETRIES = 2;
const BASH_OUTPUT_TRUNCATE_LINES = 300;

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default (async () => {
  return {
    // -----------------------------------------------------------------------
    // Hook 1: Inject delegation hint into bash tool description
    // -----------------------------------------------------------------------
    "tool.definition": async (input, output) => {
      if (input.tool === "bash") {
        output.description +=
          "\n\nIMPORTANT: For long-running or high-output commands (test suites, builds, log monitoring, heavy search), " +
          "prefer the delegate_task tool instead of bash. delegate_task runs the command in a subagent with a cheap model, " +
          "saving main-model tokens and context. Use bash only for quick commands (< 30s, < 200 lines output).";
      }
    },

    // -----------------------------------------------------------------------
    // Hook 2: Before execution — no-op for bash
    //
    // We cannot redirect bash to delegate_task here. The hook only allows
    // mutating args, not changing which tool executes.  The delegation
    // decision must happen BEFORE the tool call, guided by the Skill.
    // -----------------------------------------------------------------------
    "tool.execute.before": async (_input, _output) => {
      // No-op. Delegation is guided by tool.definition hint + Skill.
    },

    // -----------------------------------------------------------------------
    // Hook 3: After execution — post-process long bash outputs
    //
    // If bash produced a very long output, truncate it and attach a
    // structured summary so the main model's context isn't polluted.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input, output) => {
      // --- Post-process delegate_task results ---
      if (input.tool === "delegate_task" && output?.result) {
        try {
          const raw = typeof output.result === "string" ? output.result : JSON.stringify(output.result);
          const taskType = input.args?.task_type;
          const parsed = parseWorkerResult(raw, 0);
          const filtered = filterResult(parsed, taskType);
          output.result = JSON.stringify(filtered, null, 2);
        } catch {
          // Parsing failed — leave result as-is
        }
        return;
      }

      // --- Post-process long bash outputs ---
      if (input.tool === "bash" && output?.result) {
        try {
          const raw = typeof output.result === "string" ? output.result : JSON.stringify(output.result);
          const lines = raw.split("\n");

          if (lines.length > BASH_OUTPUT_TRUNCATE_LINES) {
            // Extract useful signals before truncating
            const testSummary = extractTestSummary(raw);
            const firstError = extractFirstError(raw);
            const stderr = extractStderr(raw);

            const summaryParts: string[] = [
              `[Output truncated: ${lines.length} lines, showing first ${BASH_OUTPUT_TRUNCATE_LINES}]`,
            ];
            if (testSummary) summaryParts.push(`Test summary: ${testSummary}`);
            if (firstError) summaryParts.push(`First error: ${firstError}`);
            if (stderr) summaryParts.push(`stderr detected`);

            output.result = [
              ...summaryParts,
              "---",
              ...lines.slice(0, BASH_OUTPUT_TRUNCATE_LINES),
            ].join("\n");
          }
        } catch {
          // Leave output as-is
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hook 4: Event monitoring (optional, debug only)
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const sessionId = (event as any).sessionId ?? (event as any).id;
        const error = (event as any).error ?? (event as any).message;
        if (sessionId) {
          recordSessionError(sessionId, error);
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hook 5: Register delegate_task custom tool
    // -----------------------------------------------------------------------
    tool: {
      delegate_task: {
        description:
          "Delegate a low-cognitive task to a worker subagent. Use for running commands, waiting for results, " +
          "processing large output, or repetitive work. The worker runs independently with a cheap model and " +
          "returns structured results. Prefer this over bash for long-running or high-output commands.",
        parameters: {
          type: "object",
          properties: {
            task_type: {
              type: "string",
              enum: ["run_and_observe", "wait_and_monitor", "filter_and_summarize", "process_batch"],
              description: "Type of task to delegate",
            },
            command: {
              type: "string",
              description: "Bash command to execute (for run_and_observe tasks)",
            },
            prompt: {
              type: "string",
              description: "Task description for the worker. Include only what the worker needs to know.",
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds (default: 300000 = 5 minutes)",
            },
            on_failure: {
              type: "string",
              enum: ["report", "retry", "abort"],
              description: "Action on failure. Default: report (worker reports error, you decide next steps)",
            },
            max_retries: {
              type: "number",
              description: "Maximum retries for on_failure: retry (default: 2)",
            },
            output_filter: {
              type: "string",
              description: "Regex pattern to filter output lines",
            },
          },
          required: ["task_type", "prompt"],
        },
        execute: async (args: DelegateTaskInput, ctx: any) => {
          const startTime = Date.now();
          const on_failure = args.on_failure ?? "report";
          const max_retries = args.max_retries ?? MAX_RETRIES;

          const workerPrompt = buildWorkerPrompt(args);

          let lastResult: DelegateTaskOutput | null = null;
          const totalAttempts = on_failure === "retry" ? max_retries + 1 : 1;

          for (let attempt = 0; attempt < totalAttempts; attempt++) {
            try {
              const taskResult = await ctx.extra.promptOps({
                description: `delegate: ${args.task_type}`,
                prompt: workerPrompt,
                subagent_type: "worker",
                background: false,
              });

              const duration = Date.now() - startTime;
              const raw = typeof taskResult === "string" ? taskResult : JSON.stringify(taskResult);
              lastResult = parseWorkerResult(raw, duration);
              lastResult = filterResult(lastResult, args.task_type);

              if (lastResult.status === "success" || lastResult.status === "anomaly") {
                return JSON.stringify(lastResult, null, 2);
              }

              if (on_failure === "report" || on_failure === "abort") {
                return JSON.stringify(lastResult, null, 2);
              }

              // on_failure === "retry" → continue loop
            } catch (error) {
              const duration = Date.now() - startTime;
              lastResult = {
                status: "failure",
                summary: `Worker execution failed: ${error instanceof Error ? error.message : String(error)}`,
                anomalies: ["worker_error"],
                duration,
              };

              if (on_failure !== "retry" || attempt === totalAttempts - 1) {
                return JSON.stringify(lastResult, null, 2);
              }
            }
          }

          return JSON.stringify(
            lastResult ?? {
              status: "failure",
              summary: "Unknown error during delegation",
              anomalies: ["unknown"],
              duration: Date.now() - startTime,
            },
            null,
            2,
          );
        },
      },
    },
  };
}) satisfies Plugin;
