// Assembles the 0.5.3 story landing from the live page (main-index.html) plus body.html, story.css, story.js and the cast sprites.
const fs = require('fs');
const path = require('path');
const H = __dirname;
const rd = (f) => fs.readFileSync(path.join(H, f), 'utf8');
const L = rd('main-index.html').split('\n');
const raw = (a, b) => L.slice(a - 1, b).join('\n');
const cast = JSON.parse(rd('cast.json'));
const out = process.argv[2];

const castCss = Object.entries(cast).map(([n, c]) => `.sp-${n}{background-image:url(${c.walk})}.pt-${n}{background-image:url(${c.portrait})}`).join('\n');
const pt = (n) => `<i class="pt pt-${n}"></i>`;

// twelve provider tiles from the live page, one clone behind each
const provs = raw(418, 429).split('\n').map((l) => l.trim().replace(/^<div class="clp">/, '').replace(/<\/div>$/, ''));
const who = ['michael', 'dwight', 'jim', 'pam', 'angela', 'oscar', 'kevin', 'creed', 'stanley', 'andy', 'kelly', 'ryan'];
const bubbles = ['on it', 'tests green', 'PR open', 'reviewing'];
const desks = provs.map((p, i) => `<div class="desk" style="--d:${i}"><div class="who" style="transition-delay:${(i * 0.08).toFixed(2)}s">${pt(who[i])}${i % 3 === 0 ? `<span class="bub">${bubbles[(i / 3) | 0]}</span>` : ''}</div><div class="top">${p}</div></div>`).join('\n      ');

const roster = [
  ['michael', 'Michael', 'Orchestrator · Claude Code', 'Planning the signup release'],
  ['angela', 'Angela', 'Codex', 'acm-3 Test a duplicate email'],
  ['oscar', 'Oscar', 'Gemini CLI', 'acm-4 Review the signup branches'],
  ['creed', 'Creed', 'Cursor', 'acm-5 Update the README'],
  ['kevin', 'Kevin', 'Copilot', 'acm-2 Accept 8 character passwords'],
  ['dwight', 'Dwight', 'Grok', 'acm-1 Match emails case insensitively'],
].map(([n, name, eng, task]) => `<div class="row">${pt(n)}<div><b>${name}</b><small>${eng}</small><small>${task}</small></div><span class="st">working</span></div>`).join('\n      ');

const whoCards = [['angela', 'Angela', 'wrote the tests'], ['oscar', 'Oscar', 'reviewed the fix'], ['creed', 'Creed', 'updated the README']]
  .map(([n, a, b]) => `<div class="who">${pt(n)}<div>${a}<small>${b}</small></div></div>`).join('');

const floor = ['michael', 'jim', 'pam', 'dwight', 'angela', 'kevin'].map((n) => `<div class="deskp">${pt(n)}<i class="tbl"></i></div>`).join('');
const rail = `<div class="rail"><div class="ri sel">${pt('michael')}Michael<small>working</small></div><div class="ri">${pt('angela')}Angela<small>working</small></div><div class="ri">${pt('oscar')}Oscar</div><div class="ri">${pt('kevin')}Kevin<small>working</small></div><div class="ri">${pt('dwight')}Dwight</div></div><div class="pane2"><span><b>michael</b> › ship the signup fix</span><span>→ acm-1 to Dwight</span><span>→ acm-3 to Angela</span><span>✓ acm-4 reviewed by Oscar</span><span class="blobf"></span></div>`;
const nightRow = ['jim', 'pam', 'dwight', 'michael', 'angela', 'oscar', 'kevin', 'creed'].map((n) => `<div class="nd">${pt(n)}<i class="mon"></i><i class="tbl"></i></div>`).join('');

