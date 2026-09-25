/**
 * Pixel art for the props the office draws itself: the two task cork boards,
 * the archive table with its stack of finished sheets, the ASK ME board and the
 * notes a worker carries to its desk.
 *
 * They used to be flat rectangles next to LimeZu furniture that has a dark
 * outline, a highlight and a shadow on every piece, so they read as UI stuck
 * on the map. These follow the tileset's own rules instead: a 1px outline in
 * the furniture's ink (#391624, sampled from the desks), a lit top edge, a
 * shaded bottom edge, and only whole pixels (no half-pixel strokes, which
 * blur when the camera scales).
 *
 * Pure: each function returns the rectangles to fill, in the prop's local
 * coordinates, so OfficeFloor draws them with Pixi and a test (or a preview
 * script) can draw the same thing on a canvas.
 */

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
  alpha?: number;
}

/** The furniture outline and wood ramp, sampled from office-tileset.png (desks and chairs). */
export const INK = 0x391624;
export const WOOD_DARK = 0x734934;
export const WOOD = 0xa17849;
export const WOOD_LIGHT = 0xc1a96c;
const CORK = 0xd2b584;
const CORK_DARK = 0xb8995f;

/** Same hue, darker: the shaded bottom row of a note or header. */
export function shade(color: number, amount = 0.25): number {
  const k = 1 - amount;
  const r = Math.round(((color >> 16) & 0xff) * k);
  const g = Math.round(((color >> 8) & 0xff) * k);
  const b = Math.round((color & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}

interface FrameColors { base: number; light: number; dark: number }
const WOOD_FRAME: FrameColors = { base: WOOD, light: WOOD_LIGHT, dark: WOOD_DARK };
const LILAC_FRAME: FrameColors = { base: 0x5b4a6b, light: 0x7a6690, dark: 0x44365a };

/** Speckles on the cork, fixed so the board never flickers between redraws. */
const SPECKLES: Array<[number, number]> = [[4, 1], [11, 8], [19, 3], [24, 9], [7, 10], [15, 5], [22, 0]];

/** A board: outline, lit/shaded frame, header strip, cork, and a soft shadow on the wall. */
function board(ox: number, header: number, frame: FrameColors): PixelRect[] {
  return [
    { x: ox + 1, y: 14, w: 29, h: 1, color: 0x000000, alpha: 0.18 }, // shadow on the wall
    { x: ox, y: -8, w: 30, h: 22, color: INK },                        // outline
    { x: ox + 1, y: -7, w: 28, h: 20, color: frame.base },             // frame
    { x: ox + 1, y: -7, w: 28, h: 1, color: frame.light },             // lit top edge
    { x: ox + 1, y: 12, w: 28, h: 1, color: frame.dark },              // shaded bottom edge
    { x: ox + 2, y: -6, w: 26, h: 2, color: header },                  // header strip
    { x: ox + 2, y: -4, w: 26, h: 1, color: shade(header) },
    { x: ox + 2, y: -3, w: 26, h: 15, color: CORK },                   // cork
    { x: ox + 2, y: -3, w: 26, h: 1, color: CORK_DARK },               // cork sits under the header
    ...SPECKLES.map(([sx, sy]): PixelRect => ({ x: ox + 3 + sx, y: sy, w: 1, h: 1, color: CORK_DARK })),
  ];
}

/** One pinned note: body, shaded bottom row, and a pin in the ink color. */
function note(x: number, y: number, color: number): PixelRect[] {
  return [
    { x, y, w: 5, h: 3, color },
    { x, y: y + 3, w: 5, h: 1, color: shade(color) },
    { x: x + 2, y, w: 1, h: 1, color: INK },
  ];
}

export const BOARD_NOTES_MAX = 12;

/** A task cork board at local x `ox`: up to 12 notes in 4×3, the rest as a pile in the corner. */
export function corkBoard(ox: number, header: number, notes: number[]): PixelRect[] {
  const out = board(ox, header, WOOD_FRAME);
  const n = Math.min(notes.length, BOARD_NOTES_MAX);
  for (let i = 0; i < n; i++) out.push(...note(ox + 3 + (i % 4) * 6, -2 + Math.floor(i / 4) * 4, notes[i]));
  if (notes.length > BOARD_NOTES_MAX) {
    out.push({ x: ox + 20, y: 7, w: 7, h: 5, color: INK });
    out.push({ x: ox + 21, y: 8, w: 5, h: 3, color: 0xe8e0c8 });
    out.push({ x: ox + 22, y: 7, w: 5, h: 3, color: 0xf2eddc });
  }
  return out;
}

export const ARCHIVE_STACK_MAX = 6;

/** The archive table at the end of the boards, with one sheet per finished task (up to 6 shown). */
export function archiveTable(done: number, sheet: number): PixelRect[] {
  const out: PixelRect[] = [
    { x: 68, y: 16, w: 14, h: 1, color: 0x000000, alpha: 0.18 },       // shadow on the floor
    { x: 67, y: 5, w: 16, h: 7, color: INK },                           // table outline
    { x: 68, y: 6, w: 14, h: 2, color: WOOD_LIGHT },                    // top
    { x: 68, y: 8, w: 14, h: 3, color: WOOD },                          // front
    { x: 68, y: 10, w: 14, h: 1, color: WOOD_DARK },
    { x: 68, y: 12, w: 3, h: 4, color: INK },                           // legs
    { x: 69, y: 12, w: 1, h: 3, color: WOOD_DARK },
    { x: 79, y: 12, w: 3, h: 4, color: INK },
    { x: 80, y: 12, w: 1, h: 3, color: WOOD_DARK },
  ];
  const stack = Math.min(done, ARCHIVE_STACK_MAX);
  for (let i = 0; i < stack; i++) {
    const x = 71 + (i % 2);
    const y = 4 - i * 2;
    out.push({ x: x - 1, y, w: 10, h: 2, color: INK });
    out.push({ x, y, w: 8, h: 1, color: sheet });
    out.push({ x, y: y + 1, w: 8, h: 1, color: shade(sheet) });
  }
  return out;
}

export const ASK_NOTES_MAX = 8;
const ASK_NOTE = 0xcdb4e8;
const QUESTION_MARK: Array<[number, number, number, number]> = [[13, -1, 4, 1], [16, 0, 1, 2], [15, 2, 1, 2], [15, 6, 1, 1]];

/**
 * The ASK ME board: lilac frame, one lilac note per open question. `pulse` is
 * the attention ring's alpha while questions wait (null draws no ring).
 */
export function askBoard(count: number, pulse: number | null): PixelRect[] {
  const out = board(0, ASK_NOTE, LILAC_FRAME);
  if (count === 0) {
    for (const [x, y, w, h] of QUESTION_MARK) out.push({ x, y, w, h, color: 0x8a755f, alpha: 0.8 });
  } else {
    const n = Math.min(count, ASK_NOTES_MAX);
    for (let i = 0; i < n; i++) out.push(...note(3 + (i % 4) * 6, -2 + Math.floor(i / 4) * 5, ASK_NOTE));
  }
  if (pulse !== null) {
    // A whole-pixel ring, 2px out from the outline.
    const [x, y, w, h] = [-3, -11, 36, 28];
    out.push({ x, y, w, h: 1, color: ASK_NOTE, alpha: pulse });
    out.push({ x, y: y + h - 1, w, h: 1, color: ASK_NOTE, alpha: pulse });
    out.push({ x, y: y + 1, w: 1, h: h - 2, color: ASK_NOTE, alpha: pulse });
    out.push({ x: x + w - 1, y: y + 1, w: 1, h: h - 2, color: ASK_NOTE, alpha: pulse });
  }
  return out;
}

/** A note a worker took to its desk; `idx` stacks several side by side. */
export function deskNote(idx: number, color: number): PixelRect[] {
  return note(idx * 7, -(idx % 2), color);
}
