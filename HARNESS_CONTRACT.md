# Harness contract (v0, P0-proven)

This is what an external agent harness must provide for Munder to use it as an execution domain. It was proven with OpenAI Codex (exec JSONL) and DeepSeek Harness (ACP v1); see `EXTERNAL_HARNESS_AUDIT.md`.

## Adapter module

Each adapter module exports two functions:

- `capabilities(cfg)` → `{ session_resume, cancel, approvals, events, usage, subagents, mcp, list_sessions, steer_mid_turn }`
- `run({ cfg, prompt, cwd, resume, timeoutMs, approvals, signal, env, onNative, onEvent })` → settled result

`run` always resolves. It never throws for a harness failure; it returns:

```js
{
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out',
  stop_reason,                 // native (end_turn, cancelled, …)
  session_id,                  // the harness's own id; `resume` takes it back
  final_text, usage,           // usage in the harness's native shape
  harness: { name, version, protocol? },
  error: { code, message } | null,
}
```

**Rules:**
1. **`completed` needs a positive settle signal** from the harness (Codex `turn.completed`, ACP `stopReason: end_turn`). A process exit without one is `failed`: `no_settle`, `agent_exited` or `malformed_result`.
2. **`onNative(ev)` receives every native message verbatim.** The core stores it, scrubbed, next to the receipt.
3. **`onEvent(ev)` receives the normalized events:** `session`, `tool_start`, `tool_end{ok}`, `message`, `usage`, `permission{decision}`, `cancel_requested`, `error`, `warning`, `native_*`.
4. **Approvals are Munder's answer.** Default `reject`; `allow` only when the run asked for it. An adapter without protocol approvals declares `approvals: false`.
5. **`signal` (abort) and `timeoutMs` stop the harness** by its own means (protocol cancel, else the process), and settle `cancelled` or `timed_out`.
6. **`env` already contains the credentials by name and `MUNDER_HARNESS_CHAIN`.** Pass both to the harness process. Never put a secret in argv.

## Core guarantees (lib-harness.cjs)

- **Before running,** it refuses and records: an unknown adapter, a missing capability (`requires`), recursion (`MUNDER_HARNESS_CHAIN` without `nested`, depth ≥ 2, or the same adapter already in the chain), a bad workspace, an empty task.
- **Artifacts** are the `git status` difference of the workspace before and after the run: path, status, sha256, bytes.
- **The receipt** goes to `receipts.jsonl` plus `runs/<run_id>/{receipt.json, native-events.jsonl, events.jsonl}`. Everything is scrubbed, including the returned object. With `--tarea` it also goes to the task card's `harness_runs[]` and to the hive log under principal `harness:<adapter>`.
- **The core never names a vendor.** A new harness is either configuration (ACP) or one adapter module.
