/**
 * Command pattern matching for automatic delegation.
 *
 * Three-tier classification:
 * 1. NEVER_INTERCEPT — fast commands that must never be delegated
 * 2. AUTO_DELEGATE   — obvious long-task commands, delegate immediately
 * 3. Estimation fallback — for ambiguous commands, use heuristic risk scoring
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType =
  | "run_and_observe"
  | "wait_and_monitor"
  | "filter_and_summarize"
  | "process_batch";

export type DelegationDecision =
  | { delegate: false }
  | { delegate: true; taskType: TaskType; reason: "auto" | "estimated" };

export type CommandShape = {
  executable: string;
  args: string[];
  positional: string[];
  flags: Set<string>;
  redirections: string[];
  raw: string;
};

// ---------------------------------------------------------------------------
// Auto-delegate patterns (hard rules)
// ---------------------------------------------------------------------------

const AUTO_DELEGATE_PATTERNS: Record<TaskType, RegExp[]> = {
  run_and_observe: [
    // Test runners
    /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/,
    /\bjest\b/,
    /\bvitest\b/,
    /\bmocha\b/,
    /\bpytest\b/,
    /\bgo\s+test\b/,
    /\bcargo\s+test\b/,
    /\bphpunit\b/,
    // Build tools
    /\b(npm|yarn|pnpm)\s+(run\s+)?build\b/,
    /\bmake\b/,
    /\bcmake\b/,
    /\bgradle\b/,
    /\bmvn\b/,
    /\bcargo\s+build\b/,
    /\bwebpack\b/,
    /\bvite\s+build\b/,
    /\btsc\b/,
    /\besbuild\b/,
  ],
  wait_and_monitor: [
    // Log monitoring
    /\btail\s+.*-f\b/,
    /\bwatch\b/,
    /\blogcat\b/,
    /\bdocker\s+logs\s+.*-f\b/,
    /\bjournalctl\s+.*-f\b/,
    /\bkubectl\s+logs\s+.*-f\b/,
    // Long-running dev servers
    /\b(npm|yarn|pnpm)\s+run\s+dev\b/,
    /\bwebpack-dev-server\b/,
    /\bvite\b(?!.*build)/,
    /\bnodemon\b/,
    /\btsx\s+watch\b/,
  ],
  filter_and_summarize: [
    // Heavy recursive search
    /\bgrep\s+.*-r\b/,
    /\brg\b/,
    /\bfind\s+.*-exec\b/,
    /\bxargs\b/,
  ],
  process_batch: [],
};

// ---------------------------------------------------------------------------
// Never-intercept patterns (blacklist)
// ---------------------------------------------------------------------------

const NEVER_INTERCEPT_PATTERNS: RegExp[] = [
  // Fast git view commands (narrowed to avoid intercepting git grep, etc.)
  /\bgit\s+(status|diff|show|log|branch|tag|remote)\b/,
  // Quick navigation / viewing
  /\b(cd|ls|pwd|cat|head)\b/,
  // File operations (fast)
  /\b(cp|mv|rm|mkdir|touch|ln)\b/,
  // Editors
  /\b(vim|nano|code|emacs)\b/,
  // Dependency install (usually fast enough)
  /\bnpm\s+install\b/,
];

// Note: `tail` is intentionally NOT in never-intercept because `tail -f`
// is a monitoring scenario handled by AUTO_DELEGATE wait_and_monitor.

// ---------------------------------------------------------------------------
// Command shape parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw command string into a structured shape.
 *
 * Implementation note: a production version should prefer a proper shell
 * parser like `shell-quote`. This fallback uses simple tokenization and
 * is sufficient for pattern matching heuristics.
 */
export function parseCommandShape(command: string): CommandShape {
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
    // Common short flags
    if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "v") flags.add("verbose");
        if (ch === "f") flags.add("follow");
      }
    }
  }

  return { executable, args, positional, flags, redirections, raw: command };
}

/** Naive shell tokenizer — splits on whitespace, respects double-quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;

  for (const ch of command) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === " " && !inQuote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);

  return tokens;
}

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

/** Check if a command should NEVER be intercepted. */
export function isNeverIntercept(command: string): boolean {
  return NEVER_INTERCEPT_PATTERNS.some((p) => p.test(command));
}

/** Check if a command matches auto-delegate patterns. Returns task type or null. */
export function matchAutoDelegate(command: string): TaskType | null {
  for (const [taskType, patterns] of Object.entries(AUTO_DELEGATE_PATTERNS)) {
    if (patterns.some((p) => p.test(command))) {
      return taskType as TaskType;
    }
  }
  return null;
}

/**
 * Check whether a command should be handled locally and never delegated.
 */
export function shouldKeepLocal(command: string): boolean {
  return isNeverIntercept(command);
}

/**
 * Classify a command for delegation hints.
 *
 * This function only handles hard local/auto-delegate rules.
 * Risk-based delegation lives in the estimator to keep the layers separate.
 */
export function analyzeCommand(command: string): DelegationDecision {
  if (shouldKeepLocal(command)) {
    return { delegate: false };
  }

  const taskType = matchAutoDelegate(command);
  if (taskType) {
    return { delegate: true, taskType, reason: "auto" };
  }

  return { delegate: false };
}
