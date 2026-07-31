// HUD — scoreboard, clock, virtual stick, action buttons, banners, menus.
// Pure DOM over the canvas. No game logic: it renders match state it is told about
// and reports input state. Everything scales from a 1920x1080 desktop down to a
// phone-sized viewport through a single numeric `--u` unit set on resize.
//
//   createHud(root) -> {
//     setScore(a,b), setClock(t), setPossession(t), banner(text, sub, secs),
//     showMenu(kind, title, sub), update(dt), setVisible(v),
//     input, el,
//     // extras (additive, safe to ignore)
//     intro(), setDanger(x), setCooldown(name, secs), toast(text), on(evt, fn),
//     setLabels(mode), device
//   }
//
// `input` is a live object the sim reads each step:
//   { move:{x,y}, sprint, slide, switchPressed, shootHeld, shootCharge,
//     passPressed, anyGesture, consume() }

import { TEAMS } from '../core/constants.js';
import { crestURL, ballGlyphURL, wordmarkURL } from './crests.js';

const FONT = '"Arial Black","Arial Bold","Helvetica Neue",Impact,"DejaVu Sans","Liberation Sans",system-ui,sans-serif';

const CSS = `
/* NOTE: the reset is class-scoped on purpose. An "#cs-hud *" rule outranks every
   class selector below it, so a margin/padding reset written that way silently
   flattens the entire HUD layout. Keep specificity low here. */
.cs-hud, .cs-hud * { box-sizing:border-box; font-family:${FONT}; }
.cs-hud h1, .cs-hud h2, .cs-hud p { margin:0; padding:0; font-weight:900; }
#cs-hud {
  position:absolute; inset:0; pointer-events:none; overflow:hidden;
  --u:1; --red:#ff5f6b; --grn:#5fd873; --cyn:#3fcbe8; --amb:#ffb52e;
  --ink:rgba(5,11,22,.92);
  -webkit-font-smoothing:antialiased;
  z-index:10;
}
#cs-hud .u { font-variant-numeric:tabular-nums; }

/* ============================================================ SCOREBOARD === */
.cs-top { position:absolute; top:calc(16px*var(--u)); left:0; right:0;
  display:flex; flex-direction:column; align-items:center;
  transform:translateY(calc(-160px*var(--u))); opacity:0;
  transition:transform .55s cubic-bezier(.16,1.05,.3,1), opacity .35s ease; }
.cs-top.on { transform:none; opacity:1; }

.cs-board { position:relative; display:flex; align-items:stretch; height:calc(74px*var(--u));
  transform:skewX(-9deg);
  filter:drop-shadow(0 calc(7px*var(--u)) calc(16px*var(--u)) rgba(0,0,0,.55)); }
.cs-board > * { position:relative; }
.cs-seg { display:flex; align-items:center; gap:calc(11px*var(--u));
  padding:0 calc(20px*var(--u)); }

.cs-cap { width:calc(16px*var(--u)); }
.cs-cap.a { background:linear-gradient(180deg,var(--ca1),var(--ca2)); }
.cs-cap.b { background:linear-gradient(180deg,var(--cb1),var(--cb2)); }

.cs-side { background:linear-gradient(180deg,#3a3f86 0%,#282c66 52%,#1b1e4c 100%);
  box-shadow:inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.20),
             inset 0 calc(-4px*var(--u)) 0 rgba(0,0,0,.36); }
.cs-side .ab { font-size:calc(30px*var(--u)); font-weight:900; color:#fff; letter-spacing:.04em;
  -webkit-text-stroke:calc(4px*var(--u)) rgba(6,12,26,.55); paint-order:stroke fill; }
.cs-crest { width:calc(56px*var(--u)); height:calc(56px*var(--u)); display:block;
  transform:skewX(9deg) translateY(calc(-1px*var(--u))); image-rendering:auto; }

.cs-mid { background:linear-gradient(180deg,#0d1128 0%,#070a1a 55%,#03040c 100%);
  box-shadow:inset 0 calc(2px*var(--u)) calc(6px*var(--u)) rgba(0,0,0,.8),
             inset calc(3px*var(--u)) 0 calc(8px*var(--u)) rgba(0,0,0,.6),
             inset calc(-3px*var(--u)) 0 calc(8px*var(--u)) rgba(0,0,0,.6),
             inset 0 calc(-4px*var(--u)) 0 rgba(0,0,0,.5);
  padding:0 calc(26px*var(--u)); }
.cs-mid .sc { display:flex; align-items:center; gap:calc(12px*var(--u)); transform:skewX(9deg); }
.cs-mid .n { font-size:calc(40px*var(--u)); font-weight:900; color:#fff; line-height:1;
  -webkit-text-stroke:calc(5px*var(--u)) rgba(0,0,0,.55); paint-order:stroke fill;
  transition:transform .18s cubic-bezier(.2,1.9,.4,1), color .3s ease; }
.cs-mid .n.pop { transform:scale(1.42); color:#ffd964; }
.cs-mid .d { font-size:calc(26px*var(--u)); color:rgba(255,255,255,.5); font-weight:900; }

.cs-clock { transform:skewX(-9deg);
  padding:calc(5px*var(--u)) calc(30px*var(--u)) calc(6px*var(--u));
  background:linear-gradient(180deg,#242a5c,#0d1030);
  box-shadow:0 calc(5px*var(--u)) calc(12px*var(--u)) rgba(0,0,0,.55),
             inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.22),
             inset 0 calc(-3px*var(--u)) 0 rgba(0,0,0,.45);
  border-radius:0 0 calc(7px*var(--u)) calc(7px*var(--u)); }
.cs-clock span { display:block; transform:skewX(9deg);
  font-size:calc(21px*var(--u)); font-weight:900; letter-spacing:.16em; color:#8fd8ff;
  text-shadow:0 calc(2px*var(--u)) calc(4px*var(--u)) rgba(0,0,0,.8); }
.cs-clock.live span { color:#e8fbff; }

/* possession chip under the board */
.cs-poss { margin-top:calc(9px*var(--u)); display:flex; align-items:center; gap:calc(8px*var(--u));
  padding:calc(4px*var(--u)) calc(13px*var(--u)) calc(5px*var(--u));
  border-radius:calc(20px*var(--u)); background:rgba(6,10,22,.5);
  box-shadow:inset 0 0 0 calc(1.5px*var(--u)) rgba(255,255,255,.14);
  font-size:calc(13px*var(--u)); letter-spacing:.24em; font-weight:900;
  text-shadow:0 calc(2px*var(--u)) calc(5px*var(--u)) rgba(0,0,0,.9);
  opacity:0; transition:opacity .3s ease; }
.cs-poss .dot { width:calc(10px*var(--u)); height:calc(10px*var(--u)); border-radius:50%;
  box-shadow:0 0 calc(10px*var(--u)) currentColor; background:currentColor; flex:none; }

/* ============================================================== BIG BANNER = */
.cs-banner { position:absolute; left:0; right:0; top:22%; text-align:center; opacity:0;
  will-change:transform,opacity; }
.cs-banner .glow { position:absolute; left:50%; top:50%; width:calc(1100px*var(--u));
  height:calc(420px*var(--u)); margin:calc(-210px*var(--u)) 0 0 calc(-550px*var(--u));
  background:radial-gradient(ellipse at center, rgba(255,206,84,.42), rgba(255,140,40,.13) 42%, rgba(0,0,0,0) 68%);
  opacity:0; transition:opacity .4s ease; }
.cs-banner.on .glow { opacity:1; }
.cs-banner h1 { position:relative; display:inline-block;
  font-size:calc(122px*var(--u)); font-weight:900; line-height:.98; letter-spacing:.02em;
  color:#fff; -webkit-text-stroke:calc(13px*var(--u)) rgba(9,16,34,.92); paint-order:stroke fill;
  text-shadow:0 calc(10px*var(--u)) calc(26px*var(--u)) rgba(0,0,0,.6);
  transform:skewX(-7deg) scale(.6); opacity:0; }
.cs-banner h1 .fill { position:absolute; inset:0; -webkit-text-stroke:0;
  background:linear-gradient(180deg,#ffffff 0%,#ffffff 52%,#ffe98f 62%,#ffb327 84%,#ff8c12 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent; }
.cs-banner p { margin-top:calc(10px*var(--u)); font-size:calc(27px*var(--u)); font-weight:900;
  letter-spacing:.34em; color:#fff2c4; opacity:0;
  -webkit-text-stroke:calc(4px*var(--u)) rgba(9,16,34,.7); paint-order:stroke fill;
  text-shadow:0 calc(3px*var(--u)) calc(9px*var(--u)) rgba(0,0,0,.85); transform:translateY(calc(14px*var(--u))); }
.cs-banner.on h1 { animation:cs-pop .62s cubic-bezier(.14,1.5,.34,1) forwards; }
.cs-banner.on p  { animation:cs-sub .5s .16s cubic-bezier(.2,1.2,.3,1) forwards; }
.cs-banner.on    { opacity:1; }
@keyframes cs-pop {
  0%   { transform:skewX(-7deg) scale(.35) rotate(-7deg); opacity:0; }
  55%  { transform:skewX(-7deg) scale(1.14) rotate(1.5deg); opacity:1; }
  75%  { transform:skewX(-7deg) scale(.96) rotate(-.6deg); }
  100% { transform:skewX(-7deg) scale(1) rotate(0deg); opacity:1; }
}
@keyframes cs-sub { to { opacity:1; transform:none; } }

/* ============================================================ LOWER THIRD == */
.cs-l3 { position:absolute; left:50%; bottom:calc(34px*var(--u)); display:flex; align-items:stretch;
  transform:translateX(-50%) translateY(calc(150px*var(--u))); opacity:0;
  transition:transform .5s cubic-bezier(.18,1.05,.28,1), opacity .3s ease;
  filter:drop-shadow(0 calc(8px*var(--u)) calc(18px*var(--u)) rgba(0,0,0,.6)); }
.cs-l3.on { transform:translateX(-50%) translateY(0); opacity:1; }
.cs-l3 .badge { display:flex; align-items:center; justify-content:center;
  width:calc(104px*var(--u)); background:linear-gradient(180deg,#3a3f86,#1b1e4c); }
.cs-l3 .badge img { width:calc(66px*var(--u)); height:calc(66px*var(--u)); }
.cs-l3 .body { padding:calc(11px*var(--u)) calc(70px*var(--u)) calc(11px*var(--u)) calc(26px*var(--u));
  min-width:calc(440px*var(--u));
  background:linear-gradient(180deg,#4a3fa0,#2c2570);
  clip-path:polygon(0 0, 100% 0, calc(100% - 30px*var(--u)) 100%, 0 100%);
  box-shadow:inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.2); }
.cs-l3 .t { font-size:calc(33px*var(--u)); font-weight:900; color:#fff; letter-spacing:.05em;
  -webkit-text-stroke:calc(4px*var(--u)) rgba(6,12,26,.4); paint-order:stroke fill; }
.cs-l3 .s { margin-top:calc(3px*var(--u)); font-size:calc(16px*var(--u)); font-weight:900;
  letter-spacing:.2em; color:#c9c3ff; }

/* ================================================================= TOASTS == */
.cs-toast { position:absolute; left:50%; top:calc(132px*var(--u)); transform:translate(-50%,calc(-16px*var(--u)));
  padding:calc(7px*var(--u)) calc(20px*var(--u)); border-radius:calc(6px*var(--u));
  background:rgba(6,10,22,.7); box-shadow:inset 0 0 0 calc(2px*var(--u)) rgba(255,255,255,.14);
  font-size:calc(15px*var(--u)); font-weight:900; letter-spacing:.2em; color:#dfeaff;
  opacity:0; transition:opacity .25s ease, transform .25s ease; }
.cs-toast.on { opacity:1; transform:translate(-50%,0); }

/* ============================================================ VIRTUAL STICK */
.cs-stick { position:absolute;
  left:calc(46px*var(--u) + env(safe-area-inset-left, 0px));
  bottom:calc(24px*var(--u) + env(safe-area-inset-bottom, 0px));
  width:calc(340px*var(--u)); height:calc(340px*var(--u));
  pointer-events:auto; touch-action:none; -webkit-user-select:none; user-select:none;
  transition:opacity .3s ease; }
.cs-stick .ring { position:absolute; inset:0; border-radius:50%;
  border:calc(5px*var(--u)) solid rgba(255,255,255,.62);
  background:radial-gradient(circle at 50% 45%, rgba(255,255,255,.05), rgba(255,255,255,.11) 78%, rgba(255,255,255,.19) 100%);
  box-shadow:0 0 0 calc(2px*var(--u)) rgba(6,14,26,.28),
             0 calc(6px*var(--u)) calc(20px*var(--u)) rgba(0,0,0,.32),
             inset 0 0 0 calc(2px*var(--u)) rgba(6,14,26,.20),
             inset 0 0 calc(30px*var(--u)) rgba(255,255,255,.12); }
.cs-stick .ring2 { position:absolute; inset:calc(24px*var(--u)); border-radius:50%;
  border:calc(2px*var(--u)) solid rgba(255,255,255,.20); }
.cs-stick .pad { position:absolute; left:50%; top:50%;
  width:calc(186px*var(--u)); height:calc(186px*var(--u));
  margin:calc(-93px*var(--u)) 0 0 calc(-93px*var(--u));
  border-radius:50%;
  border:calc(5px*var(--u)) solid rgba(240,248,255,.85);
  background:
    radial-gradient(circle at 34% 24%, rgba(255,255,255,.48), rgba(255,255,255,0) 40%),
    linear-gradient(180deg,#a9c8e4 0%,#82abd0 32%,#5b88b4 70%,#4a76a2 100%);
  box-shadow:0 0 0 calc(2px*var(--u)) rgba(6,14,26,.22),
             0 calc(9px*var(--u)) calc(20px*var(--u)) rgba(0,0,0,.45),
             inset 0 calc(-11px*var(--u)) calc(18px*var(--u)) rgba(20,50,88,.42),
             inset 0 calc(5px*var(--u)) calc(8px*var(--u)) rgba(255,255,255,.55);
  display:flex; align-items:center; justify-content:center;
  transition:transform .05s linear; }
.cs-stick .pad svg { width:90%; height:90%; }

/* ============================================================ ACTION BUTTONS */
.cs-btn { position:absolute; border-radius:50%; pointer-events:auto; touch-action:none;
  display:flex; align-items:center; justify-content:center;
  -webkit-user-select:none; user-select:none; cursor:pointer;
  transition:transform .09s cubic-bezier(.3,1.6,.5,1), opacity .3s ease;
  filter:drop-shadow(0 calc(7px*var(--u)) calc(14px*var(--u)) rgba(0,0,0,.5)); }
.cs-btn .disc { position:absolute; inset:0; border-radius:50%;
  background:
    radial-gradient(circle at 42% 26%, rgba(255,255,255,.17), rgba(255,255,255,0) 58%),
    linear-gradient(180deg, rgba(16,26,22,.24) 0%, rgba(10,17,14,.44) 44%, rgba(26,44,32,.34) 100%);
  box-shadow:inset 0 0 0 calc(3px*var(--u)) rgba(0,0,0,.42),
             inset 0 calc(-16px*var(--u)) calc(26px*var(--u)) rgba(0,0,0,.34); }
.cs-btn .rim { position:absolute; inset:0; border-radius:50%;
  border:calc(8px*var(--u)) solid var(--c);
  box-shadow:0 0 calc(18px*var(--u)) var(--cg), inset 0 0 calc(10px*var(--u)) rgba(255,255,255,.34); }
.cs-btn .rim::after { content:''; position:absolute; inset:calc(-3px*var(--u)); border-radius:50%;
  border:calc(2px*var(--u)) solid rgba(255,255,255,.30); }
/* charge arc rides OUTSIDE the coloured rim so it never eats the button identity */
.cs-btn .arc { position:absolute; inset:calc(-14px*var(--u)); border-radius:50%;
  background:conic-gradient(from -90deg, #fff4c2 0deg, #ffd75e calc(var(--p,0)*360deg), rgba(0,0,0,0) 0);
  -webkit-mask:radial-gradient(closest-side, rgba(0,0,0,0) 88%, #000 90%);
  mask:radial-gradient(closest-side, rgba(0,0,0,0) 88%, #000 90%);
  filter:drop-shadow(0 0 calc(8px*var(--u)) rgba(255,206,90,.8));
  opacity:0; transition:opacity .12s ease; }
.cs-btn.charging .arc { opacity:1; }
.cs-btn .cd { position:absolute; inset:calc(9px*var(--u)); border-radius:50%;
  background:conic-gradient(from -90deg, rgba(2,6,12,.62) calc(var(--cp,0)*360deg), rgba(0,0,0,0) 0);
  opacity:0; }
.cs-btn.cooling .cd { opacity:1; }
.cs-btn.cooling .lbl { opacity:.5; }
.cs-btn .lbl { position:relative; font-weight:900; color:#fff; letter-spacing:.015em;
  -webkit-text-stroke:calc(5px*var(--u)) rgba(4,10,20,.75); paint-order:stroke fill;
  text-shadow:0 calc(3px*var(--u)) calc(6px*var(--u)) rgba(0,0,0,.9);
  transform:translateY(calc(-1px*var(--u))); white-space:nowrap; }
.cs-btn.down { transform:scale(.9); }
.cs-btn.down .disc { background:linear-gradient(180deg, rgba(40,70,54,.6), rgba(16,30,22,.72)); }
.cs-btn.down .rim { box-shadow:0 0 calc(30px*var(--u)) var(--c), inset 0 0 calc(14px*var(--u)) rgba(255,255,255,.6); }
.cs-btn.locked { opacity:.45; }

.cs-btn.primary { --c:var(--red); --cg:rgba(255,95,107,.5);
  width:calc(176px*var(--u)); height:calc(176px*var(--u));
  right:calc(49px*var(--u) + env(safe-area-inset-right, 0px));
  bottom:calc(341px*var(--u) + env(safe-area-inset-bottom, 0px)); }
.cs-btn.sprint  { --c:var(--grn); --cg:rgba(95,216,115,.45);
  width:calc(164px*var(--u)); height:calc(164px*var(--u));
  right:calc(113px*var(--u) + env(safe-area-inset-right, 0px));
  bottom:calc(103px*var(--u) + env(safe-area-inset-bottom, 0px)); }
.cs-btn.second  { --c:var(--cyn); --cg:rgba(63,203,232,.45);
  width:calc(156px*var(--u)); height:calc(156px*var(--u));
  right:calc(372px*var(--u) + env(safe-area-inset-right, 0px));
  bottom:calc(64px*var(--u) + env(safe-area-inset-bottom, 0px)); }

.cs-touch { transition:opacity .35s ease; }
.cs-touch.hidden, .cs-touch.cine { opacity:0; pointer-events:none; }

/* danger vignette — pulses at the screen edge when your goal is under threat */
.cs-danger { position:absolute; inset:0; pointer-events:none; opacity:0;
  transition:opacity .5s ease;
  box-shadow:inset 0 0 calc(180px*var(--u)) calc(30px*var(--u)) rgba(196,24,40,.55); }

/* ================================================================ SYS BUTTON */
.cs-sys { position:absolute; top:calc(18px*var(--u) + env(safe-area-inset-top, 0px));
  right:calc(20px*var(--u) + env(safe-area-inset-right, 0px));
  width:calc(56px*var(--u)); height:calc(56px*var(--u)); border-radius:calc(16px*var(--u));
  pointer-events:auto; cursor:pointer; display:flex; align-items:center; justify-content:center;
  gap:calc(7px*var(--u));
  background:linear-gradient(180deg,rgba(58,63,134,.85),rgba(20,24,62,.85));
  box-shadow:inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.28),
             inset 0 0 0 calc(2px*var(--u)) rgba(255,255,255,.14),
             0 calc(5px*var(--u)) calc(12px*var(--u)) rgba(0,0,0,.5); }
.cs-sys i { display:block; width:calc(7px*var(--u)); height:calc(22px*var(--u)); border-radius:calc(2px*var(--u));
  background:#eef5ff; box-shadow:0 calc(1px*var(--u)) calc(2px*var(--u)) rgba(0,0,0,.5); }
.cs-sys:hover { background:linear-gradient(180deg,rgba(78,84,168,.9),rgba(30,35,84,.9)); }

/* ================================================================== KEY HINT */
.cs-hint { position:absolute; left:50%; bottom:calc(16px*var(--u)); transform:translateX(-50%);
  display:flex; gap:calc(16px*var(--u)); align-items:center; opacity:0; transition:opacity .35s ease; }
.cs-hint.on { opacity:1; }
.cs-hint b { display:flex; align-items:center; gap:calc(7px*var(--u));
  font-size:calc(12px*var(--u)); letter-spacing:.18em; font-weight:900; color:rgba(226,240,255,.75);
  text-shadow:0 calc(2px*var(--u)) calc(4px*var(--u)) rgba(0,0,0,.8); }
.cs-hint kbd { font-family:inherit; font-size:calc(11px*var(--u)); letter-spacing:.06em;
  padding:calc(3px*var(--u)) calc(8px*var(--u)); border-radius:calc(5px*var(--u));
  background:rgba(255,255,255,.14); box-shadow:inset 0 0 0 calc(1.5px*var(--u)) rgba(255,255,255,.28);
  color:#fff; }

/* ==================================================================== MENUS = */
.cs-ov { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
  pointer-events:auto;
  background:radial-gradient(ellipse at 50% 42%, rgba(10,20,38,.62), rgba(3,6,14,.9) 78%); }
/* diagonal chevron corners — the promo-art language of the reference menus */
.cs-ov::before, .cs-ov::after { content:''; position:absolute; width:38vmax; height:38vmax;
  background:repeating-linear-gradient(135deg,
    rgba(52,132,214,.85) 0 calc(16px*var(--u)),
    rgba(28,86,160,.85) calc(16px*var(--u)) calc(30px*var(--u)),
    rgba(12,44,96,.0)  calc(30px*var(--u)) calc(52px*var(--u)));
  opacity:.42; pointer-events:none; }
.cs-ov::before { left:calc(-6vmax); top:calc(-6vmax);
  clip-path:polygon(0 0, 100% 0, 0 100%); }
.cs-ov::after { right:calc(-6vmax); bottom:calc(-6vmax);
  clip-path:polygon(100% 100%, 100% 0, 0 100%); }
.cs-ov.on { display:flex; animation:cs-fade .3s ease forwards; }
@keyframes cs-fade { from { opacity:0; } to { opacity:1; } }
.cs-card { position:relative; min-width:calc(560px*var(--u));
  padding:calc(40px*var(--u)) calc(56px*var(--u)) calc(38px*var(--u));
  text-align:center; border-radius:calc(22px*var(--u)); overflow:hidden;
  background:
    radial-gradient(ellipse at 50% -10%, rgba(120,150,235,.30), rgba(0,0,0,0) 62%),
    linear-gradient(180deg, rgba(44,52,112,.96), rgba(12,16,40,.98));
  box-shadow:0 calc(28px*var(--u)) calc(70px*var(--u)) rgba(0,0,0,.7),
             inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.22),
             inset 0 0 0 calc(2px*var(--u)) rgba(255,255,255,.10);
  animation:cs-rise .45s cubic-bezier(.16,1.1,.3,1) forwards; }
/* team-coloured accent bar across the top of every card */
.cs-card::before { content:''; position:absolute; left:0; right:0; top:0; height:calc(7px*var(--u));
  background:linear-gradient(90deg,var(--ca1) 0%,var(--ca1) 46%,#ffb52e 50%,var(--cb1) 54%,var(--cb1) 100%); }
@keyframes cs-rise { from { transform:translateY(calc(34px*var(--u))) scale(.94); opacity:0; } to { transform:none; opacity:1; } }
.cs-card .wm { width:calc(470px*var(--u)); height:calc(156px*var(--u)); margin:0 auto calc(4px*var(--u));
  display:block; object-fit:contain; }
.cs-card h2 { font-size:calc(50px*var(--u)); font-weight:900; color:#fff; letter-spacing:.05em;
  -webkit-text-stroke:calc(7px*var(--u)) rgba(6,12,26,.55); paint-order:stroke fill; }
.cs-card .sub { margin-top:calc(6px*var(--u)); font-size:calc(16px*var(--u)); font-weight:900;
  letter-spacing:.24em; color:#9fb2d8; }
.cs-card .vs { display:flex; align-items:center; justify-content:center; gap:calc(22px*var(--u));
  margin:calc(16px*var(--u)) 0 calc(6px*var(--u)); }
.cs-card .vs img { width:calc(92px*var(--u)); height:calc(92px*var(--u)); }
.cs-card .vs .k { font-size:calc(26px*var(--u)); font-weight:900; color:#fff; letter-spacing:.06em; }
.cs-card .vs .x { font-size:calc(20px*var(--u)); font-weight:900; color:#ffb52e; letter-spacing:.18em; }
.cs-card .result { display:flex; align-items:center; justify-content:center; gap:calc(36px*var(--u));
  margin:calc(18px*var(--u)) 0 calc(10px*var(--u)); }
.cs-card .result img { width:calc(104px*var(--u)); height:calc(104px*var(--u));
  filter:drop-shadow(0 calc(7px*var(--u)) calc(14px*var(--u)) rgba(0,0,0,.6)); transition:transform .3s ease; }
.cs-card .result img.win { transform:scale(1.16); }
.cs-card .result img.lose { opacity:.62; transform:scale(.88); }
.cs-card .bigscore { font-size:calc(78px*var(--u)); line-height:1;
  font-weight:900; color:#fff; letter-spacing:.06em;
  -webkit-text-stroke:calc(9px*var(--u)) rgba(6,12,26,.55); paint-order:stroke fill; }
.cs-actions { margin-top:calc(26px*var(--u)); display:flex; gap:calc(14px*var(--u)); justify-content:center; }
.cs-cta { pointer-events:auto; cursor:pointer; border:0;
  padding:calc(15px*var(--u)) calc(40px*var(--u)); border-radius:calc(13px*var(--u));
  font-family:inherit; font-size:calc(21px*var(--u)); font-weight:900; letter-spacing:.14em; color:#08210f;
  background:linear-gradient(180deg,#8bef9c,#39bf58 60%,#2a9c47);
  box-shadow:0 calc(6px*var(--u)) 0 #1d7434, 0 calc(12px*var(--u)) calc(20px*var(--u)) rgba(0,0,0,.5),
             inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.5);
  transition:transform .08s ease, box-shadow .08s ease; }
.cs-cta.ghost { color:#dce8ff;
  background:linear-gradient(180deg,rgba(90,104,170,.65),rgba(46,54,104,.7));
  box-shadow:0 calc(6px*var(--u)) 0 rgba(18,22,52,.9), 0 calc(12px*var(--u)) calc(20px*var(--u)) rgba(0,0,0,.45),
             inset 0 calc(2px*var(--u)) 0 rgba(255,255,255,.2); }
.cs-cta:active { transform:translateY(calc(5px*var(--u)));
  box-shadow:0 calc(1px*var(--u)) 0 #1d7434, 0 calc(4px*var(--u)) calc(10px*var(--u)) rgba(0,0,0,.5); }
.cs-cta.pulse { animation:cs-pulse 1.7s ease-in-out infinite; }
@keyframes cs-pulse {
  0%,100% { transform:scale(1); }
  50%     { transform:scale(1.045); }
}
.cs-tip { margin-top:calc(16px*var(--u)); font-size:calc(12px*var(--u)); letter-spacing:.2em;
  font-weight:900; color:rgba(190,208,240,.6); }

/* =================================================================== INTRO == */
.cs-intro { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
  background:
    radial-gradient(ellipse at 50% 50%, rgba(4,8,18,.72) 0%, rgba(4,8,18,.45) 46%, rgba(4,8,18,0) 74%),
    linear-gradient(180deg, rgba(4,8,18,0) 22%, rgba(4,8,18,.55) 50%, rgba(4,8,18,0) 78%); }
.cs-intro.on { display:flex; }
.cs-intro .side { display:flex; flex-direction:column; align-items:center; gap:calc(12px*var(--u)); }
.cs-intro .side img { width:calc(200px*var(--u)); height:calc(200px*var(--u));
  filter:drop-shadow(0 calc(12px*var(--u)) calc(24px*var(--u)) rgba(0,0,0,.7)); }
.cs-intro .side b { font-size:calc(46px*var(--u)); font-weight:900; color:#fff; letter-spacing:.1em;
  padding:calc(4px*var(--u)) calc(24px*var(--u)) calc(6px*var(--u)); transform:skewX(-9deg);
  -webkit-text-stroke:calc(6px*var(--u)) rgba(6,12,26,.6); paint-order:stroke fill; }
.cs-intro .l b { background:linear-gradient(180deg,var(--ca1),var(--ca2)); }
.cs-intro .r b { background:linear-gradient(180deg,var(--cb1),var(--cb2)); }
.cs-intro .l { animation:cs-inL .7s cubic-bezier(.16,1.1,.3,1) both; }
.cs-intro .r { animation:cs-inR .7s cubic-bezier(.16,1.1,.3,1) both; }
.cs-intro .vs { margin:0 calc(66px*var(--u)); font-size:calc(84px*var(--u)); font-weight:900;
  color:#ffb52e; letter-spacing:.02em; transform:skewX(-9deg);
  -webkit-text-stroke:calc(10px*var(--u)) rgba(6,12,26,.8); paint-order:stroke fill;
  animation:cs-vs .5s .28s cubic-bezier(.14,1.7,.34,1) both; }
@keyframes cs-inL { from { transform:translateX(calc(-360px*var(--u))); opacity:0; } to { transform:none; opacity:1; } }
@keyframes cs-inR { from { transform:translateX(calc(360px*var(--u)));  opacity:0; } to { transform:none; opacity:1; } }
@keyframes cs-vs  { from { transform:skewX(-9deg) scale(2.6); opacity:0; } to { transform:skewX(-9deg) scale(1); opacity:1; } }

/* very short viewports (landscape phones) pull the stick/buttons in a little */
@media (max-height:430px) {
  .cs-stick { bottom:calc(10px*var(--u)); }
  .cs-btn.primary { bottom:calc(300px*var(--u)); }
}
`;

