'use strict';
/**
 * Paridad Android ↔ oficina, espejo del job `assets` de ios.yml:
 *
 *   node android/MunderMobile/scripts/check-assets.cjs        revisa
 *   node android/MunderMobile/scripts/check-assets.cjs --fix  recopia
 *
 * Revisa:
 *  1. Retratos: android/.../assets/Media/Cast/*.png = los que genera avatar-engine.cjs.
 *  2. Demos: overview/demo-peers/demo-panel iguales a ios/Media/Demo/.
 *  3. Fuente PressStart2P en assets y en res/font.
 *  4. panelRemoteBlocked (OfficeStore.kt) = PANEL_OFF (lib-remote.cjs).
 *  5. applicationId / namespace = mx.isyco.munder.mobile (igual que el bundle iOS).
 */
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');

const ANDROID = path.join(__dirname, '..');
const REPO = path.join(ANDROID, '..', '..');
const fix = process.argv.includes('--fix');

let fail = 0;
const ok = (m) => console.log(`ok   ${m}`);
const bad = (m) => { console.error(`FAIL ${m}`); fail = 1; };

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// 1+2+3) assets copiados de iOS (misma fuente: avatar-engine + make-assets).
const pairs = [];
for (const f of fs.readdirSync(path.join(REPO, 'ios/MunderMobile/Media/Cast'))) {
  pairs.push([`ios/MunderMobile/Media/Cast/${f}`, `android/MunderMobile/app/src/main/assets/Media/Cast/${f}`]);
}
for (const f of ['overview.json', 'demo-peers.json', 'demo-panel.json']) {
  pairs.push([`ios/MunderMobile/Media/Demo/${f}`, `android/MunderMobile/app/src/main/assets/Media/Demo/${f}`]);
}
pairs.push(['ios/MunderMobile/Media/Fonts/PressStart2P-Regular.ttf', 'android/MunderMobile/app/src/main/assets/Media/Fonts/PressStart2P-Regular.ttf']);
pairs.push(['ios/MunderMobile/Media/Fonts/PressStart2P-Regular.ttf', 'android/MunderMobile/app/src/main/res/font/press_start_2p.ttf']);
pairs.push(['ios/MunderMobile/Tests/vectors.json', 'android/MunderMobile/app/src/test/resources/vectors.json']);
pairs.push(['ios/MunderMobile/Media/Demo/overview.json', 'android/MunderMobile/app/src/test/resources/overview.json']);
pairs.push(['ios/MunderMobile/Media/Demo/demo-peers.json', 'android/MunderMobile/app/src/test/resources/demo-peers.json']);
pairs.push(['ios/MunderMobile/Media/Demo/demo-panel.json', 'android/MunderMobile/app/src/test/resources/demo-panel.json']);

for (const [srcRel, dstRel] of pairs) {
  const src = path.join(REPO, srcRel), dst = path.join(REPO, dstRel);
  if (!fs.existsSync(src)) { bad(`falta fuente ${srcRel}`); continue; }
  if (!fs.existsSync(dst)) {
    if (fix) { copy(src, dst); ok(`copiado ${dstRel}`); }
    else bad(`falta ${dstRel} (--fix lo copia)`);
    continue;
  }
  const a = fs.readFileSync(src), b = fs.readFileSync(dst);
  if (!a.equals(b)) {
    if (fix) { copy(src, dst); ok(`actualizado ${dstRel}`); }
    else bad(`diverge ${dstRel} (recopia de ${srcRel}, o --fix)`);
  } else ok(dstRel);
}

// 4) la misma lista de botones bloqueados en los dos móviles y el host.
{
  const blocked = require(path.join(REPO, 'tools/munder/lib-remote.cjs')).PANEL_OFF;
  const kt = fs.readFileSync(path.join(ANDROID, 'app/src/main/java/mx/isyco/munder/mobile/OfficeStore.kt'), 'utf8');
  const m = kt.match(/panelRemoteBlocked[^=]*=\s*setOf\(([^)]+)\)/);
  if (!m) bad('no se encontró panelRemoteBlocked en OfficeStore.kt');
  else {
    const inKt = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    const same = JSON.stringify(inKt) === JSON.stringify([...blocked].sort());
    console.log(`lib-remote PANEL_OFF: ${blocked.join(' ')}`);
    console.log(`OfficeStore Kotlin : ${inKt.join(' ')}`);
    if (!same) bad('las dos listas de botones bloqueados no coinciden');
    else ok('PANEL_OFF = panelRemoteBlocked');
  }
}

// 5) mismo sustrato, mismo nombre: el applicationId es el bundle de iOS.
{
  const gradle = fs.readFileSync(path.join(ANDROID, 'app/build.gradle.kts'), 'utf8');
  const manifest = fs.readFileSync(path.join(ANDROID, 'app/src/main/AndroidManifest.xml'), 'utf8');
  if (!gradle.includes('mx.isyco.munder.mobile')) bad('applicationId/namespace no es mx.isyco.munder.mobile');
  else ok('applicationId = mx.isyco.munder.mobile');
  if (!manifest.includes('usesCleartextTraffic="true"')) bad('el Manifest debe permitir http plano (sellado munder-remote@1, igual que iOS)');
  else ok('Manifest permite http plano sellado');
}

if (fail) { console.error('\nassets Android desactualizados'); process.exit(1); }
console.log('\nassets Android al día');
