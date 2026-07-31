// HUD: scoreboard, clock, possession, goal banner, virtual stick and action buttons.
// Pure DOM over the canvas — no game logic, it only reports input state.
//
//   createHud(root) -> { setScore(a,b), setClock(t), banner(text, sub),
//                        input, setPossession(t), showMenu(k), update(dt) }
//
// `input` is a live object the sim reads each step:
//   { move:{x,y}, sprint, slide, switchPressed, shootHeld, shootCharge, consume() }

import { TEAMS } from '../core/constants.js';

const CSS = `
#cs-hud, #cs-hud * { box-sizing: border-box; font-family: "Trebuchet MS","Segoe UI",system-ui,sans-serif; }
#cs-hud { position:absolute; inset:0; pointer-events:none; overflow:hidden; }

.cs-top { position:absolute; top:14px; left:0; right:0; display:flex; justify-content:center; gap:10px; }
.cs-score {
  display:flex; align-items:stretch; border-radius:12px; overflow:hidden;
  background:rgba(8,14,22,.62); backdrop-filter:blur(6px);
  box-shadow:0 6px 22px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.10);
  font-weight:900; letter-spacing:.06em;
}
.cs-team { display:flex; align-items:center; gap:8px; padding:9px 15px; font-size:19px; color:#fff; text-shadow:0 2px 3px rgba(0,0,0,.55); }
.cs-chip { width:14px; height:14px; border-radius:4px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.35); }
.cs-nums { display:flex; align-items:center; padding:9px 16px; font-size:26px; color:#fff;
  background:rgba(0,0,0,.35); text-shadow:0 2px 4px rgba(0,0,0,.6); letter-spacing:.12em; }
.cs-clock { margin-left:8px; padding:9px 14px; font-size:17px; color:#bfe6ff; background:rgba(0,0,0,.35);
  border-radius:12px; font-weight:800; letter-spacing:.1em;
  box-shadow:0 6px 22px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.10); }
.cs-poss { position:absolute; top:62px; left:50%; transform:translateX(-50%);
  font-size:11px; letter-spacing:.28em; font-weight:800; color:#dff3ff; opacity:.85;
  text-shadow:0 2px 4px rgba(0,0,0,.6); }

.cs-banner { position:absolute; top:26%; left:0; right:0; text-align:center; opacity:0;
  transform:scale(.82); transition:opacity .18s ease, transform .28s cubic-bezier(.2,1.5,.4,1); }
.cs-banner.on { opacity:1; transform:scale(1); }
.cs-banner h1 { margin:0; font-size:88px; font-weight:900; letter-spacing:.06em; color:#fff;
  -webkit-text-stroke:5px rgba(10,20,40,.85);
  paint-order:stroke fill;
  text-shadow:0 10px 26px rgba(0,0,0,.55), 0 0 34px rgba(255,214,90,.55); }
.cs-banner p { margin:6px 0 0; font-size:20px; font-weight:800; letter-spacing:.22em; color:#ffe27a;
  text-shadow:0 3px 10px rgba(0,0,0,.7); }

.cs-stick { position:absolute; left:5.2%; bottom:8%; width:210px; height:210px; pointer-events:auto; touch-action:none; }
.cs-stick .ring { position:absolute; inset:0; border-radius:50%;
  border:3px solid rgba(255,255,255,.42); background:rgba(255,255,255,.06); }
.cs-stick .pad { position:absolute; left:50%; top:50%; width:118px; height:118px; margin:-59px 0 0 -59px;
  border-radius:50%; background:radial-gradient(circle at 38% 32%, rgba(190,222,255,.92), rgba(112,158,205,.78));
  border:3px solid rgba(255,255,255,.55); box-shadow:0 8px 20px rgba(0,0,0,.35);
  display:flex; align-items:center; justify-content:center; transition:transform .04s linear; }
.cs-stick .pad svg { width:78px; height:78px; opacity:.75; }

.cs-btns { position:absolute; right:4.2%; bottom:6.5%; width:290px; height:250px; pointer-events:none; }
.cs-btn { position:absolute; width:112px; height:112px; border-radius:50%; pointer-events:auto;
  display:flex; align-items:center; justify-content:center;
  background:rgba(16,26,20,.42); backdrop-filter:blur(3px);
  font-size:22px; font-weight:900; letter-spacing:.05em; color:#fff;
  text-shadow:0 3px 6px rgba(0,0,0,.8); user-select:none;
  transition:transform .07s ease, background .12s ease; }
.cs-btn:active, .cs-btn.down { transform:scale(.92); background:rgba(40,60,48,.62); }
.cs-btn.slide  { right:6px;   top:0;    border:6px solid #ef6f78; box-shadow:0 0 18px rgba(239,111,120,.35); }
.cs-btn.sprint { right:6px;   bottom:0; border:6px solid #7fd48a; box-shadow:0 0 18px rgba(127,212,138,.35); width:104px; height:104px; font-size:20px; }
.cs-btn.switch { right:128px; bottom:0; border:6px solid #6fc9e0; box-shadow:0 0 18px rgba(111,201,224,.35); width:98px; height:98px; font-size:18px; }

.cs-menu { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
  background:rgba(4,10,16,.72); pointer-events:auto; }
.cs-menu.on { display:flex; }
.cs-menu .card { text-align:center; padding:34px 52px; border-radius:20px; background:rgba(12,22,32,.85);
  box-shadow:0 20px 60px rgba(0,0,0,.6), inset 0 0 0 1px rgba(255,255,255,.12); }
.cs-menu h2 { margin:0 0 6px; font-size:44px; font-weight:900; color:#fff; letter-spacing:.05em; }
.cs-menu p { margin:0; color:#a9c6da; font-size:15px; letter-spacing:.16em; font-weight:700; }

.cs-hint { position:absolute; left:50%; bottom:14px; transform:translateX(-50%);
  font-size:11px; letter-spacing:.2em; color:rgba(255,255,255,.55); font-weight:700; }

@media (max-width: 860px) {
  .cs-stick { width:160px; height:160px; }
  .cs-stick .pad { width:92px; height:92px; margin:-46px 0 0 -46px; }
  .cs-btn { width:88px; height:88px; font-size:17px; }
  .cs-banner h1 { font-size:56px; }
}
`;

