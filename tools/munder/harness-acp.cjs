'use strict';
/**
 * Any Agent Client Protocol (ACP v1) agent over JSON-RPC stdio. DeepSeek
 * Harness ships one (`dsh --profile acp`, package @deepseek-ai/dsh-acp); it is
 * configured, not coded: nothing here knows it is DeepSeek.
 *
 * Munder is the ACP *client*: it creates or resumes a session in the task's
 * workspace, sends one prompt, turns session/update into Munder events,
 * answers session/request_permission from Munder's own policy, and settles on
 * the prompt's stopReason. Cancellation is the protocol's own session/cancel.
 */
const { spawn } = require('node:child_process');

function capabilities() {
  return {
    session_resume: true,          // session/resume (agent advertises it in initialize)
    cancel: 'protocol',            // session/cancel
    steer_mid_turn: false,         // one prompt at a time per session
    approvals: true,               // session/request_permission → Munder policy
    events: 'acp session/update',
    usage: true,                   // usage_update
    subagents: 'native',           // harness-internal (DeepSeek: subagent/subagent_fork tools)
    mcp: 'per-session',            // session/new mcpServers (stdio/http)
    list_sessions: true,           // session/list
  };
}

function run({ cfg, prompt, cwd, resume, timeoutMs, approvals, signal, env, onNative, onEvent }) {
  return new Promise((resolve) => {
    const child = spawn(cfg.command, cfg.args || [], { cwd, env: { ...env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = { status: null, session_id: resume || null, final_text: '', usage: null, harness: { name: null, version: null, protocol: 'acp' } };
    const pending = new Map();
    let id = 0;
    let buf = '';
    let stderr = '';
    let settled = false;
    let malformed = 0;
    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { /* closed */ } };
    const rpc = (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      send({ jsonrpc: '2.0', id: i, method, params });
    });
    const done = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Object.assign(out, fields);
      const kill = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
      if (out.session_id && child.exitCode === null) {
        // session/close flushes the harness's own persistence, so resume works later.
        Promise.race([rpc('session/close', { sessionId: out.session_id }).catch(() => null), new Promise((r) => setTimeout(r, 5000))]).then(kill);
      } else kill();
      resolve(out);
    };
    const cancel = (status, code, message) => {
      onEvent({ kind: 'cancel_requested', reason: code });
      if (out.session_id) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: out.session_id } });
      // The prompt settles with stopReason "cancelled"; if it doesn't in 5 s, stop anyway.
      out.pendingCancel = { status, stop_reason: 'cancelled', error: { code, message } };
      setTimeout(() => done(out.pendingCancel), 5000).unref();
    };
    const timer = setTimeout(() => cancel('timed_out', 'timeout', `sin terminar en ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    if (signal) signal.addEventListener('abort', () => cancel('cancelled', 'cancelled', 'cancelado por Munder'), { once: true });

    const onUpdate = (u) => {
      switch (u.sessionUpdate) {
        case 'tool_call': onEvent({ kind: 'tool_start', tool: u.title || u.kind, id: u.toolCallId, input: u.rawInput }); break;
        case 'tool_call_update':
          if (u.status === 'completed' || u.status === 'failed') onEvent({ kind: 'tool_end', tool: u.title || u.toolCallId, id: u.toolCallId, ok: u.status === 'completed' });
          break;
        case 'agent_message_chunk': if (u.content && u.content.type === 'text') { out.final_text += u.content.text; onEvent({ kind: 'message', text: u.content.text }); } break;
        case 'usage_update': out.usage = { used: u.used, size: u.size }; onEvent({ kind: 'usage', usage: out.usage }); break;
        default: onEvent({ kind: 'native_update', type: u.sessionUpdate });
      }
    };

    const onMessage = (m) => {
      onNative(m);
      if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        return m.error ? p.rej(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.res(m.result);
      }
      if (m.method === 'session/update' && m.params) return onUpdate(m.params.update || {});
      if (m.method === 'session/request_permission' && m.id !== undefined) {
        // Munder's policy, not the harness's: reject unless the run was started with approvals=allow.
        const opts = (m.params && m.params.options) || [];
        const want = approvals === 'allow' ? /allow/ : /reject/;
        const pick = opts.find((o) => want.test(o.kind || '')) || null;
        onEvent({ kind: 'permission', title: m.params.toolCall && m.params.toolCall.title, decision: pick ? pick.kind : 'cancelled' });
        return send({ jsonrpc: '2.0', id: m.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } });
      }
      if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Munder no ofrece ${m.method}` } });
    };

    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { malformed++; onNative({ unparsed: line.slice(0, 500) }); continue; }
        onMessage(m);
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => done({ status: 'failed', error: { code: e.code === 'ENOENT' ? 'harness_not_installed' : 'spawn_failed', message: e.message } }));
    // 'close', not 'exit': on Windows 'exit' fires while stdout is still
    // buffered, so a reply that was on its way got read as never sent — the
    // pending promise was rejected and the run was failed as 'agent_exited'.
    // 'close' waits for the pipes to be drained, so a still-pending promise
    // really was never answered.
    child.on('close', (code, sig) => {
      for (const p of pending.values()) p.rej(Object.assign(new Error(`el agente ACP salio (${sig || code})`), { code: 'agent_exited' }));
      pending.clear();
      done({ status: 'failed', error: { code: malformed ? 'malformed_result' : 'agent_exited', message: `el agente ACP salió (${sig || code}) sin asentar`, stderr_tail: stderr.slice(-800) } });
    });

    (async () => {
      const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      out.harness = { name: init.agentInfo && init.agentInfo.name, version: init.agentInfo && init.agentInfo.version, protocol: `acp/${init.protocolVersion}` };
      const sc = (init.agentCapabilities && init.agentCapabilities.sessionCapabilities) || {};
      if (resume) {
        if (!sc.resume) throw Object.assign(new Error('este agente ACP no anuncia session/resume'), { code: 'unsupported_capability' });
        await rpc('session/resume', { sessionId: resume, cwd, mcpServers: cfg.mcpServers || [] });
        out.session_id = resume;
      } else {
        const s = await rpc('session/new', { cwd, mcpServers: cfg.mcpServers || [] });
        out.session_id = s.sessionId;
      }
      onEvent({ kind: 'session', session_id: out.session_id, resumed: !!resume });
      const r = await rpc('session/prompt', { sessionId: out.session_id, prompt: [{ type: 'text', text: prompt }] });
      if (out.pendingCancel) return done({ ...out.pendingCancel, stop_reason: r.stopReason || 'cancelled' });
      if (r.stopReason === 'end_turn') return done({ status: 'completed', stop_reason: r.stopReason });
      if (r.stopReason === 'cancelled') return done({ status: 'cancelled', stop_reason: r.stopReason, error: { code: 'cancelled', message: 'el agente canceló el turno' } });
      return done({ status: 'failed', stop_reason: r.stopReason, error: { code: `stop_${r.stopReason}`, message: `el turno terminó con ${r.stopReason}` } });
    })().catch((e) => {
      if (out.pendingCancel) return done({ ...out.pendingCancel });
      done({ status: 'failed', error: { code: e.code === -32603 ? 'harness_error' : (e.code || 'acp_error'), message: e.message } });
    });
  });
}

module.exports = { capabilities, run };
