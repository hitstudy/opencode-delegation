/**
 * delegation-lifecycle — Self-contained OpenCode plugin for task delegation.
 *
 * This is the .opencode/plugins/ version — all logic is inlined since
 * it cannot import from the npm package.
 *
 * MVP: foreground-only blocking delegation.
 *
 * Design notes:
 *   OpenCode's plugin hooks can mutate tool args but CANNOT redirect one tool
 *   to another.  Therefore:
 *   1. tool.definition — inject hint into bash description
 *   2. tool.execute.after — post-process long bash outputs
 *   3. delegate_task tool — explicit delegation mechanism
 */

import type { Plugin } from "@opencode-ai/plugin";

// ===========================================================================
// Inline: Types
// ===========================================================================

type TaskType = "run_and_observe" | "wait_and_monitor" | "filter_and_summarize" | "process_batch";

type DelegateTaskInput = {
  task_type: TaskType;
  command?: string;
  prompt: string;
  timeout?: number;
  on_failure?: "report" | "retry" | "abort";
  max_retries?: number;
  output_filter?: string;
};

type DelegateTaskOutput = {
  status: "success" | "failure" | "timeout" | "anomaly";
  summary: string;
  details?: string;
  anomalies: string[];
  duration: number;
};

type CommandShape = {
  executable: string;
  args: string[];
  positional: string[];
  flags: Set<string>;
  redirections: string[];
  raw: string;
};

// ===========================================================================
// Inline: Command Pattern Matching
// ===========================================================================

const AUTO_DELEGATE_PATTERNS: Record<TaskType, RegExp[]> = {
  run_and_observe: [
    /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
    /\bjest\b/, /\bvitest\b/, /\bmocha\b/, /\bpytest\b/,
    /\bgo\s+test\b/, /\bcargo\s+test\b/, /\bphpunit\b/,
    /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
    /\bmake\b/, /\bcmake\b/, /\bgradle\b/, /\bmvn\b/,
    /\bcargo\s+build\b/, /\bwebpack\b/, /\bvite\s+build\b/,
    /\btsc\b/, /\besbuild\b/,
  ],
  wait_and_monitor: [
    /\btail\s+.*-f\b/, /\bwatch\b/, /\blogcat\b/,
    /\bdocker\s+logs\s+.*-f\b/, /\bjournalctl\s+.*-f\b/,
    /\bkubectl\s+logs\s+.*-f\b/,
    /\b(npm|yarn|pnpm)\s+run\s+dev\b/,
    /\bwebpack-dev-server\b/, /\bvite\b(?!.*build)/,
    /\bnodemon\b/, /\btsx\s+watch\b/,
  ],
  filter_and_summarize: [
    /\bgrep\s+.*-r\b/, /\brg\b/, /\bfind\s+.*-exec\b/, /\bxargs\b/,
  ],
  process_batch: [],
};

const NEVER_INTERCEPT_PATTERNS: RegExp[] = [
  /\bgit\s+(status|diff|show|log|branch|tag|remote)\b/,
  /\b(cd|ls|pwd|cat|head)\b/,
  /\b(cp|mv|rm|mkdir|touch|ln)\b/,
  /\b(vim|nano|code|emacs)\b/,
  /\bnpm\s+install\b/,
];

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of command) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === " " && !inQuote) { if (current) { tokens.push(current); current = ""; } continue; }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseCommandShape(command: string): CommandShape {
  const tokens = tokenize(command);
  const executable = tokens[0] ?? "";
  const args = tokens.slice(1);
  const positional: string[] = [];
  const flags = new Set<string>();
  const redirections: string[] = [];
  for (const arg of args) {
    if (arg === "-v" || arg === "--verbose") flags.add("verbose");
    if (arg === "-f" || arg === "--follow") flags.add("follow");
    if (arg.includes("/dev/null")) redirections.push("/dev/null");
    if (!arg.startsWith("-") && !arg.includes("=")) positional.push(arg);
    if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "v") flags.add("verbose");
        if (ch === "f") flags.add("follow");
      }
    }
  }
  return { executable, args, positional, flags, redirections, raw: command };
}

function analyzeCommand(command: string): { delegate: boolean; taskType?: TaskType; reason?: string } {
  if (NEVER_INTERCEPT_PATTERNS.some((p) => p.test(command))) return { delegate: false };
  for (const [taskType, patterns] of Object.entries(AUTO_DELEGATE_PATTERNS)) {
    if (patterns.some((p) => p.test(command))) return { delegate: true, taskType: taskType as TaskType, reason: "auto" };
  }
  return { delegate: false };
}

// ===========================================================================
// Inline: Risk Estimation (subcommand-aware)
// ===========================================================================

