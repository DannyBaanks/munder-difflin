#!/usr/bin/env node
// The two update feeds must never cross. Community installs read GitHub
// Releases; Pro installs read app.harnessmd.com. In September 2026 one hand
// upload put the Pro yml files on the public v0.5.2 release and 2,250 free
// installs were updated into Pro. This script reads both live channel files
// and fails when a file from one edition shows up in the other.
//
//   node scripts/check-update-feeds.mjs            live feeds
//   node scripts/check-update-feeds.mjs a.yml b.yml  two local files (community, pro)
//
// It runs in the release checklist after publish, not before: the GitHub yml
// only exists once the release is up.
import { readFileSync } from 'node:fs';

export const COMMUNITY_FEED = 'https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/latest-mac.yml';
export const PRO_FEED = 'https://app.harnessmd.com/releases/latest-mac.yml';

/** Every file name a channel yml points at: `path:` and each `files[].url`. */
export function fileNames(yml) {
  const names = [];
  for (const line of yml.split('\n')) {
    const m = /^\s*(?:-\s+)?(?:url|path):\s*(\S+)/.exec(line);
    if (m) names.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return names;
}

/** The problems with a pair of channel files, empty when they are clean. */
export function crossFeedProblems(communityYml, proYml) {
  const community = fileNames(communityYml);
  const pro = fileNames(proYml);
  const problems = [];
  if (community.length === 0) problems.push('community yml names no files');
  if (pro.length === 0) problems.push('pro yml names no files');
  for (const n of community) if (!n.includes('Community')) problems.push(`community feed points at a non Community file: ${n}`);
  for (const n of pro) if (n.includes('Community')) problems.push(`pro feed points at a Community file: ${n}`);
  for (const n of community) if (pro.includes(n)) problems.push(`the same file is on both feeds: ${n}`);
  return problems;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const [a, b] = process.argv.slice(2);
  const community = a ? readFileSync(a, 'utf8') : await fetchText(COMMUNITY_FEED);
  const pro = b ? readFileSync(b, 'utf8') : await fetchText(PRO_FEED);
  const problems = crossFeedProblems(community, pro);
  if (problems.length) { for (const p of problems) console.error(`FAIL ${p}`); process.exit(1); }
  console.log(`ok: ${fileNames(community).length} community files, ${fileNames(pro).length} pro files, no crossover`);
}
