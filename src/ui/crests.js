// Procedural HUD art — team crests and the game wordmark, drawn with canvas 2D.
// No binary assets: everything here returns a data: URL the HUD drops into an <img>
// or a CSS background. Results are memoised, so calling repeatedly is free.
//
//   crestURL(team, px)   -> data:image/png  shield crest in the team's kit colours
//   wordmarkURL(w, h)    -> data:image/png  "CANVAS SOCCER" lockup for the menus
//   ballGlyphURL(px)     -> data:image/png  small football glyph
//
// Everything is deterministic — no RNG, no clock.

import { TEAMS } from '../core/constants.js';

const cache = new Map();
const memo = (key, make) => {
  if (cache.has(key)) return cache.get(key);
  let v = '';
  try { v = make(); } catch (e) { v = ''; }
  cache.set(key, v);
  return v;
};

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return hex(
    ((Math.round(ar + (br - ar) * t) << 16) |
      (Math.round(ag + (bg - ag) * t) << 8) |
      Math.round(ab + (bb - ab) * t)) >>> 0,
  );
}

function surface(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------------------------------------------------------------- shield path
function shieldPath(g, x, y, w, h) {
  const r = w * 0.20;           // rounded top corners
  const sh = h * 0.46;          // where the taper starts
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + sh);
  // shoulder -> point: a deep taper so the silhouette still reads at 40 px
  g.bezierCurveTo(x + w, y + h * 0.78, x + w * 0.72, y + h * 0.93, x + w / 2, y + h);
  g.bezierCurveTo(x + w * 0.28, y + h * 0.93, x, y + h * 0.78, x, y + sh);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function drawBall(g, cx, cy, r) {
  g.save();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(20,26,40,.55)'; g.lineWidth = Math.max(1, r * 0.10); g.stroke();
  // centre pentagon
  g.fillStyle = '#1a2233';
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    const px = cx + Math.cos(a) * r * 0.42, py = cy + Math.sin(a) * r * 0.42;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath(); g.fill();
  // seams outward from each pentagon vertex
  g.strokeStyle = '#1a2233';
  g.lineWidth = Math.max(1, r * 0.13);
  g.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42);
    g.lineTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
    g.stroke();
  }
  g.restore();
}

/**
 * Team crest: shield, kit-coloured, diagonal sash in the trim colour, football
 * roundel, white keyline and a gloss highlight.
 */
export function crestURL(teamIndex, size = 192) {
  return memo(`crest:${teamIndex}:${size}`, () => {
    const t = TEAMS[teamIndex] || TEAMS[0];
    const S = size;
    const c = surface(S, S);
    const g = c.getContext('2d', { willReadFrequently: true });
    const pad = S * 0.06;
    const w = S - pad * 2, h = S - pad * 2;
    const x = pad, y = pad * 0.6;

    // drop shadow
    g.save();
    g.translate(0, S * 0.02);
    shieldPath(g, x, y, w, h * 0.98);
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.filter = 'blur(' + (S * 0.02) + 'px)';
    g.fill();
    g.restore();

    // body
    g.save();
    shieldPath(g, x, y, w, h * 0.98);
    g.clip();
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, mix(t.kit, 0xffffff, 0.28));
    grad.addColorStop(0.52, hex(t.kit));
    grad.addColorStop(1, hex(t.kitDark));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);

    // diagonal sash in the trim colour
    g.fillStyle = hex(t.trim);
    g.globalAlpha = 0.92;
    g.beginPath();
    g.moveTo(x - S, y + h * 0.62);
    g.lineTo(x - S + S * 1.05, y - h * 0.5);
    g.lineTo(x - S + S * 1.42, y - h * 0.5);
    g.lineTo(x - S + S * 0.37, y + h * 0.62);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;

    // gloss
    const gl = g.createLinearGradient(0, y, 0, y + h * 0.55);
    gl.addColorStop(0, 'rgba(255,255,255,.30)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.fillRect(0, 0, S, S * 0.62);

    // bottom shade
    const sd = g.createLinearGradient(0, y + h * 0.55, 0, y + h);
    sd.addColorStop(0, 'rgba(0,0,0,0)');
    sd.addColorStop(1, 'rgba(0,0,0,.34)');
    g.fillStyle = sd;
    g.fillRect(0, y + h * 0.5, S, S);
    g.restore();

    // Monogram — at HUD scale a letter reads instantly where a detailed device
    // would turn to mush. A small ball sits under it as the sport cue.
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 ' + Math.round(S * 0.50) + 'px "Arial Black","Helvetica Neue",Impact,' +
      '"DejaVu Sans","Liberation Sans",system-ui,sans-serif';
    const letter = (t.short || t.name || 'C').charAt(0).toUpperCase();
    const my = S * 0.44;
    g.lineJoin = 'round';
    g.lineWidth = S * 0.11;
    g.strokeStyle = 'rgba(6,12,26,.9)';
    g.strokeText(letter, S * 0.5, my);
    const lg = g.createLinearGradient(0, my - S * 0.24, 0, my + S * 0.24);
    lg.addColorStop(0, '#ffffff');
    lg.addColorStop(0.55, '#ffffff');
    lg.addColorStop(1, '#cfe0f4');
    g.fillStyle = lg;
    g.fillText(letter, S * 0.5, my);
    g.restore();

    drawBall(g, S * 0.5, S * 0.735, S * 0.115);

    // keylines
    g.save();
    shieldPath(g, x, y, w, h * 0.98);
    g.lineWidth = S * 0.085; g.strokeStyle = 'rgba(6,12,22,.9)'; g.stroke();
    g.lineWidth = S * 0.050; g.strokeStyle = '#ffffff'; g.stroke();
    g.restore();

    return c.toDataURL('image/png');
  });
}