const PM_FAST_SUBCOMMANDS = new Set(["ls", "list", "info", "view", "outdated", "why", "config", "prefix", "root", "bin", "whoami", "init", "login", "logout", "owner", "team", "cache", "pack", "publish", "unpublish"]);
const PM_SLOW_SUBCOMMANDS = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "upgrade", "audit", "rebuild", "ci", "clean-install"]);

function getSubcommand(shape: CommandShape): string {
  return shape.positional[0] ?? "";
}

function estimateRisk(command: string): { outputRisk: string; estimatedDurationMs: number; estimatedOutputLines: number } {
  const shape = parseCommandShape(command);
  let risk = "low";
  let duration = 5000;
  let lines = 50;

  if (shape.flags.has("verbose")) lines *= 4;
  if (shape.redirections.includes("/dev/null")) return { outputRisk: "low", estimatedDurationMs: duration, estimatedOutputLines: 0 };
  if (shape.raw.includes("2>&1")) lines *= 1.5;

  const exe = shape.executable.toLowerCase();

  // Test runners (cargo handled separately)
  if (exe.includes("jest") || exe.includes("vitest") || exe.includes("mocha") || exe.includes("pytest") || exe.includes("phpunit")) {
    duration = 120000; lines = 500; risk = "high";
  }
  // Build tools (vite handled separately)
  if (exe === "make" || exe === "cmake" || exe === "gradle" || exe === "mvn" || exe.includes("webpack") || exe === "tsc" || exe === "esbuild") {
    duration = 300000; lines = 300; risk = "high";
  }
  // Package managers — subcommand-aware
  if (exe === "npm" || exe === "yarn" || exe === "pnpm" || exe === "pip") {
    const sub = getSubcommand(shape);
    if (PM_SLOW_SUBCOMMANDS.has(sub)) { duration = 120000; lines = 200; risk = "high"; }
    else if (PM_FAST_SUBCOMMANDS.has(sub)) { duration = 5000; lines = 30; risk = "low"; }
    else { duration = 30000; lines = 100; risk = "medium"; }
  }
  // Compilers
  if (exe === "gcc" || exe === "g++" || exe === "rustc" || exe === "clang") {
    duration = 120000; lines = 200; risk = "high";
  }
  // Cargo — subcommand-aware
  if (exe === "cargo") {
    const sub = getSubcommand(shape);
    if (sub === "test") { duration = 120000; lines = 500; risk = "high"; }
    else if (sub === "build" || sub === "bench") { duration = 300000; lines = 300; risk = "high"; }
  }
  // Streaming
  if (shape.flags.has("follow")) { duration = Infinity; lines = Infinity; risk = "extreme"; }

  return { outputRisk: risk, estimatedDurationMs: duration, estimatedOutputLines: lines };
}

function shouldDelegateByRisk(command: string): boolean {
  const { outputRisk, estimatedDurationMs, estimatedOutputLines } = estimateRisk(command);
  if (outputRisk === "extreme") return true;
  if (estimatedDurationMs > 30000) return true;
  if (estimatedOutputLines > 500) return true;
  return false;
}

// ===========================================================================
// Inline: Prompt Builder
// ===========================================================================

const TASK_TYPE_INSTRUCTIONS: Record<TaskType, string> = {
  run_and_observe: `You are executing a command and observing its output.
- Run the command exactly as specified.
- Watch for errors, warnings, and non-zero exit codes.
- If output is very long (>200 lines), summarize it: total lines, pass/fail counts, first 5 errors.
- Report the structured result at the end.`,
  wait_and_monitor: `You are monitoring a long-running process.
- Start the command as specified.
- Observe the output for the specified duration.
- Flag any errors, warnings, or anomalies you see.
- When done (or when timeout is reached), report what you observed.`,
  filter_and_summarize: `You are processing output to extract specific information.
- Run the command or read the specified data.
- Extract only the information requested in the prompt.
- Discard noise and irrelevant lines.
- Present the extracted information concisely.`,
  process_batch: `You are performing a batch operation.
- Execute the operation on each item as specified.
- Track success/failure counts.
- Report failures with their specific error messages.
- Provide a summary at the end.`,
};

function buildWorkerPrompt(input: DelegateTaskInput): string {
  const typeInstructions = TASK_TYPE_INSTRUCTIONS[input.task_type] ?? TASK_TYPE_INSTRUCTIONS.run_and_observe;
  const constraints: string[] = ["Maximum output: 200 lines. If exceeded, summarize instead of dumping."];
  if (input.timeout) constraints.push(`Timeout: ${Math.round(input.timeout / 1000)} seconds.`);
  if (input.output_filter) constraints.push(`Output filter: apply regex "${input.output_filter}" to filter output lines.`);
  if (input.command) constraints.push(`Command to execute: ${input.command}`);
  return [
    "## Task Type Instructions", typeInstructions.trim(), "",
    "## Execution Constraints", constraints.map((c) => `- ${c}`).join("\n"), "",
    "## Task Description", input.prompt.trim(), "",
    "## Required Output Format", "Always end with this block:",
    "```", "RESULT: [success | failure | timeout | anomaly]",
    "SUMMARY: [one-line summary]", "DETAILS: [key details, truncated to 50 lines]",
    "ANOMALIES: [comma-separated list, or 'none']", "```",
  ].join("\n");
}

