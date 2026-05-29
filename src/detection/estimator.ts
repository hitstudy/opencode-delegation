/**
 * Risk estimation for ambiguous commands.
 *
 * When a command doesn't match auto-delegate or never-intercept patterns,
 * this module estimates output volume and execution time to decide
 * whether delegation is worthwhile.
 */

import { parseCommandShape, type CommandShape } from "./patterns.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputRisk = "low" | "medium" | "high" | "extreme";

export type RiskEstimate = {
  outputRisk: OutputRisk;
  estimatedDurationMs: number;
  estimatedOutputLines: number;
};

// ---------------------------------------------------------------------------
// Thresholds (configurable via plugin options in the future)
// ---------------------------------------------------------------------------

export const DELEGATION_THRESHOLDS = {
  /** Commands estimated to take longer than this are delegated. */
  durationMs: 30_000,
  /** Commands estimated to produce more lines than this are delegated. */
  outputLines: 500,
} as const;

// ---------------------------------------------------------------------------
// Package manager subcommand classification
// ---------------------------------------------------------------------------

/**
 * npm/yarn/pnpm subcommands that are fast and low-output.
 * Anything NOT in this list for package managers is treated as low-risk.
 */
const PM_FAST_SUBCOMMANDS = new Set([
  "ls", "list", "info", "view", "outdated", "why",
  "config", "prefix", "root", "bin", "whoami",
  "init", "login", "logout", "owner", "team",
  "cache", "pack", "publish", "unpublish",
]);

/**
 * Package manager subcommands that are genuinely long-running.
 */
const PM_SLOW_SUBCOMMANDS = new Set([
  "install", "i", "add", "remove", "rm", "uninstall",
  "update", "upgrade", "audit", "rebuild",
  "ci", "clean-install",
]);

// ---------------------------------------------------------------------------
// Estimation logic
// ---------------------------------------------------------------------------

/**
 * Estimate the risk profile of a command.
 *
 * Heuristics are intentionally conservative — when in doubt, we estimate
 * higher risk so the caller can delegate.
 *
 * Key improvement: package managers (npm/yarn/pnpm) are NOT blanket-classified
 * as medium risk. Only their slow subcommands (install, update, audit) trigger
 * delegation. Fast subcommands (ls, info, config) stay at low risk.
 */
export function estimateRisk(command: string): RiskEstimate {
  const shape = parseCommandShape(command);
  let risk: OutputRisk = "low";
  let duration = 5_000; // default 5s
  let lines = 50; // default 50 lines

  // --- Flag-based modifiers ---

  if (shape.flags.has("verbose")) {
    lines *= 4;
  }

  if (shape.redirections.includes("/dev/null")) {
    // Output is being discarded — low risk regardless of command
    return { outputRisk: "low", estimatedDurationMs: duration, estimatedOutputLines: 0 };
  }

  if (shape.raw.includes("2>&1")) {
    // stderr merged into stdout — more output
    lines *= 1.5;
  }

  // --- Executable-based modifiers ---

  const exe = shape.executable.toLowerCase();

  // Test runners (always high risk)
  if (isTestRunner(exe)) {
    if (exe === "cargo" && getSubcommand(shape) !== "test") {
      // cargo without test subcommand is handled below
    } else {
      duration = 120_000; // 2 min
      lines = 500;
      risk = "high";
    }
  }

  // Build tools (always high risk)
  if (isBuildTool(exe)) {
    if (exe === "vite" && getSubcommand(shape) !== "build") {
      // vite without build subcommand is handled below
    } else {
      duration = 300_000; // 5 min
      lines = 300;
      risk = "high";
    }
  }

  // Package managers — subcommand-aware
  if (isPackageManager(exe)) {
    const subcommand = getSubcommand(shape);
    if (PM_SLOW_SUBCOMMANDS.has(subcommand)) {
      duration = 120_000;
      lines = 200;
      risk = "high";
    } else if (PM_FAST_SUBCOMMANDS.has(subcommand)) {
      // Fast subcommand — keep at low risk
      duration = 5_000;
      lines = 30;
      risk = "low";
    } else {
      // Unknown subcommand — medium risk as conservative default
      duration = 30_000;
      lines = 100;
      risk = "medium";
    }
  }

  // Compilers (always high risk)
  if (isCompiler(exe)) {
    duration = 120_000;
    lines = 200;
    risk = "high";
  }

  if (exe === "cargo") {
    const subcommand = getSubcommand(shape);
    if (subcommand === "test") {
      duration = 120_000;
      lines = 500;
      risk = "high";
    } else if (subcommand === "build" || subcommand === "bench") {
      duration = 300_000;
      lines = 300;
      risk = "high";
    }
  }

  // --- Flag overrides ---

  if (shape.flags.has("follow")) {
    // Streaming / monitoring — infinite output
    duration = Infinity;
    lines = Infinity;
    risk = "extreme";
  }

  return {
    outputRisk: risk,
    estimatedDurationMs: duration,
    estimatedOutputLines: lines,
  };
}

/**
 * Decide whether a command should be delegated based on risk estimation.
 */
export function shouldDelegateByRisk(command: string): boolean {
  const { outputRisk, estimatedDurationMs, estimatedOutputLines } = estimateRisk(command);

  if (outputRisk === "extreme") return true;
  if (estimatedDurationMs > DELEGATION_THRESHOLDS.durationMs) return true;
  if (estimatedOutputLines > DELEGATION_THRESHOLDS.outputLines) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTestRunner(exe: string): boolean {
  return (
    exe.includes("jest") ||
    exe.includes("vitest") ||
    exe.includes("mocha") ||
    exe.includes("pytest") ||
    exe.includes("phpunit") ||
    exe === "cargo" // cargo test — subcommand checked separately
  );
}

function isBuildTool(exe: string): boolean {
  return (
    exe === "make" ||
    exe === "cmake" ||
    exe === "gradle" ||
    exe === "mvn" ||
    exe.includes("webpack") ||
    exe === "tsc" ||
    exe === "esbuild" ||
    exe === "vite" // vite build — subcommand checked separately
  );
}

function isPackageManager(exe: string): boolean {
  return exe === "npm" || exe === "yarn" || exe === "pnpm" || exe === "pip";
}

function isCompiler(exe: string): boolean {
  return exe === "gcc" || exe === "g++" || exe === "rustc" || exe === "clang";
}

/**
 * Extract the subcommand from a command shape.
 * For `npm run test --verbose`, subcommand is "run".
 * For `cargo test`, subcommand is "test".
 * For `make`, there's no subcommand.
 */
function getSubcommand(shape: CommandShape): string {
  return shape.positional[0] ?? "";
}
