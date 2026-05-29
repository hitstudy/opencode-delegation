/**
 * delegation-lifecycle — OpenCode plugin for task delegation to low-cost worker subagents.
 *
 * MVP: foreground-only blocking delegation.
 *
 * Hooks:
 * - tool.definition:    inject delegation hint into bash tool description
 * - tool.execute.before: no-op (cannot redirect tools)
 * - tool.execute.after:  truncate long bash outputs, attach summaries
 * - event:               optional session error logging (debug only)
 * - tool:                register delegate_task custom tool
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  buildWorkerPrompt,
  parseWorkerResult,
  type DelegateTaskOutput,
} from "./tools/delegate-task.js";
import { filterResult, extractTestSummary, extractFirstError, extractStderr } from "./lifecycle/filter.js";
import { recordSessionError } from "./lifecycle/monitor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;
const BASH_OUTPUT_TRUNCATE_LINES = 300;
const WORKER_AGENT = "worker";

type DelegationPluginOptions = {
  workerAgent?: string;
};

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default (async ({ client }, options?: DelegationPluginOptions) => {
  const workerAgent = options?.workerAgent ?? WORKER_AGENT;

  return {
    // --- Hook 1: Inject delegation hint into bash tool description ---
    "tool.definition": async (input, output) => {
      if (input.toolID === "bash") {
        output.description +=
          "\n\nIMPORTANT: For long-running or high-output commands (test suites, builds, log monitoring, heavy search), " +
          "prefer the delegate_task tool instead of bash. delegate_task runs the command in a subagent with a cheap model, " +
          "saving main-model tokens and context. Use bash only for quick commands (< 30s, < 200 lines output).";
      }
    },

    // --- Hook 2: Before execution — no-op ---
    "tool.execute.before": async (_input, _output) => {},

    // --- Hook 3: After execution — post-process long outputs ---
    "tool.execute.after": async (input, output) => {
      if (input.tool === "delegate_task") {
        // delegate_task already parses and filters worker output in execute().
        return;
      }

      // Post-process long bash outputs
      if (input.tool === "bash") {
        try {
          const raw = output.output;
          const lines = raw.split("\n");

          if (lines.length > BASH_OUTPUT_TRUNCATE_LINES) {
            const testSummary = extractTestSummary(raw);
            const firstError = extractFirstError(raw);
            const stderr = extractStderr(raw);

            const summaryParts: string[] = [
              `[Output truncated: ${lines.length} lines, showing first ${BASH_OUTPUT_TRUNCATE_LINES}]`,
            ];
            if (testSummary) summaryParts.push(`Test summary: ${testSummary}`);
            if (firstError) summaryParts.push(`First error: ${firstError}`);
            if (stderr) summaryParts.push(`stderr detected`);

            output.output = [
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

    // --- Hook 4: Event monitoring (debug only) ---
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const sessionId = (event as any).sessionId ?? (event as any).id;
        const error = (event as any).error ?? (event as any).message;
        if (sessionId) {
          recordSessionError(sessionId, error);
        }
      }
    },

    // --- Hook 5: Register delegate_task tool ---
    tool: {
      delegate_task: tool({
        description:
          "Delegate a low-cognitive task to a worker subagent. Use for running commands, waiting for results, " +
          "processing large output, or repetitive work. The worker runs independently with a cheap model and " +
          "returns structured results. Prefer this over bash for long-running or high-output commands.",
        args: {
          task_type: tool.schema
            .enum(["run_and_observe", "wait_and_monitor", "filter_and_summarize", "process_batch"])
            .describe("Type of task to delegate"),
          command: tool.schema
            .string()
            .optional()
            .describe("Bash command to execute (for run_and_observe tasks)"),
          prompt: tool.schema
            .string()
            .describe("Task description for the worker. Include only what the worker needs to know."),
          focus: tool.schema
            .string()
            .optional()
            .describe("What the worker should pay attention to: specific errors, patterns, success/failure criteria. E.g. 'Look for TypeScript compilation errors and test failures. Success = exit code 0.'"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("Timeout in milliseconds (default: 300000 = 5 minutes)"),
          on_failure: tool.schema
            .enum(["report", "retry", "abort"])
            .optional()
            .describe("Action on failure. Default: report"),
          max_retries: tool.schema
            .number()
            .optional()
            .describe("Maximum retries for on_failure: retry (default: 2)"),
          output_filter: tool.schema
            .string()
            .optional()
            .describe("Regex pattern to filter output lines"),
        },
        async execute(args, _ctx) {
          const startTime = Date.now();
          const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS;
          const maxRetries = args.on_failure === "retry" ? args.max_retries ?? MAX_RETRIES : 0;

          const input = {
            task_type: args.task_type,
            command: args.command,
            prompt: args.prompt,
            focus: args.focus,
            timeout: args.timeout,
            on_failure: args.on_failure,
            max_retries: args.max_retries,
            output_filter: args.output_filter,
          };

          const workerPrompt = buildWorkerPrompt(input);
          let lastResult: DelegateTaskOutput | undefined;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const raw = await runWorkerTask({
                client,
                parentSessionID: _ctx.sessionID,
                directory: _ctx.directory,
                workerAgent,
                prompt: workerPrompt,
                timeout,
              });

              const parsed = parseWorkerResult(raw, Date.now() - startTime);
              lastResult = filterResult(parsed, args.task_type);

              if (lastResult.status === "failure" && args.on_failure === "retry" && attempt < maxRetries) {
                continue;
              }

              return JSON.stringify(lastResult, null, 2);
            } catch (error) {
              lastResult = {
                status: isTimeoutError(error) ? "timeout" : "failure",
                summary: `Worker delegation failed: ${error instanceof Error ? error.message : String(error)}`,
                anomalies: [isTimeoutError(error) ? "worker_timeout" : "worker_error"],
                duration: Date.now() - startTime,
              };

              if (args.on_failure === "retry" && attempt < maxRetries) {
                continue;
              }

              return JSON.stringify(lastResult, null, 2);
            }
          }

          return JSON.stringify(
            lastResult ?? {
              status: "failure",
              summary: "Worker delegation failed without a result",
              anomalies: ["worker_error"],
              duration: Date.now() - startTime,
            },
            null,
            2,
          );
        },
      }),
    },
  };
}) satisfies Plugin;

async function runWorkerTask(input: {
  client: Parameters<Plugin>[0]["client"];
  parentSessionID: string;
  directory: string;
  workerAgent: string;
  prompt: string;
  timeout: number;
}): Promise<string> {
  let workerSessionID: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkerTimeoutError(input.timeout)), input.timeout);
  });

  try {
    return await Promise.race([
    (async () => {
      const created = await input.client.session.create({
        body: {
          parentID: input.parentSessionID,
          title: "delegated worker task",
        },
        query: {
          directory: input.directory,
        },
      });

      if (created.error || !created.data) {
        throw new Error(`Failed to create worker session: ${JSON.stringify(created.error ?? "no data")}`);
      }
      workerSessionID = created.data.id;

      const response = await input.client.session.prompt({
        path: {
          id: workerSessionID,
        },
        query: {
          directory: input.directory,
        },
        body: {
          agent: input.workerAgent,
          parts: [
            {
              type: "text",
              text: input.prompt,
            },
          ],
        },
      });

      if (response.error || !response.data) {
        throw new Error(`Worker prompt failed: ${JSON.stringify(response.error ?? "no data")}`);
      }

      const text = response.data.parts
        .filter((part): part is Extract<typeof part, { type: "text" | "reasoning" }> => part.type === "text" || part.type === "reasoning")
        .map((part) => part.text)
        .join("\n")
        .trim();

      return text || JSON.stringify(response.data);
    })(),
    timeoutPromise,
  ]);
  } catch (error) {
    if (workerSessionID && isTimeoutError(error)) {
      await abortWorkerSession(input.client, workerSessionID).catch(() => {});
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof WorkerTimeoutError || (error instanceof Error && /timed out|timeout/i.test(error.message));
}

async function abortWorkerSession(client: Parameters<Plugin>[0]["client"], sessionID: string): Promise<void> {
  const aborted = await client.session.abort({
    path: {
      id: sessionID,
    },
  });

  if (aborted.error) {
    throw new Error(`Failed to abort timed-out worker session: ${JSON.stringify(aborted.error)}`);
  }
}

class WorkerTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Timed out after ${Math.round(timeout / 1000)}s`);
    this.name = "WorkerTimeoutError";
  }
}
