// A minimal ACP v1 agent for CI: session/new|resume, prompt (asks one permission,
// then writes a file only if allowed), cancel, close.
// FAKE_ACP: ok | hang | crash | sprint
const fs = require('fs');
const path = require('path');
let buf = '';
let n = 1000;
const sessions = new Map();
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(m) {
  if (m.id !== undefined && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); return w(m.result); }
  const mode = process.env.FAKE_ACP || 'ok';
  const r = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return r({ protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '0.0.0' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} } } });
    case 'session/new': { const id = `sess-${Date.now()}`; sessions.set(id, { cwd: m.params.cwd, turns: 0 }); return r({ sessionId: id }); }
    case 'session/resume': { if (!sessions.has(m.params.sessionId)) sessions.set(m.params.sessionId, { cwd: m.params.cwd, turns: 1 }); return r({}); }
    case 'session/close': return r({});
    case 'session/cancel': { const s = sessions.get(m.params.sessionId); if (s && s.pending) { const p = s.pending; s.pending = null; p({ stopReason: 'cancelled' }); } return; }
    case 'session/prompt': {
      const s = sessions.get(m.params.sessionId);
      if (mode === 'crash') process.exit(3);
      s.turns++;
      const finish = (res) => r(res);
      if (mode === 'hang') { s.pending = finish; return; }
      // sprint: answer and die in the same tick. The reply is already on the
      // wire when the process goes, so a parent that settles on 'exit' may
      // never read it. On Linux 'exit' already waits for the drain and this
      // is invisible; on Windows it was the losing side of the race.
      if (mode === 'sprint') { r({ stopReason: 'end_turn' }); process.exit(0); }
      update(m.params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'write', kind: 'edit', status: 'pending' });
      const id = ++n;
      waiting.set(id, (res) => {
        const allowed = res && res.outcome && res.outcome.outcome === 'selected' && res.outcome.optionId === 'allow';
        if (allowed) fs.writeFileSync(path.join(s.cwd, 'ACP_OUT.txt'), `turn ${s.turns}\n`);
        update(m.params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed' });
        update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? `escrito (turno ${s.turns})` : 'no me dejaron escribir' } });
        update(m.params.sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100 });
        finish({ stopReason: 'end_turn' });
      });
      return send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: m.params.sessionId, toolCall: { toolCallId: 't1', title: 'write ACP_OUT.txt' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] } });
    }
    default: if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
}
