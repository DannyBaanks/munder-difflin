// Scripted model for harness-boundary experiments. NOT an LLM: it reads the
// tools the harness offers, asks it to run ONE shell command that writes the
// artifact, then answers with a final message once it sees the tool result.
// Speaks OpenAI Responses (Codex) and Anthropic-style Messages (DeepSeek Harness).
const http = require('http');
const fs = require('fs');
// Control files (re-read on every request, so one server serves every experiment):
//   $FAKE_DIR/mode  ok | error500 | malformed | slow      $FAKE_DIR/cmd  the shell command to request
const DIR = process.env.FAKE_DIR || require('os').tmpdir();
const LOG = require('path').join(DIR, 'requests.jsonl');
const read = (f, d) => { try { return fs.readFileSync(require('path').join(DIR, f), 'utf8').trim() || d; } catch { return d; } };
let MODE = 'ok';
let ARTIFACT_CMD = '';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function pickShell(tools, names) {
  for (const n of names) { const t = tools.find((x) => x === n); if (t) return t; }
  return tools.find((x) => /shell|bash|exec|command/i.test(x));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    MODE = read('mode', 'ok');
    ARTIFACT_CMD = read('cmd', 'echo "harness-boundary-ok" > MUNDER_P0.txt && wc -l README.md');
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* keep raw */ }
    const auth = req.headers.authorization || req.headers['x-api-key'] || '';
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, auth_present: !!auth, keys: Object.keys(j), tools: (j.tools || []).map((t) => t.name || (t.function && t.function.name) || t.type), n_input: (j.input || j.messages || []).length }) + '\n');
    if (auth.includes('revoked')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid api key (fake: revoked)' } })); }
    if (MODE === 'error500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"fake upstream failure"}}'); }
    if (MODE === 'malformed') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: nonsense\ndata: {not json\n\n'); }
    const delay = MODE === 'slow' ? 120_000 : 0;
    setTimeout(() => {
      if (req.url.includes('/responses')) return responses(j, res);
      if (req.url.includes('/messages')) return messages(j, res);
      if (req.url.includes('/chat/completions')) return chat(j, res);
      res.writeHead(404); res.end('{}');
    }, delay);
  });
});

// ── OpenAI Responses (Codex) ──
function responses(j, res) {
  const input = j.input || [];
  const sawToolResult = input.some((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output' || i.type === 'local_shell_call_output');
  const tools = (j.tools || []).map((t) => t.name || t.type);
  const id = `resp_${Date.now()}`;
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
  const events = [['response.created', { type: 'response.created', response: { id } }]];
  if (!sawToolResult) {
    const shell = pickShell(tools, ['shell_command', 'shell', 'exec_command', 'local_shell']);
    let item;
    if (shell === 'local_shell') item = { type: 'local_shell_call', id: 'lsc_1', call_id: 'call_1', status: 'completed', action: { type: 'exec', command: ['bash', '-lc', ARTIFACT_CMD] } };
    else if (shell === 'shell_command') item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: shell, arguments: JSON.stringify({ command: ARTIFACT_CMD }) };
    else if (shell === 'exec_command') item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: shell, arguments: JSON.stringify({ cmd: ARTIFACT_CMD }) };
    else item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: shell || 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', ARTIFACT_CMD] }) };
    events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
  } else {
    const text = 'Listo: escribí MUNDER_P0.txt y conté las líneas de README.md.';
    events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text, annotations: [] }] } }]);
  }
  events.push(['response.completed', { type: 'response.completed', response: { id, usage } }]);
  sse(res, events);
}

// ── Anthropic-style Messages (DeepSeek Harness) ──
function messages(j, res) {
  const msgs = j.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const sawToolResult = Array.isArray(last.content) && last.content.some((c) => c.type === 'tool_result');
  const tools = (j.tools || []).map((t) => t.name);
  const start = ['message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: j.model || 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  const events = [start];
  if (!sawToolResult) {
    const shell = pickShell(tools, ['bash', 'shell', 'Bash']);
    const input = { command: ARTIFACT_CMD };
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: shell || 'bash', input: {} } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }]);
  } else {
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listo: escribí MUNDER_P0.txt y conté las líneas de README.md.' } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }]);
  }
  events.push(['message_stop', { type: 'message_stop' }]);
  sse(res, events);
}

// ── OpenAI Chat Completions (DeepSeek Harness via its DeepSeek route) ──
function chat(j, res) {
  const msgs = j.messages || [];
  const sawToolResult = msgs.some((m) => m.role === 'tool');
  const tools = (j.tools || []).map((t) => (t.function && t.function.name) || t.name);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const w = (o) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: j.model || 'fake', ...o })}\n\n`);
  if (!sawToolResult) {
    const shell = pickShell(tools, ['bash', 'shell']);
    w({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: shell || 'bash', arguments: JSON.stringify({ command: ARTIFACT_CMD, description: 'P0 artifact' }) } }] }, finish_reason: null }] });
    w({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    w({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Listo: escribí MUNDER_P0.txt y conté las líneas de README.md.' }, finish_reason: null }] });
    w({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  w({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
}

server.listen(Number(process.env.FAKE_PORT) || 0, '127.0.0.1', () => console.log(`fake model on ${server.address().port}`));
