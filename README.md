# opencode-delegation

OpenCode plugin that delegates low-cognitive-density tasks to a cheap worker subagent. Reduces token waste, context pollution, and improves long-task stability.

## Problem

When running test suites, builds, log monitoring, or heavy search through an AI coding assistant, the main (strong) model wastes expensive tokens on low-cognition work — watching output scroll by, waiting for processes to finish, summarizing verbose logs. This pollutes the context window and burns budget on work a cheap model can handle.

## Solution

The plugin introduces a `delegate_task` tool and a `worker` agent backed by your configured `small_model`. The main model can explicitly delegate long-running or high-output tasks to the worker, which executes independently and returns a structured result. The plugin also nudges the model toward delegation for obvious long tasks and trims oversized bash output. The main model's context stays cleaner, and its tokens are spent more on high-value decisions.

```
┌─────────────────────────────────────────────┐
│           Main Agent (strong model)         │
│                                             │
│  1. Receives task                           │
│  2. Decides: delegate or handle myself?     │
│  3. If delegate → calls delegate_task       │
│  4. Blocks (zero token consumption)         │
│  5. Receives structured result              │
│  6. Continues with high-value analysis      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│          Worker Agent (small_model)         │
│                                             │
│  - Runs command, observes output            │
│  - Detects anomalies (errors, warnings)     │
│  - Summarizes if output > 200 lines         │
│  - Returns: RESULT / SUMMARY / DETAILS /    │
│    ANOMALIES / FACTS                        │
└─────────────────────────────────────────────┘
```

## Installation

### npm package

```bash
npm install --save-dev opencode-delegation
```

Add the plugin, skill path, and worker agent config to `opencode.json`:

```json
{
  "small_model": "anthropic/claude-haiku-3.5",
  "plugin": ["opencode-delegation"],
  "agent": {
    "worker": {
      "description": "Executes low-cognitive-density tasks: run commands, observe output, detect anomalies, return structured results.",
      "mode": "subagent",
      "model": "small_model",
      "steps": 20,
      "permission": {
        "bash": "allow",
        "read": "allow",
        "edit": "deny",
        "task": "deny",
        "todowrite": "deny",
        "question": "deny",
        "webfetch": "deny",
        "glob": "allow",
        "grep": "allow"
      }
    }
  },
  "skills": {
    "paths": ["./node_modules/opencode-delegation/skill"]
  }
}
```

The package also ships `agent/worker.md` and `skill/delegation-manager/SKILL.md` for users who prefer to copy them into a project-local `.opencode/` directory.

```
your-project/
├── .opencode/
│   ├── agents/worker.md
│   └── skills/delegation-manager/SKILL.md
└── ...
```

## Configuration

### Worker agent

Configured in `opencode.json` under `agent.worker`:

```json
{
  "agent": {
    "worker": {
      "model": "small_model",
      "steps": 20,
      "permission": {
        "bash": "allow",
        "read": "allow",
        "glob": "allow",
        "grep": "allow",
        "edit": "deny",
        "task": "deny"
      }
    }
  }
}
```

- **model**: Defaults to `small_model`. Override to any model string (e.g., `"openai/gpt-4o-mini"`).
- **steps**: Max agentic iterations. 20 is enough for most delegated tasks.
- **permissions**: Worker can run commands, read files, search code. Cannot edit files, spawn sub-agents, or interact with the user.

### Customization

Override `small_model` in `opencode.json` to control which cheap model the worker uses:

```json
{
  "small_model": "openai/gpt-4o-mini"
}
```

## How it works

### Automatic guidance and output trimming

The plugin's `tool.definition` hook injects a hint into the bash tool's description. Every time the main model considers running a bash command, it sees a reminder to prefer `delegate_task` for long-running or high-output commands.

For commands the plugin recognizes as obviously long (test runners, build tools, log monitoring, heavy recursive search), the `tool.execute.after` hook trims oversized bash output and attaches a structured summary.

This is guidance, not a hard redirect. The reliable delegation path is an explicit `delegate_task` call.

### Explicit delegation

For ambiguous cases, the main model calls `delegate_task` directly:

```
delegate_task({
  task_type: "run_and_observe",
  command: "npm test",
  prompt: "Run the test suite. Report which tests passed and which failed.",
  on_failure: "report"
})
```

The Skill (`delegation-manager`) guides the main model on when and how to delegate.

### Task types

| Type | Use case |
|------|----------|
| `run_and_observe` | Execute a command, watch output, detect errors |
| `wait_and_monitor` | Run a long process, observe over time |
| `filter_and_summarize` | Process data, extract key information |
| `process_batch` | Apply an operation to many items |

### Worker permissions

| Tool | Permission | Reason |
|------|-----------|--------|
| bash | allow | Execute commands |
| read | allow | Read files for context |
| glob | allow | Find files by pattern |
| grep | allow | Search code for patterns |
| edit | deny | Worker must not modify files |
| task | deny | Worker must not spawn sub-agents |
| question | deny | Worker must not interact with user |

Worker can explore the codebase within the task's scope (search, read, extract) but cannot make architectural decisions, diagnose root causes, or choose fix strategies.

## Project structure

```
opencode-delegation/
├── src/
│   ├── plugin.ts                 # Plugin entry — hooks + delegate_task tool
│   ├── detection/
│   │   ├── patterns.ts           # Command pattern matching (auto-delegate rules)
│   │   └── estimator.ts          # Risk estimation (subcommand-aware)
│   ├── tools/
│   │   └── delegate-task.ts      # Prompt builder + result parser (with fallback)
│   └── lifecycle/
│       ├── filter.ts             # Result filtering — FACTS vs anomalies separation
│       └── monitor.ts            # Event monitoring (MVP stub)
├── skill/
│   └── delegation-manager/
│       └── SKILL.md              # Main agent delegation guidance
├── agent/
│   └── worker.md                 # Worker agent definition
├── opencode.json                 # Reference config
├── package.json
└── tsconfig.json
```

## Design decisions

**Why not hard-intercept bash calls?** OpenCode's plugin hooks can mutate tool args but cannot reliably redirect one tool into another in the general case. The plugin therefore uses `tool.definition` hints + Skill guidance to steer the main model toward `delegate_task`, and `tool.execute.after` to post-process long bash outputs. Explicit `delegate_task` calls are the dependable path.

**Why foreground mode (blocking)?** The main model's LLM call blocks while the worker runs, consuming zero tokens. This matches the core goal: the main model should not think during low-cognition work.

**Why FACTS vs anomalies?** The worker reports factual observations (first error line, stderr presence, test counts) in a `FACTS` section. The `ANOMALIES` field contains the worker's signal-level judgments (`error_detected`, `warning_detected`). The main model can then make its own diagnosis from the facts, rather than being fed pre-digested conclusions.

**Why fallback result parsing?** The worker is a small model that may not always produce perfectly structured output. The parser tries strict format first (RESULT/SUMMARY/DETAILS/ANOMALIES), then falls back to heuristic inference from raw text. This prevents format mismatches from causing hard failures.

## License

MIT
