// Stand-in for `codex exec --experimental-json` in CI (the real CLI is not installed there).
// Behaviour from FAKE_CODEX: ok | no_settle | malformed | fail
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-codex 0.0.0'); process.exit(0); }
const cd = args[args.indexOf('--cd') + 1];
const resume = args.includes('resume') ? args[args.indexOf('resume') + 1] : null;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CODEX || 'ok';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (mode === 'malformed') { process.stdout.write('not json at all\n{broken\n'); process.exit(0); }
  out({ type: 'thread.started', thread_id: resume || 'thread-fake-1' });
  out({ type: 'turn.started' });
  if (mode === 'no_settle') process.exit(0);
  if (mode === 'fail') { out({ type: 'turn.failed', error: { message: 'model refused (fake)' } }); process.exit(1); }
  out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'write', status: 'in_progress' } });
  fs.writeFileSync(path.join(cd, 'OUT.txt'), `prompt=${input.length} key=${process.env.FAKE_OPENAI_KEY ? 'present' : 'absent'} chain=${process.env.MUNDER_HARNESS_CHAIN ? 'set' : 'unset'}\n`);
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'write', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: `hecho (${process.env.FAKE_OPENAI_KEY})` } });
  out({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } });
});
