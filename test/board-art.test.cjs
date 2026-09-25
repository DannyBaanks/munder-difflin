'use strict';

/**
 * The office's own props (task boards, archive table, ASK ME board, desk notes)
 * and the office map's walls follow the tileset's pixel-art rules: whole
 * pixels, a dark outline around every piece, and wall ends that are closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const B = loadTs('src/renderer/src/scene/office/boardArt.ts');
const N = { todo: 0xf2df8a, doing: 0x9ecbf0, blocked: 0xf0a3a3, done: 0xa8e0b0 };

const whole = (rects) => rects.every((r) => [r.x, r.y, r.w, r.h].every(Number.isInteger) && r.w > 0 && r.h > 0);
const hasOutline = (rects, x, y, w, h) => rects.some((r) => r.color === B.INK && r.x === x && r.y === y && r.w === w && r.h === h);

test('every prop is drawn in whole pixels (no half-pixel strokes that blur when scaled)', () => {
  const all = [
    B.corkBoard(0, N.blocked, Array(20).fill(N.blocked)),
    B.corkBoard(34, N.todo, [N.todo, N.doing]),
    B.archiveTable(9, N.done),
    B.askBoard(0, null),
    B.askBoard(11, 0.5),
    B.deskNote(3, N.doing),
  ];
  for (const rects of all) assert.ok(whole(rects));
});

test('boards, table and notes carry the furniture outline color', () => {
  assert.equal(B.INK, 0x391624, 'the desks\' outline in office-tileset.png');
  assert.ok(hasOutline(B.corkBoard(0, N.blocked, []), 0, -8, 30, 22));
  assert.ok(hasOutline(B.corkBoard(34, N.todo, []), 34, -8, 30, 22));
  assert.ok(hasOutline(B.askBoard(0, null), 0, -8, 30, 22));
  assert.ok(hasOutline(B.archiveTable(0, N.done), 67, 5, 16, 7));
  assert.ok(B.deskNote(0, N.doing).some((r) => r.color === B.INK), 'the pin');
});

test('notes stay inside the cork, and the caps still hold (12 per board, 8 asks, 6 sheets)', () => {
  const notes = (rects, color) => rects.filter((r) => r.color === color && r.w === 5 && r.h === 3);
  const board = B.corkBoard(0, N.blocked, Array(15).fill(N.todo));
  const shown = notes(board, N.todo);
  assert.equal(shown.length, B.BOARD_NOTES_MAX);
  for (const r of shown) assert.ok(r.x >= 2 && r.x + r.w <= 28 && r.y >= -3 && r.y + 4 <= 12, `note at ${r.x},${r.y} is on the cork`);
  assert.ok(board.some((r) => r.color === 0xf2eddc), 'overflow pile');
  assert.equal(notes(B.askBoard(20, null), 0xcdb4e8).length, B.ASK_NOTES_MAX);
  assert.equal(B.archiveTable(20, N.done).filter((r) => r.color === N.done).length, B.ARCHIVE_STACK_MAX);
});

test('the ASK ME ring only shows while questions wait', () => {
  const ring = (rects) => rects.filter((r) => r.alpha !== undefined && r.color === 0xcdb4e8);
  assert.equal(ring(B.askBoard(0, null)).length, 0);
  assert.equal(ring(B.askBoard(2, 0.4)).length, 4);
  assert.ok(ring(B.askBoard(2, 0.4)).every((r) => r.alpha === 0.4));
});

test('shade darkens without changing the hue', () => {
  assert.equal(B.shade(0xffffff, 0.5), 0x808080);
  assert.equal(B.shade(0xf0a3a3), (180 << 16) | (122 << 8) | 122);
});

// ─── office.tmj walls ────────────────────────────────────────────────────────
const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/assets/maps/office.tmj'), 'utf8'));
const W = map.width, H = map.height, FG = 513;
const walls = map.layers.find((l) => l.name === 'walls').data;
const collision = map.layers.find((l) => l.name === 'collision').data;
const L = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : walls[y * W + x] ? walls[y * W + x] - FG : null);
const frame = (x, y) => x === 0 || x === W - 1 || y <= 2 || y === H - 1;
// A5 Office Floors & Walls: straight pieces vs. the pieces that close an end.
const TOP = 9, VBODY = 130;
const LEFT_ENDS = new Set([7]), RIGHT_ENDS = new Set([11]);

test('office map: every wall is still where the collision layer says (art only, no new walls)', () => {
  for (let i = 0; i < walls.length; i++) if (walls[i]) assert.equal(collision[i], 1, `wall tile ${i} is walkable`);
});

test('office map: no interior wall ends open (the tileset\'s end pieces close every free end)', () => {
  for (let y = 3; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const t = L(x, y);
    // A straight top piece may only continue into another wall.
    if (t === TOP) {
      if (L(x - 1, y) === null && L(x - 1, y + 1) === null) assert.fail(`open left end at ${x},${y}`);
      if (L(x + 1, y) === null && L(x + 1, y + 1) === null) assert.fail(`open right end at ${x},${y}`);
    }
    if (LEFT_ENDS.has(t)) assert.equal(L(x - 1, y), null, `left end piece at ${x},${y} has a wall beside it`);
    if (RIGHT_ENDS.has(t)) assert.equal(L(x + 1, y), null, `right end piece at ${x},${y} has a wall beside it`);
    // A vertical body needs something above and below it: wall, frame, or a cap.
    if (t === VBODY) {
      assert.ok(L(x, y - 1) !== null || frame(x, y - 1), `vertical wall at ${x},${y} opens upward`);
      assert.ok(L(x, y + 1) !== null || frame(x, y + 1), `vertical wall at ${x},${y} opens downward`);
    }
  }
});