const faq = [
  ['What is Munder Difflin?', 'A free and open source multi agent harness for macOS, Windows and Linux. It runs Claude Code, Codex, Gemini CLI, Copilot, Cursor and seven more coding agents as one team of clones on your own machine, on the subscriptions you already pay for.'],
  ['Does it work with my Claude Code subscription?', 'Yes. Munder Difflin drives the Claude Code CLI you already use, so your plan and its hourly limits do the work. The same goes for Codex, Gemini CLI and the other providers.'],
  ['Which coding agents does it support?', 'Twelve: Claude Code, Codex, Grok, Kimi Code, Antigravity, Qwen, Gemini CLI, OpenCode, Crush, Pi, Copilot and Cursor. New models show up in the pickers without a new version.'],
  ['Does my code ever leave my laptop?', 'No. Your node runs on your machine. Code, keys and personal context stay there. The only thing that travels is clone to clone messages, sealed on your machine and opened only on your teammate\'s.'],
  ['Can the Stapler replace Granola and Wispr Flow?', 'That is what it is built for. It takes dictation in any app and writes down your meetings, both sides of the call, with transcription running on your machine. Then it hands the text to your agents.'],
  ['Is the Stapler free?', 'The Stapler is part of Pro, with a 14 day trial. Dictation in the Munder Difflin message box works in the free version too.'],
  ['What does it cost?', 'Free is free, forever. Pro is $150 a year with the launch offer, down from $200, or $20 a month. The annual price is adjusted for purchasing power in different countries and can be as low as $100 a year. Teams is priced with you on a call.'],
  ['How do I get Teams?', 'On a call. Teams is set up with us, one team at a time. Book a thirty minute slot, and on the call we size the team with you, make the organisation and hand you the invite codes.'],
  ['Does my laptop need to stay on?', 'Yes. The clone runs on your machine and stops when the machine does. Sandboxes on machines we host, so a job keeps running after the lid closes, are coming.'],
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const faqHtml = faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n      ');

const ld = [
  { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Munder Difflin', applicationCategory: 'DeveloperApplication', operatingSystem: 'macOS, Windows, Linux', softwareVersion: '0.5.3', url: 'https://munderdiffl.in/', downloadUrl: 'https://harnessmd.com/download', license: 'https://github.com/chaitanyagiri/munder-difflin/blob/main/LICENSE', description: 'Free and open source multi agent harness that runs Claude Code, Codex, Gemini CLI and nine more coding agents as an office of clones on your own machine.', offers: [{ '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' }, { '@type': 'Offer', name: 'Pro, annual', price: '150', priceCurrency: 'USD' }] },
  { '@context': 'https://schema.org', '@type': 'VideoObject', name: 'Munder Difflin 0.5.3 launch video', description: 'An office of coding agents that coordinate on their own, a memory layer, local first, and the Stapler for dictation and meetings.', thumbnailUrl: 'https://munderdiffl.in/media/munder-difflin-053-poster.jpg', contentUrl: 'https://munderdiffl.in/media/munder-difflin-053.mp4', uploadDate: '2026-09-25', duration: 'PT53S' },
  { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
];

const TITLE = 'Munder Difflin · Multi agent harness for Claude Code, Codex and ten more';
const DESC = 'Free and open source multi agent harness. Run Claude Code, Codex, Gemini CLI and nine more coding agents as an office of clones on your own machine, on the subscriptions you already pay for. Now with the Stapler for local dictation and meeting notes.';
const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="https://munderdiffl.in/">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:image" content="https://munderdiffl.in/media/og.png">
<meta property="og:url" content="https://munderdiffl.in/">
<meta property="og:video" content="https://munderdiffl.in/media/munder-difflin-053.mp4">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESC}">
<link rel="preload" as="image" href="./media/munder-difflin-053-poster.jpg">
${ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n')}
${L[28]}
<!--
  Munder Difflin landing page, 0.5.3 story cut, 25 Sep 2026 (Pam). One file, opens with file://, no server, no build step.
  The page is one workday: a clock runs from 08:59 to 18:00 as you scroll, each chapter is one core feature, the page goes dark after hours.
  Built by the scratchpad build.cjs from the previous page: fonts, tokens, blobatar and the interactive Stapler are carried over verbatim.
  Media: ./media/munder-difflin-053.mp4 (the launch video, remuxed with faststart so it streams) and ./media/munder-difflin-053-poster.jpg.
  The two old loops (hero-demo.mp4 and pro-stapler.gif) are no longer used here. The pixel cast is the app's own portraitArt.ts, rendered to PNG.
-->`;

let body = rd('body.html')
  .replace(/\{\{RAW:(\d+),(\d+)\}\}/g, (_, a, b) => raw(+a, +b))
  .replace('{{DESKS}}', desks).replace('{{ROSTER}}', roster).replace('{{WHO}}', whoCards)
  .replace('{{FLOOR}}', floor).replace('{{RAIL}}', rail).replace('{{NIGHT}}', nightRow).replace('{{FAQ}}', faqHtml);
if (/\{\{/.test(body)) throw new Error('unfilled slot');

const html = [
  raw(1, 17), '', head, raw(46, 320),
  castCss, rd('story.css'), '</style>', '</head>', '<body>',
  raw(324, 351), '', body, '', raw(736, 757), '',
  raw(759, 1034), rd('story.js'), raw(1035, L.length),
].join('\n');

// house style on the words a visitor reads (comments and data excluded)
const visible = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
if (/[–—]/.test(visible)) throw new Error('a dash in the copy');
fs.writeFileSync(out, html);
console.log('wrote', out, (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
