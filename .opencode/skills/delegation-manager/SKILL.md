---
name: delegation-manager
description: Guides the main agent on when to delegate low-cognitive tasks to the worker subagent via delegate_task. Use when a task involves running commands, waiting for results, processing large output, or repetitive work.
---

# Delegation Manager

## When to Delegate

Use the `delegate_task` tool when a task involves:

- **Executing a command and waiting for results** — commands that aren't obviously test/build (those are auto-intercepted by the plugin), but may still produce large output or take significant time
- **Processing large amounts of text or data** — filtering logs, extracting patterns, summarizing verbose output
- **Repetitive operations** — batch renaming, batch file processing, applying the same operation to many items
- **Waiting for a condition** — polling for file existence, waiting for a service to become ready, monitoring for changes

## When NOT to Delegate

Do NOT delegate when:

- **Business logic decisions** — the task requires understanding domain-specific semantics
- **User interaction** — the task needs clarification from the user
- **Architectural analysis** — the task requires creative design decisions
- **Exception diagnosis** — a previous step failed and you need to analyze why
- **Quick one-liners** — `ls`, `cat`, `git status`, `echo`, etc. that complete instantly

## How to Delegate

Call `delegate_task` with:

```
task_type: choose the most appropriate type
  - "run_and_observe"     — execute a command, watch output, detect errors
  - "wait_and_monitor"    — run a long process, observe over time
  - "filter_and_summarize" — process data, extract key info
  - "process_batch"       — apply operation to many items

prompt: ONLY the information the worker needs
  - What command to run (if not in `command` field)
  - DO NOT include your full reasoning or context

focus: tell the worker WHAT to look for
  - Specific error patterns, keywords, or signals
  - What constitutes success vs failure
  - What parts of the output matter vs what to ignore
  - Examples: "Look for TypeScript compilation errors", "Check if any tests are marked FAIL", "Extract lines containing 'ERROR' or 'WARN'"

command: the bash command (for run_and_observe tasks)

on_failure: "report" (default — worker reports the error, you decide next steps)
```

## Prompt Crafting Rules

When writing the prompt and focus for the worker:

1. **prompt = what to do** — "Run `npm test`" not "run the tests and figure out what's wrong"
2. **focus = what to look for** — "TypeScript errors, test failures, non-zero exit code. Success = exit 0 with no FAIL lines."
3. **Be specific about signals** — Tell the worker exact patterns: "FAIL", "Error:", "exit code 1", "Cannot find module"
4. **Include success/failure criteria** — So the worker knows when to report success vs anomaly
5. **Keep it local** — don't explain the full project context, just what the worker needs
6. **Don't include your reasoning** — the worker doesn't need to know why you're doing this

## Handling Results

After receiving the worker's result:

- **status: success** → Continue with your next step. Briefly acknowledge the result.
- **status: anomaly** → Analyze the anomaly signals. Decide whether to:
  - Retry the same task
  - Adjust the approach and retry
  - Escalate to the user
  - Continue if the anomaly is expected
- **status: failure** → Diagnose the failure cause. Decide whether to:
  - Fix the issue yourself (if you can)
  - Try a different approach
  - Ask the user for help
- **status: timeout** → Consider whether the timeout is too short, or the task is stuck. Adjust or escalate.

## Examples

### Good delegation
```
User: "Run the test suite and tell me if anything broke"
You: delegate_task({
  task_type: "run_and_observe",
  command: "npm test",
  prompt: "Run the test suite.",
  focus: "Look for FAIL markers, non-zero exit code, and error messages. Success = exit 0 with all tests passing. Report which specific tests failed if any.",
  on_failure: "report"
})
```

### Good delegation (build)
```
delegate_task({
  task_type: "run_and_observe",
  command: "npm run build",
  prompt: "Run the production build.",
  focus: "Look for TypeScript compilation errors (TS####), 'Cannot find module', webpack/vite errors. Success = exit 0 with no error output. Report the first error if build fails.",
  on_failure: "report"
})
```

### Bad delegation (no focus — worker doesn't know what matters)
```
delegate_task({
  task_type: "run_and_observe",
  command: "npm test",
  prompt: "Run the tests"
})
```

### Bad delegation (too vague)
```
delegate_task({
  task_type: "run_and_observe",
  prompt: "Figure out what's wrong with the project"
})
```

### Bad delegation (should do yourself)
```
delegate_task({
  task_type: "run_and_observe",
  command: "ls -la",
  prompt: "List files"
})
```