const ARROWS = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <g fill="#1e3550">
    <path d="M50 12 L62 30 L38 30 Z"/><path d="M50 88 L38 70 L62 70 Z"/>
    <path d="M12 50 L30 38 L30 62 Z"/><path d="M88 50 L70 62 L70 38 Z"/>
  </g></svg>`;

export function createHud(root) {
  if (!document.getElementById('cs-hud-style')) {
    const st = document.createElement('style');
    st.id = 'cs-hud-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const el = document.createElement('div');
  el.id = 'cs-hud';
  el.innerHTML = `
    <div class="cs-top">
      <div class="cs-score">
        <div class="cs-team"><span class="cs-chip" id="cs-chip-a"></span><span id="cs-name-a">RED</span></div>
        <div class="cs-nums"><span id="cs-a">0</span>&nbsp;-&nbsp;<span id="cs-b">0</span></div>
        <div class="cs-team"><span id="cs-name-b">BLU</span><span class="cs-chip" id="cs-chip-b"></span></div>
      </div>
      <div class="cs-clock" id="cs-clock">3:00</div>
    </div>
    <div class="cs-poss" id="cs-poss">RED BALL</div>

    <div class="cs-banner" id="cs-banner"><h1 id="cs-banner-t">GOAL!</h1><p id="cs-banner-s"></p></div>

    <div class="cs-stick" id="cs-stick">
      <div class="ring"></div>
      <div class="pad" id="cs-pad">${ARROWS}</div>
    </div>

    <div class="cs-btns">
      <div class="cs-btn slide"  data-act="slide">SLIDE</div>
      <div class="cs-btn sprint" data-act="sprint">SPRINT</div>
      <div class="cs-btn switch" data-act="switch">SWITCH</div>
    </div>

    <div class="cs-menu" id="cs-menu"><div class="card"><h2 id="cs-menu-t">PAUSED</h2><p id="cs-menu-s">TAP TO RESUME</p></div></div>
    <div class="cs-hint">WASD / ARROWS &nbsp;·&nbsp; SPACE SHOOT &nbsp;·&nbsp; SHIFT SPRINT &nbsp;·&nbsp; E SWITCH</div>
  `;
  root.appendChild(el);

  const $ = (id) => el.querySelector('#' + id);
  const chipA = $('cs-chip-a'), chipB = $('cs-chip-b');
  chipA.style.background = '#' + TEAMS[0].kit.toString(16).padStart(6, '0');
  chipB.style.background = '#' + TEAMS[1].kit.toString(16).padStart(6, '0');
  $('cs-name-a').textContent = TEAMS[0].name;
  $('cs-name-b').textContent = TEAMS[1].name;

  const pad = $('cs-pad');
  const stick = $('cs-stick');
  const bannerEl = $('cs-banner');
  const menuEl = $('cs-menu');

  // ---- input state --------------------------------------------------------
  const input = {
    move: { x: 0, y: 0 },
    sprint: false,
    slide: false,
    switchPressed: false,
    shootHeld: false,
    shootCharge: 0,
    passPressed: false,
    anyGesture: false,
    consume() {
      const s = { slide: this.slide, switchPressed: this.switchPressed, passPressed: this.passPressed };
      this.slide = false; this.switchPressed = false; this.passPressed = false;
      return s;
    },
  };

  // virtual stick
  let stickId = null;
  const stickCenter = { x: 0, y: 0 };
  const RADIUS = 62;

  function stickStart(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    stickId = e.changedTouches ? t.identifier : 'mouse';
    const r = stick.getBoundingClientRect();
    stickCenter.x = r.left + r.width / 2;
    stickCenter.y = r.top + r.height / 2;
    input.anyGesture = true;
    stickMove(e);
  }
  function stickMove(e) {
    if (stickId === null) return;
    let t = e;
    if (e.changedTouches) {
      t = [...e.changedTouches].find((c) => c.identifier === stickId);
      if (!t) return;
    }
    let dx = t.clientX - stickCenter.x;
    let dy = t.clientY - stickCenter.y;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) { dx = (dx / d) * RADIUS; dy = (dy / d) * RADIUS; }
    pad.style.transform = `translate(${dx}px, ${dy}px)`;
    input.move.x = dx / RADIUS;
    input.move.y = dy / RADIUS;
    e.preventDefault?.();
  }
  function stickEnd() {
    stickId = null;
    pad.style.transform = 'translate(0px, 0px)';
    input.move.x = 0; input.move.y = 0;
  }

  stick.addEventListener('pointerdown', (e) => { stick.setPointerCapture?.(e.pointerId); stickStart(e); });
  stick.addEventListener('pointermove', stickMove);
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);
  stick.addEventListener('pointerleave', (e) => { if (stickId !== null && e.buttons === 0) stickEnd(); });

  // action buttons
  for (const b of el.querySelectorAll('.cs-btn')) {
    const act = b.dataset.act;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.classList.add('down');
      input.anyGesture = true;
      if (act === 'sprint') input.sprint = true;
      if (act === 'slide') input.slide = true;
      if (act === 'switch') input.switchPressed = true;
    });
    const up = () => { b.classList.remove('down'); if (act === 'sprint') input.sprint = false; };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
  }

  // keyboard
  const keys = new Set();
  const onKey = (e, down) => {
    const k = e.key.toLowerCase();
    if (down) keys.add(k); else keys.delete(k);
    if (down) input.anyGesture = true;
    if (k === ' ' || k === 'w' || k === 'a' || k === 's' || k === 'd' ||
      k.startsWith('arrow') || k === 'shift' || k === 'e' || k === 'q') e.preventDefault?.();
    if (down && k === 'e') input.switchPressed = true;
    if (down && k === 'q') input.slide = true;
  };
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => keys.clear());

  function pollKeys(dt) {
    if (stickId !== null) return;
    let x = 0, y = 0;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    if (keys.has('w') || keys.has('arrowup')) y -= 1;
    if (keys.has('s') || keys.has('arrowdown')) y += 1;
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    input.move.x = x; input.move.y = y;
    input.sprint = keys.has('shift') || input.sprint;
    if (!keys.has('shift') && !el.querySelector('.cs-btn.sprint').classList.contains('down')) input.sprint = false;

    const shoot = keys.has(' ');
    if (shoot) input.shootCharge = Math.min(1, input.shootCharge + dt * 1.6);
    else if (input.shootHeld) { /* release handled by main via shootCharge */ }
    input.shootHeld = shoot;
    if (!shoot && input.shootCharge > 0) input.shootCharge = Math.max(0, input.shootCharge - dt * 6);
  }

  // ---- api ----------------------------------------------------------------
  let bannerTimer = 0;

  function setScore(a, b) {
    $('cs-a').textContent = a;
    $('cs-b').textContent = b;
  }
  function setClock(t) {
    const s = Math.max(0, Math.ceil(t));
    $('cs-clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function setPossession(team) {
    const p = $('cs-poss');
    if (team < 0) { p.style.opacity = 0; return; }
    p.style.opacity = 0.85;
    p.textContent = `${TEAMS[team].name} BALL`;
    p.style.color = team === 0 ? '#ffb3b3' : '#b3ccff';
  }
  function banner(text, sub = '', seconds = 2.4) {
    if (!text) { bannerEl.classList.remove('on'); bannerTimer = 0; return; }
    $('cs-banner-t').textContent = text;
    $('cs-banner-s').textContent = sub;
    bannerEl.classList.add('on');
    bannerTimer = seconds;
  }
  function showMenu(kind, title, sub) {
    if (!kind) { menuEl.classList.remove('on'); return; }
    $('cs-menu-t').textContent = title || (kind === 'pause' ? 'PAUSED' : 'FULL TIME');
    $('cs-menu-s').textContent = sub || 'TAP TO RESUME';
    menuEl.classList.add('on');
  }
  function update(dt) {
    pollKeys(dt);
    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) bannerEl.classList.remove('on');
    }
  }
  function setVisible(v) { el.style.display = v ? '' : 'none'; }

  return {
    el, input, setScore, setClock, setPossession, banner, showMenu, update, setVisible,
    dispose() { el.remove(); },
  };
}