// One arrow, pointing up; the other three are rotations of it. Keep it narrow
// enough that the four bases never touch, or the cluster reads as a solid diamond.
const ARROW_D = 'M50 11 L63 30 Q50 26.5 37 30 Z';
const ARROWS = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="csAg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3f618d"/><stop offset="1" stop-color="#1f3b5e"/>
    </linearGradient>
  </defs>
  <g fill="#ffffff" opacity=".45" transform="translate(0,2.6)">
    <path d="${ARROW_D}"/>
    <path d="${ARROW_D}" transform="rotate(90 50 50)"/>
    <path d="${ARROW_D}" transform="rotate(180 50 50)"/>
    <path d="${ARROW_D}" transform="rotate(270 50 50)"/>
  </g>
  <g fill="url(#csAg)" stroke="#22395a" stroke-width="2.4" stroke-linejoin="round">
    <path d="${ARROW_D}"/>
    <path d="${ARROW_D}" transform="rotate(90 50 50)"/>
    <path d="${ARROW_D}" transform="rotate(180 50 50)"/>
    <path d="${ARROW_D}" transform="rotate(270 50 50)"/>
  </g></svg>`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createHud(root) {
  if (!document.getElementById('cs-hud-style')) {
    const st = document.createElement('style');
    st.id = 'cs-hud-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const crestA = crestURL(0), crestB = crestURL(1);
  const ball = ballGlyphURL(64);
  const wm = wordmarkURL(900, 300);

  const el = document.createElement('div');
  el.id = 'cs-hud';
  el.className = 'cs-hud';
  el.innerHTML = `
    <div class="cs-top" id="cs-top">
      <div class="cs-board">
        <div class="cs-cap a"></div>
        <div class="cs-seg cs-side">
          <img class="cs-crest" id="cs-crest-a" src="${crestA}" alt="">
          <span class="ab" id="cs-name-a">RED</span>
        </div>
        <div class="cs-seg cs-mid">
          <div class="sc u"><span class="n" id="cs-a">0</span><span class="d">-</span><span class="n" id="cs-b">0</span></div>
        </div>
        <div class="cs-seg cs-side">
          <span class="ab" id="cs-name-b">BLU</span>
          <img class="cs-crest" id="cs-crest-b" src="${crestB}" alt="">
        </div>
        <div class="cs-cap b"></div>
      </div>
      <div class="cs-clock" id="cs-clock-w"><span class="u" id="cs-clock">3:00</span></div>
      <div class="cs-poss" id="cs-poss"><span class="dot"></span><span id="cs-poss-t">RED BALL</span></div>
    </div>

    <div class="cs-banner" id="cs-banner">
      <div class="glow"></div>
      <h1 id="cs-banner-t">GOAL!<span class="fill" id="cs-banner-f">GOAL!</span></h1>
      <p id="cs-banner-s"></p>
    </div>

    <div class="cs-l3" id="cs-l3">
      <div class="badge"><img id="cs-l3-crest" src="${crestA}" alt=""></div>
      <div class="body"><div class="t" id="cs-l3-t">GOAL</div><div class="s" id="cs-l3-s"></div></div>
    </div>

    <div class="cs-danger" id="cs-danger"></div>
    <div class="cs-toast" id="cs-toast"></div>

    <div class="cs-touch" id="cs-touch">
      <div class="cs-stick" id="cs-stick">
        <div class="ring"></div>
        <div class="ring2"></div>
        <div class="pad" id="cs-pad">${ARROWS}</div>
      </div>
      <div class="cs-btn primary" id="cs-b-primary" data-act="primary">
        <span class="disc"></span><span class="rim"></span><span class="cd"></span><span class="arc"></span>
        <span class="lbl">SHOOT</span>
      </div>
      <div class="cs-btn sprint" id="cs-b-sprint" data-act="sprint">
        <span class="disc"></span><span class="rim"></span><span class="cd"></span><span class="arc"></span>
        <span class="lbl">SPRINT</span>
      </div>
      <div class="cs-btn second" id="cs-b-second" data-act="second">
        <span class="disc"></span><span class="rim"></span><span class="cd"></span><span class="arc"></span>
        <span class="lbl">PASS</span>
      </div>
    </div>

    <div class="cs-hint" id="cs-hint">
      <b><kbd>WASD</kbd>MOVE</b><b><kbd>SPACE</kbd>SHOOT</b><b><kbd>SHIFT</kbd>SPRINT</b>
      <b><kbd>Q</kbd>SLIDE</b><b><kbd>E</kbd>SWITCH</b>
    </div>

    <div class="cs-sys" id="cs-sys" title="Pause"><i></i><i></i></div>

    <div class="cs-intro" id="cs-intro">
      <div class="side l"><img src="${crestA}" alt=""><b id="cs-in-a">RED</b></div>
      <div class="vs">VS</div>
      <div class="side r"><img src="${crestB}" alt=""><b id="cs-in-b">BLU</b></div>
    </div>

    <div class="cs-ov" id="cs-ov">
      <div class="cs-card" id="cs-card">
        <img class="wm" id="cs-wm" src="${wm}" alt="Canvas Soccer">
        <h2 id="cs-menu-t"></h2>
        <div class="sub" id="cs-menu-s"></div>
        <div class="result" id="cs-menu-result" style="display:none">
          <img id="cs-res-a" src="${crestA}" alt="">
          <div class="bigscore" id="cs-menu-score">0 - 0</div>
          <img id="cs-res-b" src="${crestB}" alt="">
        </div>
        <div class="vs" id="cs-menu-vs" style="display:none">
          <img src="${crestA}" alt=""><span class="k" id="cs-menu-ka">RED</span>
          <span class="x">VS</span>
          <span class="k" id="cs-menu-kb">BLU</span><img src="${crestB}" alt="">
        </div>
        <div class="cs-actions" id="cs-menu-acts"></div>
        <div class="cs-tip" id="cs-menu-tip"></div>
      </div>
    </div>
  `;
  root.appendChild(el);

  const $ = (id) => el.querySelector('#' + id);
  const hexs = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
  const shade = (n, f) => hexs(
    ((Math.round(((n >> 16) & 255) * f) << 16) |
     (Math.round(((n >> 8) & 255) * f) << 8) |
      Math.round((n & 255) * f)) >>> 0);

  el.style.setProperty('--ca1', hexs(TEAMS[0].kit));
  el.style.setProperty('--ca2', shade(TEAMS[0].kit, 0.55));
  el.style.setProperty('--cb1', hexs(TEAMS[1].kit));
  el.style.setProperty('--cb2', shade(TEAMS[1].kit, 0.55));
  $('cs-name-a').textContent = TEAMS[0].short || TEAMS[0].name;
  $('cs-name-b').textContent = TEAMS[1].short || TEAMS[1].name;
  $('cs-in-a').textContent = TEAMS[0].name;
  $('cs-in-b').textContent = TEAMS[1].name;
  $('cs-menu-ka').textContent = TEAMS[0].name;
  $('cs-menu-kb').textContent = TEAMS[1].name;

  const pad = $('cs-pad');
  const stick = $('cs-stick');
  const touchLayer = $('cs-touch');
  const bannerEl = $('cs-banner');
  const l3El = $('cs-l3');
  const ovEl = $('cs-ov');
  const introEl = $('cs-intro');
  const toastEl = $('cs-toast');
  const hintEl = $('cs-hint');
  const topEl = $('cs-top');
  const btns = {
    primary: $('cs-b-primary'),
    sprint: $('cs-b-sprint'),
    second: $('cs-b-second'),
  };

  // ---------------------------------------------------------------- scaling
  // One numeric unit drives every dimension. Sub-linear so a phone still gets
  // controls that are big enough to hit with a thumb.
  let U = 1;
  function rescale() {
    const w = el.clientWidth || window.innerWidth || 1920;
    const h = el.clientHeight || window.innerHeight || 1080;
    const m = Math.min(w / 1920, h / 1080);
    U = clamp(Math.pow(Math.max(0.001, m), 0.8), 0.40, 1.45);
    el.style.setProperty('--u', String(U));
    fitLabels();
  }
  function fitLabels() {
    for (const k in btns) {
      const b = btns[k];
      const lbl = b.querySelector('.lbl');
      const d = b.getBoundingClientRect().width || 160;
      const n = Math.max(3, (lbl.textContent || '').length);
      lbl.style.fontSize = Math.round(Math.min(d / (n * 0.92), d * 0.255)) + 'px';
      lbl.style.webkitTextStrokeWidth = Math.max(2, d * 0.028) + 'px';
    }
  }
  window.addEventListener('resize', rescale);
  window.addEventListener('orientationchange', rescale);
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(rescale).observe(el); } catch (e) { /* ignore */ }
  }
  rescale();

  // ---------------------------------------------------------------- events
  const listeners = {};
  function on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); return api; }
  function emit(name, a) {
    const l = listeners[name];
    if (!l) return;
    for (const f of l) { try { f(a); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------- input
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

  // Which physical device is driving. Touch controls fade out under keyboard or
  // gamepad and come straight back on the next pointer press.
  let device = 'touch';
  function setDevice(d) {
    if (d === device) return;
    device = d;
    const hide = d !== 'touch';
    touchLayer.classList.toggle('hidden', hide);
    hintEl.classList.toggle('on', d === 'key');
    emit('device', d);
  }

  // ---- virtual stick -------------------------------------------------------
  let stickId = null;
  const center = { x: 0, y: 0 };
  let radius = 79;

  function stickStart(e) {
    stickId = e.pointerId != null ? e.pointerId : 'mouse';
    const r = stick.getBoundingClientRect();
    // Drag from wherever the thumb lands, like the reference: the pad follows
    // the finger relative to the ring centre.
    center.x = r.left + r.width / 2;
    center.y = r.top + r.height / 2;
    radius = (r.width - pad.getBoundingClientRect().width) / 2 || r.width * 0.23;
    input.anyGesture = true;
    setDevice('touch');
    stickMove(e);
  }
  function stickMove(e) {
    if (stickId === null) return;
    let dx = e.clientX - center.x;
    let dy = e.clientY - center.y;
    const d = Math.hypot(dx, dy);
    const dead = radius * 0.10;
    if (d > radius) { dx = (dx / d) * radius; dy = (dy / d) * radius; }
    pad.style.transform = `translate(${dx}px, ${dy}px)`;
    if (d < dead) { input.move.x = 0; input.move.y = 0; }
    else { input.move.x = dx / radius; input.move.y = dy / radius; }
    if (e.preventDefault) e.preventDefault();
  }
  function stickEnd() {
    if (stickId === null) return;
    stickId = null;
    pad.style.transform = 'translate(0px, 0px)';
    input.move.x = 0; input.move.y = 0;
  }
  stick.addEventListener('pointerdown', (e) => {
    try { stick.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    stickStart(e);
  });
  stick.addEventListener('pointermove', stickMove);
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);
  stick.addEventListener('lostpointercapture', stickEnd);

  // ---- action buttons ------------------------------------------------------
  // Labels are contextual, exactly like the reference: with the ball you get
  // SHOOT/PASS, without it SLIDE/SWITCH.
  const LABELS = {
    attack: { primary: 'SHOOT', second: 'PASS' },
    defend: { primary: 'SLIDE', second: 'SWITCH' },
  };
  let labelMode = 'attack';
  function setLabels(mode) {
    if (mode === labelMode) return;
    labelMode = mode;
    btns.primary.querySelector('.lbl').textContent = LABELS[mode].primary;
    btns.second.querySelector('.lbl').textContent = LABELS[mode].second;
    fitLabels();
  }

  const cooldowns = { primary: 0, sprint: 0, second: 0 };
  const cooldownMax = { primary: 1.2, sprint: 0, second: 0.35 };
  function setCooldown(name, secs) {
    if (!(name in cooldowns)) return;
    cooldownMax[name] = secs;
    cooldowns[name] = secs;
  }

  function press(slot) {
    input.anyGesture = true;
    setDevice('touch');
    emit('press', slot);
    if (slot === 'sprint') { input.sprint = true; return; }
    if (slot === 'primary') {
      if (labelMode === 'attack') { input.shootHeld = true; }
      else if (cooldowns.primary <= 0) { input.slide = true; cooldowns.primary = cooldownMax.primary || 1.2; }
      return;
    }
    if (slot === 'second') {
      input.passPressed = true;
      input.switchPressed = true;
      if (cooldowns.second <= 0) cooldowns.second = cooldownMax.second || 0.35;
    }
  }
  function release(slot) {
    if (slot === 'sprint') input.sprint = false;
    if (slot === 'primary' && labelMode === 'attack') input.shootHeld = false;
  }

  for (const k in btns) {
    const b = btns[k];
    const slot = k;
    b.addEventListener('pointerdown', (e) => {
      if (e.preventDefault) e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
      b.classList.add('down');
      press(slot);
    });
    const up = () => { b.classList.remove('down'); release(slot); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }

  // ---- keyboard ------------------------------------------------------------
  const keys = new Set();
  const TRACKED = new Set([' ', 'w', 'a', 's', 'd', 'q', 'e', 'shift',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  function onKey(e, down) {
    const k = (e.key || '').toLowerCase();
    if (down) { keys.add(k); input.anyGesture = true; setDevice('key'); } else keys.delete(k);
    if (TRACKED.has(k) && e.preventDefault) e.preventDefault();
    if (down && k === 'e') { input.switchPressed = true; input.passPressed = true; }
    if (down && k === 'q' && cooldowns.primary <= 0) {
      input.slide = true; cooldowns.primary = cooldownMax.primary || 1.2;
    }
    if (down && (k === 'escape' || k === 'p')) togglePause();
  }
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { keys.clear(); input.sprint = false; input.shootHeld = false; });
  window.addEventListener('pointerdown', () => { input.anyGesture = true; setDevice('touch'); }, true);

  // ---- gamepad -------------------------------------------------------------
  let padPrev = [];
  function pollGamepad() {
    let gp = null;
    try {
      const list = navigator.getGamepads ? navigator.getGamepads() : null;
      if (list) for (const g of list) if (g && g.connected) { gp = g; break; }
    } catch (e) { return false; }
    if (!gp) return false;
    const ax = gp.axes || [];
    const bt = gp.buttons || [];
    const gx = ax[0] || 0, gy = ax[1] || 0;
    const mag = Math.hypot(gx, gy);
    const bp = (i) => !!(bt[i] && bt[i].pressed);
    const active = mag > 0.18 || bp(0) || bp(1) || bp(2) || bp(3) || bp(6) || bp(7);
    if (active) setDevice('gamepad');
    if (device !== 'gamepad') return false;
    input.move.x = mag > 0.18 ? gx : 0;
    input.move.y = mag > 0.18 ? gy : 0;
    input.sprint = bp(7) || bp(1);
    input.shootHeld = bp(0);
    if (bp(2) && !padPrev[2]) { input.passPressed = true; input.switchPressed = true; }
    if (bp(3) && !padPrev[3] && cooldowns.primary <= 0) {
      input.slide = true; cooldowns.primary = cooldownMax.primary || 1.2;
    }
    padPrev = bt.map((b) => !!(b && b.pressed));
    return true;
  }

  // ---- per-frame input resolution -----------------------------------------
  function pollKeys(dt) {
    const gp = pollGamepad();
    if (gp) return;
    if (device !== 'key') {
      // touch: the stick/buttons already wrote into `input`
      if (stickId === null && device === 'touch') { /* leave move at rest */ }
      return;
    }
    let x = 0, y = 0;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    if (keys.has('w') || keys.has('arrowup')) y -= 1;
    if (keys.has('s') || keys.has('arrowdown')) y += 1;
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    input.move.x = x; input.move.y = y;
    input.sprint = keys.has('shift');
    input.shootHeld = keys.has(' ');
  }

  function resolveCharge(dt) {
    if (input.shootHeld) input.shootCharge = Math.min(1, input.shootCharge + dt * 1.6);
    else input.shootCharge = Math.max(0, input.shootCharge - dt * 6);
    const b = btns.primary;
    // the arc is a shot-power meter; it has no meaning while the button is SLIDE
    b.classList.toggle('charging', labelMode === 'attack' && input.shootCharge > 0.02);
    b.style.setProperty('--p', input.shootCharge.toFixed(3));
  }

  function tickCooldowns(dt) {
    for (const k in cooldowns) {
      const b = btns[k];
      if (cooldowns[k] > 0) {
        cooldowns[k] = Math.max(0, cooldowns[k] - dt);
        const p = cooldownMax[k] ? cooldowns[k] / cooldownMax[k] : 0;
        b.classList.add('cooling');
        b.style.setProperty('--cp', p.toFixed(3));
        if (cooldowns[k] <= 0) b.classList.remove('cooling');
      }
    }
  }

  // ---------------------------------------------------------------- display
  let scoreA = 0, scoreB = 0;
  let clockShown = '';
  let bannerTimer = 0, l3Timer = 0, toastTimer = 0, introTimer = 0;
  let pendingTally = -1;
  let boardShown = false;

  function showBoard(v) {
    if (v === boardShown) return;
    boardShown = v;
    topEl.classList.toggle('on', v);
  }
  showBoard(true);

  function popScore(node) {
    node.classList.remove('pop');
    // force reflow so the animation restarts
    void node.offsetWidth;
    node.classList.add('pop');
    setTimeout(() => node.classList.remove('pop'), 320);
  }

  function setScore(a, b) {
    a = a | 0; b = b | 0;
    if (a !== scoreA) { scoreA = a; $('cs-a').textContent = a; popScore($('cs-a')); }
    if (b !== scoreB) { scoreB = b; $('cs-b').textContent = b; popScore($('cs-b')); }
    $('cs-a').textContent = a; $('cs-b').textContent = b;
    $('cs-menu-score').textContent = `${a} - ${b}`;
  }

  function setClock(t) {
    const s = Math.max(0, Math.ceil(t));
    const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (txt !== clockShown) { clockShown = txt; $('cs-clock').textContent = txt; }
    $('cs-clock-w').classList.toggle('live', s > 0);
  }

  function setPossession(team) {
    const p = $('cs-poss');
    if (team == null || team < 0) { p.style.opacity = 0; return; }
    p.style.opacity = 1;
    const t = TEAMS[team];
    $('cs-poss-t').textContent = `${t.name} BALL`;
    p.style.color = team === 0 ? '#ff9aa2' : '#9ab8ff';
    setLabels(team === 0 ? 'attack' : 'defend');
  }

  function banner(text, sub = '', seconds = 2.4) {
    if (!text) {
      bannerEl.classList.remove('on');
      l3El.classList.remove('on');
      touchLayer.classList.remove('cine');
      bannerTimer = 0; l3Timer = 0; pendingTally = -1;
      return;
    }
    const t = String(text);
    $('cs-banner-t').firstChild.nodeValue = t;
    $('cs-banner-f').textContent = t;
    $('cs-banner-s').textContent = sub || '';
    bannerEl.classList.remove('on');
    void bannerEl.offsetWidth;
    bannerEl.classList.add('on');
    bannerTimer = seconds;

    // Goal announcements also drive the broadcast lower third, and pull the touch
    // controls out of the way — you are not steering anyone during a celebration.
    if (/goal/i.test(t) && sub) {
      touchLayer.classList.add('cine');
      const teamIdx = sub.indexOf(TEAMS[1].name) === 0 ? 1 : 0;
      $('cs-l3-crest').src = teamIdx === 1 ? crestB : crestA;
      $('cs-l3-t').textContent = sub;
      // main.js announces the goal BEFORE it pushes the new score, so the tally is
      // resolved on the next update() instead of right now — otherwise every goal
      // reads one behind.
      pendingTally = teamIdx;
      $('cs-l3-s').textContent = '';
      l3El.classList.add('on');
      l3Timer = seconds + 0.6;
    }
  }

  function toast(text, seconds = 1.8) {
    if (!text) { toastEl.classList.remove('on'); toastTimer = 0; return; }
    toastEl.textContent = text;
    toastEl.classList.add('on');
    toastTimer = seconds;
  }

  function intro(seconds = 2.6) {
    introEl.classList.remove('on');
    void introEl.offsetWidth;
    introEl.classList.add('on');
    introTimer = seconds;
  }

  // ---------------------------------------------------------------- menus
  let menuKind = null;
  let mainMenuDone = false;

  function cta(label, cls, fn) {
    const b = document.createElement('button');
    b.className = 'cs-cta' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function setPaused(v) {
    try {
      if (window.__debug && typeof window.__debug.pause === 'function') window.__debug.pause(!!v);
    } catch (e) { /* ignore */ }
    emit(v ? 'pause' : 'resume');
  }

  function togglePause() {
    if (menuKind === 'pause') showMenu(null);
    else if (!menuKind) showMenu('pause');
  }

  // Result row: both crests either side of the score, winner scaled up.
  function showResult() {
    $('cs-menu-result').style.display = 'flex';
    const a = $('cs-res-a'), b = $('cs-res-b');
    a.className = scoreA > scoreB ? 'win' : scoreA < scoreB ? 'lose' : '';
    b.className = scoreB > scoreA ? 'win' : scoreB < scoreA ? 'lose' : '';
  }

  function showMenu(kind, title, sub) {
    const acts = $('cs-menu-acts');
    acts.innerHTML = '';
    $('cs-menu-result').style.display = 'none';
    $('cs-menu-vs').style.display = 'none';
    $('cs-wm').style.display = 'none';
    $('cs-menu-tip').textContent = '';

    if (!kind) {
      if (menuKind === 'pause') setPaused(false);
      menuKind = null;
      ovEl.classList.remove('on');
      return;
    }
    menuKind = kind;

    if (kind === 'main') {
      $('cs-wm').style.display = 'block';
      $('cs-menu-t').textContent = '';
      $('cs-menu-t').style.display = 'none';
      $('cs-menu-s').textContent = title || 'EXHIBITION MATCH';
      $('cs-menu-vs').style.display = 'flex';
      acts.appendChild(cta('KICK OFF', 'pulse', () => { mainMenuDone = true; showMenu(null); emit('start'); }));
      $('cs-menu-tip').textContent = 'DRAG THE STICK TO MOVE  ·  TAP SHOOT TO STRIKE';
    } else {
      $('cs-menu-t').style.display = '';
      $('cs-menu-t').textContent = title || (
        kind === 'pause' ? 'PAUSED' : kind === 'half' ? 'HALF TIME' : 'FULL TIME');
      $('cs-menu-s').textContent = sub || '';
      if (kind === 'pause') {
        setPaused(true);
        acts.appendChild(cta('RESUME', '', () => showMenu(null)));
        acts.appendChild(cta('RESTART', 'ghost', () => { showMenu(null); emit('restart'); }));
      } else if (kind === 'half') {
        showResult();
        acts.appendChild(cta('SECOND HALF', 'pulse', () => { showMenu(null); emit('resume'); }));
      } else {
        showResult();
        acts.appendChild(cta('REMATCH', 'pulse', () => { showMenu(null); emit('restart'); }));
        acts.appendChild(cta('MENU', 'ghost', () => { mainMenuDone = false; showMenu('main'); }));
      }
    }
    ovEl.classList.remove('on');
    void ovEl.offsetWidth;
    ovEl.classList.add('on');
  }

  ovEl.addEventListener('pointerdown', () => {
    if (menuKind === 'main') { mainMenuDone = true; showMenu(null); emit('start'); }
    else if (menuKind === 'pause') showMenu(null);
  });
  $('cs-sys').addEventListener('pointerdown', (e) => { e.stopPropagation(); togglePause(); });

  // The main menu is shown one frame after boot so main.js's initial staged
  // scenario (which clears menus) cannot race it. Any scenario() call after that
  // clears it again, which is exactly what the capture harness wants.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!mainMenuDone && !menuKind) showMenu('main');
  }));

  // ---------------------------------------------------------------- update
  function update(dt) {
    if (!(dt > 0)) dt = 0;
    if (pendingTally >= 0) {
      const n = pendingTally === 0 ? scoreA : scoreB;
      $('cs-l3-s').textContent = `${n} GOAL${n === 1 ? '' : 'S'} THIS MATCH`;
      pendingTally = -1;
    }
    pollKeys(dt);
    resolveCharge(dt);
    tickCooldowns(dt);

    if (bannerTimer > 0) { bannerTimer -= dt; if (bannerTimer <= 0) bannerEl.classList.remove('on'); }
    if (l3Timer > 0) {
      l3Timer -= dt;
      if (l3Timer <= 0) { l3El.classList.remove('on'); touchLayer.classList.remove('cine'); }
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) toastEl.classList.remove('on'); }
    if (introTimer > 0) { introTimer -= dt; if (introTimer <= 0) introEl.classList.remove('on'); }
  }

  function setVisible(v) { el.style.display = v ? '' : 'none'; }

  // 0..1 — how threatened the player's goal is. Drives an edge vignette; the
  // matching crowd swell lives in audio.js (`audio.setDanger`).
  const dangerEl = $('cs-danger');
  let dangerShown = -1;
  function setDanger(x) {
    const v = clamp(x || 0, 0, 1);
    if (Math.abs(v - dangerShown) < 0.03) return;
    dangerShown = v;
    dangerEl.style.opacity = (v * v * 0.85).toFixed(3);
  }

  const api = {
    el, input,
    setScore, setClock, setPossession, banner, showMenu, update, setVisible,
    intro, toast, setCooldown, setLabels, setDanger, on,
    get device() { return device; },
    get unit() { return U; },
    dispose() { el.remove(); },
  };
  return api;
}