// ===========================================================================
// Inline: Result Parser (with fallback)
// ===========================================================================

function parseWorkerResult(raw: string, duration: number): DelegateTaskOutput {
  const r = raw.match(/RESULT:\s*(success|failure|timeout|anomaly)/i);
  const s = raw.match(/SUMMARY:\s*(.+)/i);

  // Strategy 1: structured format (at least RESULT + SUMMARY)
  if (r && s) {
    const d = raw.match(/DETAILS:\s*([\s\S]*?)(?=ANOMALIES:|$)/i);
    const a = raw.match(/ANOMALIES:\s*(.+)/i);
    const status = r[1].toLowerCase() as DelegateTaskOutput["status"];
    const summary = s[1].trim();
    const details = d?.[1]?.trim() ?? undefined;
    const anomaliesRaw = a?.[1]?.trim() ?? "none";
    const anomalies = anomaliesRaw.toLowerCase() === "none" ? [] : anomaliesRaw.split(",").map((x) => x.trim()).filter(Boolean);
    return { status, summary, details, anomalies, duration };
  }

  // Strategy 2: heuristic inference
  const trimmed = raw.trim();
  if (!trimmed) return { status: "failure", summary: "Worker returned empty output", anomalies: ["empty_output"], duration };

  const lower = trimmed.toLowerCase();
  let status: DelegateTaskOutput["status"] = "success";
  if (/\b(fatal|panic|crash|segfault|killed|oom)\b/.test(lower)) status = "failure";
  else if (/\btimeout|timed?\s*out\b/.test(lower)) status = "timeout";
  else if (/\b(error|err|fail|warning|warn)\b/.test(lower)) status = "anomaly";

  const lines = trimmed.split("\n").filter((l) => l.trim());
  const summary = lines[0]?.slice(0, 500) ?? "No summary";
  const details = lines.length > 1 ? lines.slice(1).join("\n") : undefined;

  const anomalies: string[] = [];
  if (/\berror\b/.test(lower)) anomalies.push("error_detected");
  if (/\bfail/.test(lower)) anomalies.push("failure_detected");
  if (/\bwarning\b/.test(lower)) anomalies.push("warning_detected");

  return { status, summary, details, anomalies, duration };
}

// ===========================================================================
// Inline: Result Filter
// ===========================================================================

function extractTestSummary(raw: string): string | null {
  const jest = raw.match(/Tests:\s*(.+)/i);
  if (jest) return jest[1];
  const pytest = raw.match(/=+\s*(\d+ passed.*?\d+ failed.*?)\s*in\s*[\d.]+s\s*=+/i);
  if (pytest) return pytest[1];
  const go = raw.match(/(ok|FAIL)\s+\S+\s+[\d.]+s/g);
  if (go) { const ok = go.filter((m) => m.startsWith("ok")).length; const fail = go.filter((m) => m.startsWith("FAIL")).length; return `${ok} passed, ${fail} failed (${go.length} total)`; }
  const cargo = raw.match(/test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed/);
  if (cargo) return `${cargo[2]} passed, ${cargo[3]} failed (${cargo[1]})`;
  return null;
}

function extractFirstError(raw: string): string | null {
  for (const line of raw.split("\n")) {
    if (/\b(error|fatal|panic|FAIL)\b/i.test(line)) return line.trim();
  }
  return null;
}

function extractStderr(raw: string): string | null {
  const stderrMatch = raw.match(/stderr[:\s]*([\s\S]*?)(?=stdout|$)/i);
  if (stderrMatch) return stderrMatch[1].trim();
  const errorLines = raw.split("\n").filter((line) => /^(Error|ERR|FATAL|WARN):\s/i.test(line));
  return errorLines.length > 0 ? errorLines.join("\n") : null;
}