/** Small football glyph, used as a bullet in menus and the lower third. */
export function ballGlyphURL(size = 64) {
  return memo(`ball:${size}`, () => {
    const c = surface(size, size);
    const g = c.getContext('2d', { willReadFrequently: true });
    drawBall(g, size / 2, size / 2, size * 0.44);
    return c.toDataURL('image/png');
  });
}

/**
 * Game wordmark. Two stacked words, heavy, italic, white with a dark keyline and
 * a warm underline sweep. Used on the main menu and the intro card.
 */
export function wordmarkURL(w = 900, h = 300) {
  return memo(`wm:${w}:${h}`, () => {
    const c = surface(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    const F = '900 ' + Math.round(h * 0.40) + 'px "Arial Black","Helvetica Neue",Impact,' +
      '"DejaVu Sans","Liberation Sans",system-ui,sans-serif';
    const F2 = '900 ' + Math.round(h * 0.24) + 'px "Arial Black","Helvetica Neue",Impact,' +
      '"DejaVu Sans","Liberation Sans",system-ui,sans-serif';

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.setTransform(1, 0, -0.14, 1, h * 0.09, 0);   // italic skew

    // CANVAS
    g.font = F2;
    g.letterSpacing = Math.round(h * 0.06) + 'px';
    let y1 = h * 0.26;
    g.lineJoin = 'round';
    g.lineWidth = h * 0.075;
    g.strokeStyle = 'rgba(6,14,26,.92)';
    g.strokeText('CANVAS', w / 2, y1);
    g.fillStyle = '#dff0ff';
    g.fillText('CANVAS', w / 2, y1);

    // SOCCER
    g.font = F;
    g.letterSpacing = Math.round(h * 0.03) + 'px';
    const y2 = h * 0.66;
    g.lineWidth = h * 0.115;
    g.strokeStyle = 'rgba(6,14,26,.95)';
    g.strokeText('SOCCER', w / 2, y2);
    const wg = g.createLinearGradient(0, y2 - h * 0.22, 0, y2 + h * 0.22);
    wg.addColorStop(0, '#ffffff');
    wg.addColorStop(0.52, '#ffffff');
    wg.addColorStop(0.53, '#ffdf6e');
    wg.addColorStop(1, '#ffab2e');
    g.fillStyle = wg;
    g.fillText('SOCCER', w / 2, y2);

    g.setTransform(1, 0, 0, 1, 0, 0);
    // underline sweep
    const ug = g.createLinearGradient(w * 0.12, 0, w * 0.88, 0);
    ug.addColorStop(0, 'rgba(255,171,46,0)');
    ug.addColorStop(0.5, 'rgba(255,171,46,.95)');
    ug.addColorStop(1, 'rgba(255,171,46,0)');
    g.fillStyle = ug;
    g.fillRect(w * 0.12, h * 0.90, w * 0.76, Math.max(2, h * 0.022));
    return c.toDataURL('image/png');
  });
}
