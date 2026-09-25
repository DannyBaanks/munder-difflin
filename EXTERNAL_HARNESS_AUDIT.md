# External harnesses in Munder: audit and P0

**Question.** Can Munder take a whole external agent harness as an execution provider, without absorbing its implementation, and without losing authority, provenance or receipts?

**Answer (P0).** Yes, for the two harnesses published on GitHub:
- **OpenAI Codex**, operated by us.
- **DeepSeek Harness**.

Both go behind one small contract. Munder keeps authority and evidence; each harness keeps its own sessions, tools and subagents. The model behind them was **scripted**: this measures the boundary, not intelligence. Live OpenAI and DeepSeek models were **not** exercised (see Limits).

## Provenance

| Item | Value |
|---|---|
| Munder base | `main` at `b17f06e6` |
| OpenAI Codex | `openai/codex` at `1d804e91` (2026-09-25); CLI `@openai/codex` **0.157.0** (npm); SDK `sdk/typescript` |
| DeepSeek Harness | `deepseek-ai/deepseek-harness` at `477b4f42` (2026-09-24, `rel/dsh-0.1.7-rc.2`); CLI `@deepseek-ai/dsh` **0.1.5-rc.3** (npm); ACP server `@deepseek-ai/dsh-acp` |
| Environment | Linux container. `api.openai.com`, `api.deepseek.com`, `developers.openai.com` and `deepseek.com` are blocked by the egress proxy; no provider credentials. |
| Model used | `tools/munder/fixtures/scripted-model.cjs`. It speaks OpenAI Responses (what Codex calls) and OpenAI Chat Completions (what dsh 0.1.5's DeepSeek route calls). It asks for one shell command, then answers. |

## 1. What Munder already has (inspected)

| Abstraction | Where | What it is | Fits "external harness"? |
|---|---|---|---|
| **Worker** | `src/shared/agentProvider.ts`, `src/main/index.ts` `spawnAgentCore`, hive inbox/outbox, hook bridges | An **interactive TUI in a PTY** (claude, codex, opencode, openisy…). The hive protocol arrives by inbox; resume flags are per CLI. `codex` is already a worker (`resumeSubcommand: 'resume'`). | **No.** A worker is a long-lived terminal that a human watches, driven by mail and hooks. It has no settled result, and nothing measured at the end. |
| **Model provider** | model flags on the worker CLI (`modelFlag`), BYOK in `integrationBroker` | A model choice **inside** a CLI. Munder never calls a model itself. | **No.** Squeezing a harness in here would erase sessions, tools, subagents and events. Rejected. |
| **Link office** | `tools/munder/lib-link.cjs` (`Office.submit/get/note/cancel/reply`, `origin_ref`, receipts, ownership) | The lifecycle of an external execution domain **between offices**. | **The vocabulary fits:** submit → result, cancel, receipt, correlation. **The transport does not:** pairing, crypto, peer ownership. Reused as a model, not as code. |

**Conclusion.** A new but small boundary is warranted: the **harness adapter**. It is not a new worker type and not a model provider. It is one delegated execution domain per run, with a settled result.

## 2. The three harness surfaces

### OpenAI

There are three different surfaces; they are not the same thing.

| Surface | Who runs the loop | Evaluated | Decision |
|---|---|---|---|
| **Agents API** (managed Codex harness) | OpenAI | Docs and API blocked here, public beta, no credentials | **NOT_DEMONSTRATED.** Next adapter kind (`managed`), behind the same contract. |
| **Codex CLI/SDK** (self-operated) | us, locally | `codex exec --experimental-json` (what `@openai/codex-sdk` spawns), threads in `CODEX_HOME`, `exec … resume <thread>` | **P0.** Open source, runs here, same harness. |
| **Responses API** | Munder would be the loop | — | **Rejected** for this milestone: that is "Munder becomes a harness", the opposite of the hypothesis. |

The Codex events (`sdk/typescript/src/events.ts`): `thread.started`, `turn.started|completed|failed`, `item.started|updated|completed` (command_execution, file_change, mcp_tool_call, agent_message, error). The tools it offered the model in P0:
- `exec_command`, `write_stdin`, `request_user_input`, `view_image`;
- **`multi_agent_v1`** (native subagents);
- `get_goal`, `create_goal`, `update_goal`;
- `web_search`.

### DeepSeek Harness

Everything is a Cordis plugin: LLM, session, agent loop, tools, skills, sandbox, storage, scheduling, UI.

**The automation surface is the standard Agent Client Protocol** (`packages/acp/acp`, "automation-only", `dsh --profile acp`):
- `initialize`;
- `session/new`, `session/list`, `session/resume`, `session/close`;
- `session/set_config_option`;
- `session/prompt`, `session/cancel`;
- `session/update` (tool lifecycle, messages, usage);
- `session/request_permission`;
- MCP per session (stdio or HTTP).

The tools it offered the model in P0:
- `bash`, `edit`, `read`, `glob`, `grep`;
- **`subagent`, `subagent_fork`, `send_message`, `list_agents`, `interrupt_agent`**;
- `job_*`, `skill`;
- `create_goal`, `get_goal`, `update_goal`, `todo_write`, `ralph`;
- `web_fetch`, `web_search`, …

## 3. Capability matrix (P0 evidence)

Legend:
- **D** = DEMONSTRATED in P0 against the real harness;
- **CI** = exercised in CI against a stand-in (`fixtures/fake-*`);
- **I** = inferred from source or docs;
- **—** = absent.

| Capability | Munder needs | Codex (exec) | DeepSeek (ACP) | Normalized as |
|---|---|---|---|---|
| submit task in a workspace | yes | **D** (`--cd`, stdin prompt) | **D** (`session/new {cwd}` + `session/prompt`) | `run({adapter, prompt, cwd})` |
| durable external session id | yes | **D** `thread_id` | **D** `sessionId` | `external_session_id` |
| resume / continue | yes | **D** `exec resume <id>`: the model saw the earlier turn | **D** `session/resume`: the same | `resume` |
| settled result | yes | **D** `turn.completed` / `turn.failed` | **D** `stopReason` | `status` ∈ completed, failed, cancelled, timed_out, rejected |
| cancel | yes | **D** process signal | **D** protocol `session/cancel` (the agent acknowledged it) | `status: cancelled` |
| timeout | yes | **D** | **D** | `status: timed_out` |
| tool lifecycle events | evidence | **D** `item.*` command_execution | **D** `tool_call` / `tool_call_update` | `tool_start` / `tool_end` |
| usage | evidence | **D** tokens | **D** context used/size | `usage` (native shape kept) |
| artifacts | yes | measured by Munder (**D**) | measured by Munder (**D**) | `artifacts.files` from `git status`, never from the harness's claim |
| approvals / human gate | Munder authority | **—** exec never asks (config policy) | **D/CI** `session/request_permission` → Munder policy (reject by default) | `approvals`, `events.permissions` |
| steer mid-turn | nice | — (one prompt per turn) | — (one prompt at a time) | not in contract |
| subagents | internal | **I** `multi_agent_v1` tool offered | **I** `subagent*` tools offered | recorded as native, **not** materialized as Munder workers |
| MCP | optional | **I** `config.toml` mcp_servers | **I** per-session `mcpServers` | capability flag |
| list sessions | optional | — | **I** `session/list` (**D** in the first probe) | capability flag |
| provenance | yes | Munder receipt + raw JSONL | Munder receipt + raw JSON-RPC | receipt + `native-events.jsonl` |

## 4. Overlap and irreducible differences

**Overlap: the contract.** Open or resume a session in a workspace, send one prompt, stream events, settle with a status, cancel. Both harnesses have all of it natively.

**Irreducible differences, kept as capability metadata and not faked:**
- **Approvals:** ACP asks through the protocol; Codex exec does not ask at all (its `approval_policy` is config). A run that requires approvals is **refused** on Codex before it starts (**D**).
- **Cancel:** protocol-level in ACP, process-level in Codex.
- **Integration shape:** DeepSeek is generic ACP, so "the DeepSeek adapter" is configuration, not code. Codex has its own JSONL, so that is the one vendor-specific adapter.
- **Usage:** tokens in Codex, context window in dsh. Kept native.

## 5. The boundary (implemented)

```text
Munder task (optional --tarea)            ← Munder: who asked, which task, policy
   │  munder harness run <adapter> "…" --cwd DIR
   ▼
lib-harness.cjs  (no vendor branches)
   ├─ recursion guard (MUNDER_HARNESS_CHAIN)
   ├─ capability check (refuse, don't fake)
   ├─ git snapshot before
   ├─ adapter.run → native session / loop / tools / subagents   ← harness
   ├─ git snapshot after → artifacts
   └─ receipt (scrubbed) + native-events.jsonl + events.jsonl
         └─ task card `harness_runs[]` + hive log (principal harness:<adapter>)
```

The adapters:
- `harness-acp.cjs`: generic ACP client; DeepSeek is `dsh --profile acp`.
- `harness-codex.cjs`: Codex exec JSONL.

`adapters.json` in `~/.local/state/munder/harness/` names the commands. The core only branches on the adapter **kind**, never on a vendor. See `HARNESS_CONTRACT.md`.

**Munder stays the authority:**
- It decides the workspace and the policy (approvals are Munder's answer, not the harness's default).
- The verdict comes from Munder: `completed` only if the harness **settled** successfully. An exit 0 without settling is `failed/no_settle` (**CI**).
- The receipt comes from Munder.

The harness never gets Munder's task state, pairings or keys.

## 6. Alternatives rejected

- **A model provider** (prompt → response): it destroys sessions, tools, subagents and events.
- **A new worker type:** a PTY TUI has no settled result, and it would put a second agent loop inside a Munder terminal.
- **Link as the transport:** Link's pairing and peer ownership are for offices. A local harness process is not a paired office.
- **A giant interface with `unsupported` methods:** replaced by a small contract plus declared capabilities.
- **Materializing subagents as Munder workers:** that is nested fake workers. Subagents stay inside the harness execution domain.
- **Automatic routing:** out of scope, by instruction.

## 7. Recursion

**The hazard:** Munder → harness → (tool or MCP) → Munder → harness …

**The guard (implemented):**
- Every harness process gets `MUNDER_HARNESS_CHAIN`: the adapter and run id of each ancestor.
- `munder harness run` from inside a harness is **refused**, unless the caller asks for `--anidado`.
- Even then, depth is bounded (`MAX_DEPTH = 2`), and **the same harness never re-enters itself**.

**DEMONSTRATED** with the real DeepSeek Harness: its `bash` tool ran `munder harness run codex …`. The inner run was `rejected/recursion` with `requested_by: harness:deepseek` and the outer run id in `chain`, and the outer run still completed.

**Not covered:** recursion through **MCP over HTTP**, for example a harness connected to the `munder gpt` gateway. HTTP does not carry the environment. Today no MCP tool starts a harness run, so the path does not exist. If one is added, the chain must travel in the call (a grant claim or header) and hit the same `checkRecursion`.

**DeepSeek → Munder (plugin direction):** evaluated and **not built**. dsh can mount MCP servers per session, so Munder-as-MCP is possible without a Cordis plugin. An in-process Cordis plugin would couple Munder into the harness process, and it only adds value once there is a concrete need (for example the harness reading Munder task context). It would also create exactly the recursion path above.

## 8. Credentials

- **How keys reach the harness:** adapters declare `credential_env` (names). Values come from the environment of the process that runs `munder harness`, and go to the harness process's environment. Never argv, never the prompt, never the hive.
- **How receipts are protected:** everything written, and the receipt **returned** (what `--json` prints), is scrubbed three ways: by key name, by token shape (`sk-…`, `Bearer …`), and by the **exact values** of the declared credential variables.
  - CI proves this with a key that has no known prefix, which the harness echoes back to us.
  - P0 proves no key reached any file under the harness state or the hive.
- **Production path (not in P0):** the app's existing `integrationBroker` (write-only keys, read main-only) should hand the key to the harness spawn, the same way BYOK keys reach opencode/crush today. No new secrets system is needed.

## 9. Evidence

**P0 against the real harnesses:** `HARNESS_P0_BIN=<dir with codex, dsh> node --test tools/munder/harness-p0.test.cjs` → **11/11**.
- **Normalized receipts** (20, secrets scrubbed, paths anonymized): `docs/harness-p0/receipts.json`.
- **Raw native streams** for one completed run each: `docs/harness-p0/{codex,deepseek}-native-events.jsonl`. Normalized: `…-normalized-events.jsonl`.

| # | Experiment | Codex | DeepSeek |
|---|---|---|---|
| 1 | task → session → artifact measured → receipt → task card and hive log | completed | completed |
| 2 | resume the external session (the model sees the earlier turn) | completed, same id | completed, same id |
| 3 | revoked credential | failed `turn_failed` (401) | failed `harness_error` |
| 4 | provider 500 | failed | failed |
| 5 | malformed stream | failed | failed |
| 6 | timeout | `timed_out` | `timed_out` (via `session/cancel`) |
| 7 | cancel | `cancelled` | `cancelled` |
| 8 | unsupported capability (approvals) | `rejected` before running | (has it) |
| 9 | recursion through the harness's own tool | — | inner `rejected/recursion`, outer completed |
| 10 | no key value on disk | ✓ | ✓ |

**CI on every OS:** `node --test tools/munder/harness.test.cjs` → **9/9**, against stand-ins. Covers:
- the core;
- both adapters;
- the permission policy;
- settle/no-settle/malformed/crash;
- cancel and timeout through the protocol;
- the recursion guard;
- scrubbing;
- the task card;
- the CLI.

## 10. Classification

| Claim | Status |
|---|---|
| A common lifecycle contract exists across two very different harnesses | **DEMONSTRATED** (P0, real harnesses, scripted model) |
| Munder keeps authority: its own verdict, workspace, approvals policy and receipts | **DEMONSTRATED** |
| Native capabilities preserved, not flattened (approvals, cancel style, usage shape, subagent tools) | **DEMONSTRATED** (capability refusal; native streams kept) |
| No vendor logic in the core | **DEMONSTRATED** by construction: DeepSeek needed zero vendor code |
| Failure is never reported as success | **DEMONSTRATED** (revoked, 500, malformed, timeout, cancel, no-settle) |
| Recursion bounded through a harness tool (subprocess) | **DEMONSTRATED** |
| Recursion bounded through MCP over HTTP | **NOT_DEMONSTRATED** (no such path exists yet) |
| Works with the live OpenAI / DeepSeek models | **NOT_DEMONSTRATED** (egress blocked, no keys). The harness sides are the same code paths; only the model endpoint differs. |
| OpenAI **Agents API** (managed) fits the same contract | **INFERRED** from the Compose's description only; docs unreachable here |
| Native subagents usable through the boundary | **INFERRED** (tools offered by both; not exercised by the scripted model) |
| Any other ACP agent plugs in by configuration | **INFERRED** (generic adapter; tested with dsh and a stand-in) |

**Hypothesis:** not destroyed. Munder consumed two different harnesses as providers without redesigning Munder:
- one adapter module per protocol family;
- zero changes to Michael, the hive router, Link, Remote or the Reviver.

## 11. Limits

- **The model was scripted.** The live providers' behavior (rate limits, real tool choice, long turns) is untested.
- **dsh versions:** the npm `dsh` (0.1.5-rc.3) routes DeepSeek over **Chat Completions**. The repo head (0.1.7-rc.2) documents the Messages API. The adapter does not care (it speaks ACP), but the scripted model had to match 0.1.5.
- **Codex environment:** Codex exec ran with `--sandbox workspace-write`. Codex refused to create its helper PATH aliases under `/tmp`; that warning is harmless here.
- **Where the harnesses actually ran:** they are not in CI. CI covers the boundary with stand-ins; P0 needs `HARNESS_P0_BIN`.

## 12. Recommended next milestone (not started)

1. **Live-model P0:** the same `harness-p0.test.cjs`, pointed at real keys through the `integrationBroker`, on the Victus.
2. **App integration:** "delegate this card to a harness" from the board, recording `harness_runs[]`. Still explicit selection.
3. **Managed Agents API adapter,** after reading the live docs, as a third kind behind the same contract.
4. **Only then, routing,** on measured properties from receipts: success rate, latency, usage, capability needs, locality. Not preferences.
