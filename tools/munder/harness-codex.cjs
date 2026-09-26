'use strict';
/**
 * OpenAI Codex, self-operated: `codex exec --experimental-json`, the JSONL
 * surface the official Codex SDK (@openai/codex-sdk) drives. Codex keeps its
 * own threads (~/.codex/sessions, or CODEX_HOME), agent loop, sandbox and
 * native subagents; Munder only sends one prompt and reads the event stream.
 *
 * Not the managed Agents API (OpenAI runs the harness there) and not the
 * Responses API (Munder would own the loop). See EXTERNAL_HARNESS_AUDIT.md.
 */
const { spawn, spawnSync } = require('node:child_process');

function capabilities() {
  return {
    session_resume: true,          // `exec resume <thread_id>`
    cancel: 'process',             // SIGTERM (what the SDK's AbortSignal does)
    steer_mid_turn: false,         // exec: one prompt per turn
    approvals: false,              // exec never asks; approval_policy is config
    events: 'jsonl',               // thread.* / turn.* / item.*
    usage: true,                   // turn.completed.usage
    subagents: 'native',           // multi_agent_v1 tool, internal to the thread
    mcp: 'config',                 // mcp_servers in config.toml
    list_sessions: false,
  };
}

function version(cfg) {
  const r = spawnSync(cfg.command, [...(cfg.prefix || []), '--version'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run({ cfg, prompt, cwd, resume, timeoutMs, signal, env, onNative, onEvent }) {
  return new Promise((resolve) => {
    const args = [...(cfg.prefix || []), 'exec', '--experimental-json', '--skip-git-repo-check', '--sandbox', cfg.sandbox || 'workspace-write', '--cd', cwd, ...(cfg.args || [])];
    if (resume) args.push('resume', resume);
    const childEnv = { ...env, ...(cfg.env || {}) };
    const child = spawn(cfg.command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = { status: null, session_id: resume || null, final_text: '', usage: null, harness: { name: 'codex', version: version(cfg) } };
    let stderr = '';
    let buf = '';
    let settled = false;
    let malformed = 0;
    const done = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Object.assign(out, fields);
      if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref(); }
      resolve(out);
    };
    const timer = setTimeout(() => { onEvent({ kind: 'error', code: 'timeout' }); done({ status: 'timed_out', error: { code: 'timeout', message: `sin terminar en ${Math.round(timeoutMs / 1000)} s` } }); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { onEvent({ kind: 'cancel_requested' }); done({ status: 'cancelled', stop_reason: 'cancelled', error: { code: 'cancelled', message: 'cancelado por Munder' } }); }, { once: true });

    const handle = (ev) => {
      onNative(ev);
      switch (ev.type) {
        case 'thread.started': out.session_id = ev.thread_id; onEvent({ kind: 'session', session_id: ev.thread_id, resumed: !!resume }); break;
        case 'turn.started': onEvent({ kind: 'turn_start' }); break;
        case 'item.started':
          if (ev.item && ev.item.type === 'command_execution') onEvent({ kind: 'tool_start', tool: 'command', input: ev.item.command });
          break;
        case 'item.completed': {
          const it = ev.item || {};
          if (it.type === 'command_execution') onEvent({ kind: 'tool_end', tool: 'command', ok: it.exit_code === 0, exit_code: it.exit_code });
          else if (it.type === 'file_change') onEvent({ kind: 'tool_end', tool: 'file_change', ok: it.status !== 'failed', changes: it.changes });
          else if (it.type === 'mcp_tool_call') onEvent({ kind: 'tool_end', tool: `mcp:${it.server}/${it.tool}`, ok: it.status !== 'failed' });
          else if (it.type === 'agent_message') { out.final_text = it.text; onEvent({ kind: 'message', text: it.text }); }
          else if (it.type === 'error') onEvent({ kind: 'warning', message: it.message });
          else onEvent({ kind: 'native_item', type: it.type });
          break;
        }
        case 'turn.completed': out.usage = ev.usage || null; onEvent({ kind: 'usage', usage: ev.usage }); done({ status: 'completed', stop_reason: 'end_turn' }); break;
        case 'turn.failed': done({ status: 'failed', error: { code: 'turn_failed', message: (ev.error && ev.error.message) || 'turn failed' } }); break;
        case 'error': onEvent({ kind: 'error', message: ev.message }); break;
        default: break;
      }
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { malformed++; onNative({ unparsed: line.slice(0, 500) }); continue; }
        handle(ev);
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => done({ status: 'failed', error: { code: e.code === 'ENOENT' ? 'harness_not_installed' : 'spawn_failed', message: e.message } }));
    // 'close', not 'exit': on Windows 'exit' fires while stdout is still
    // buffered, so a harness that settled and exited 0 looked like it never
    // did ('no_settle'). 'close' waits for the pipes to be drained, which is
    // what "the turn is over" actually means.
    child.on('close', (code, sig) => {
      // Exit without turn.completed / turn.failed is never success.
      done({ status: 'failed', error: { code: malformed ? 'malformed_result' : 'no_settle', message: `codex salió (${sig || code}) sin asentar el turno`, stderr_tail: stderr.slice(-800) } });
    });
    child.stdin.end(prompt);
  });
}

module.exports = { capabilities, version, run };