function filterResult(result: DelegateTaskOutput, taskType?: string): DelegateTaskOutput {
  let details = result.details;
  let summary = result.summary;
  const anomalies = [...result.anomalies];
  const facts: string[] = [];

  if (details && taskType === "run_and_observe") {
    const testSummary = extractTestSummary(details);
    if (testSummary && !summary.includes(testSummary)) {
      summary = `${summary} | ${testSummary}`;
      facts.push(`test_summary: ${testSummary}`);
    }
  }
  if (details) {
    const firstError = extractFirstError(details);
    if (firstError && !summary.includes(firstError)) facts.push(`first_error: ${firstError}`);
    if (extractStderr(details)) facts.push("stderr detected");
  }

  if (details) {
    const lines = details.split("\n");
    if (lines.length > 200) details = [`[Output truncated: ${lines.length} lines, showing first 200]`, ...lines.slice(0, 200)].join("\n");
  }
  if (summary.length > 500) summary = summary.slice(0, 500) + "...";

  if (facts.length > 0) {
    details = details ? `${details}\n\nFACTS:\n${facts.join("\n")}` : `FACTS:\n${facts.join("\n")}`;
  }

  return { ...result, summary, details, anomalies };
}

// ===========================================================================
// Plugin Entry
// ===========================================================================

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;
const BASH_OUTPUT_TRUNCATE_LINES = 300;

export default (async () => {
  return {
    // Inject delegation hint into bash tool description
    "tool.definition": async (input, output) => {
      if (input.tool === "bash") {
        output.description +=
          "\n\nIMPORTANT: For long-running or high-output commands (test suites, builds, log monitoring, heavy search), " +
          "prefer the delegate_task tool instead of bash. delegate_task runs the command in a subagent with a cheap model, " +
          "saving main-model tokens and context. Use bash only for quick commands (< 30s, < 200 lines output).";
      }
    },

    // Before execution — no-op (cannot redirect tools)
    "tool.execute.before": async (_input, _output) => {},

    // After execution — post-process long bash outputs and delegate_task results
    "tool.execute.after": async (input, output) => {
      // Post-process delegate_task results
      if (input.tool === "delegate_task" && output?.result) {
        try {
          const raw = typeof output.result === "string" ? output.result : JSON.stringify(output.result);
          const parsed = parseWorkerResult(raw, 0);
          const filtered = filterResult(parsed, input.args?.task_type);
          output.result = JSON.stringify(filtered, null, 2);
        } catch { /* leave as-is */ }
        return;
      }

      // Post-process long bash outputs
      if (input.tool === "bash" && output?.result) {
        try {
          const raw = typeof output.result === "string" ? output.result : JSON.stringify(output.result);
          const lines = raw.split("\n");
          if (lines.length > BASH_OUTPUT_TRUNCATE_LINES) {
            const testSummary = extractTestSummary(raw);
            const firstError = extractFirstError(raw);
            const parts: string[] = [`[Output truncated: ${lines.length} lines, showing first ${BASH_OUTPUT_TRUNCATE_LINES}]`];
            if (testSummary) parts.push(`Test summary: ${testSummary}`);
            if (firstError) parts.push(`First error: ${firstError}`);
            parts.push("---");
            output.result = [...parts, ...lines.slice(0, BASH_OUTPUT_TRUNCATE_LINES)].join("\n");
          }
        } catch { /* leave as-is */ }
      }
    },

    // Event monitoring (debug only)
    event: async ({ event }) => {
      // Optional: log session errors for debugging
    },

    // Register delegate_task tool
    tool: {
      delegate_task: {
        description: "Delegate a low-cognitive task to a worker subagent. Use for running commands, waiting for results, processing large output, or repetitive work. The worker runs independently with a cheap model and returns structured results.",
        parameters: {
          type: "object",
          properties: {
            task_type: { type: "string", enum: ["run_and_observe", "wait_and_monitor", "filter_and_summarize", "process_batch"], description: "Type of task" },
            command: { type: "string", description: "Bash command to execute" },
            prompt: { type: "string", description: "Task description for the worker" },
            timeout: { type: "number", description: "Timeout in ms (default: 300000)" },
            on_failure: { type: "string", enum: ["report", "retry", "abort"], description: "Action on failure (default: report)" },
            max_retries: { type: "number", description: "Max retries for retry mode (default: 2)" },
            output_filter: { type: "string", description: "Regex to filter output" },
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
              lastResult = filterResult(parseWorkerResult(raw, duration), args.task_type);
              if (lastResult.status === "success" || lastResult.status === "anomaly" || on_failure !== "retry") {
                return JSON.stringify(lastResult, null, 2);
              }
            } catch (error) {
              const duration = Date.now() - startTime;
              lastResult = { status: "failure", summary: `Worker execution failed: ${error instanceof Error ? error.message : String(error)}`, anomalies: ["worker_error"], duration, details: undefined };
              if (on_failure !== "retry" || attempt === totalAttempts - 1) return JSON.stringify(lastResult, null, 2);
            }
          }
          return JSON.stringify(lastResult ?? { status: "failure", summary: "Unknown error", anomalies: ["unknown"], duration: Date.now() - startTime, details: undefined }, null, 2);
        },
      },
    },
  };
}) satisfies Plugin;
