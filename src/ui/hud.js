// HUD — scoreboard, clock, key legend, banners, menus (+ touch controls on touch
// devices only). Pure DOM over the canvas. No game logic: it renders match state
// it is told about and reports input state. Everything scales from a 1920x1080
// desktop down to a phone-sized viewport through numeric `--u`/`--lu` units set
// on resize.
//
//   createHud(root) -> {
//     setScore(a,b), setClock(t), setPossession(t), banner(text, sub, secs),
//     showMenu(kind, title, sub), update(dt), setVisible(v),
//     input, el,
//     // extras (additive, safe to ignore)
//     intro(), setDanger(x), setCooldown(name, secs), toast(text), on(evt, fn),
//     setLabels(mode), showControls(secs), device
//   }
//
// `input` is a live object the sim reads each step:
//   { move:{x,y}, sprint, slide, switchPressed, shootHeld, shootCharge,
//     passPressed, lobPressed, pressureHeld, anyGesture, consume() }
//
// One-shots (slide, switchPressed, passPressed, lobPressed) are latched until
// `consume()` takes them; `pressureHeld` is a 0..1 LEVEL that persists for as
// long as the key is down, so consume() must not clear it.
//
// PLATFORM
// This game is played on a computer. Keyboard and gamepad are the primary
// controls and the only ones ever built by default: the virtual stick and the
// round action buttons are a TOUCH-ONLY affordance that is not created, styled,
// listened to or ticked unless the device actually has a coarse pointer (or the
// user produces a real `touchstart`). On desktop the whole touch subtree simply
// does not exist, so it costs nothing per frame.

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
  --u:1; --lu:1; --red:#ff5f6b; --grn:#5fd873; --cyn:#3fcbe8; --amb:#ffb52e;
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

/* ============================================================== KEY LEGEND = */
/* The desktop control affordance. Same voice as the scoreboard: dark translucent
   panel, hairline inner border, crisp white type, one accent colour for headings.
   The --lu unit is --u with a higher floor, so the legend stays readable in a
   small window while the broadcast furniture keeps shrinking. */
.cs-key { display:inline-flex; align-items:center; justify-content:center;
  min-width:calc(27px*var(--lu)); height:calc(25px*var(--lu));
  padding:0 calc(8px*var(--lu)); border-radius:calc(6px*var(--lu));
  font-size:calc(11px*var(--lu)); font-weight:900; letter-spacing:.08em; line-height:1;
  color:#f3f7ff; white-space:nowrap;
  background:linear-gradient(180deg,#525b9c 0%,#3a4179 46%,#262c5e 100%);
  box-shadow:inset 0 calc(1.5px*var(--lu)) 0 rgba(255,255,255,.34),
             inset 0 0 0 calc(1.4px*var(--lu)) rgba(255,255,255,.15),
             0 calc(2.5px*var(--lu)) 0 rgba(7,10,26,.9),
             0 calc(5px*var(--lu)) calc(8px*var(--lu)) rgba(0,0,0,.45);
  text-shadow:0 calc(1px*var(--lu)) calc(2px*var(--lu)) rgba(0,0,0,.75); }

.cs-keys { position:absolute;
  left:calc(24px*var(--lu) + env(safe-area-inset-left, 0px));
  bottom:calc(24px*var(--lu) + env(safe-area-inset-bottom, 0px));
  padding:calc(13px*var(--lu)) calc(18px*var(--lu)) calc(13px*var(--lu));
  border-radius:calc(13px*var(--lu));
  background:linear-gradient(180deg, rgba(13,18,40,.80) 0%, rgba(5,8,20,.87) 100%);
  box-shadow:inset 0 0 0 calc(1.5px*var(--lu)) rgba(255,255,255,.13),
             inset 0 calc(1.5px*var(--lu)) 0 rgba(255,255,255,.17),
             0 calc(12px*var(--lu)) calc(30px*var(--lu)) rgba(0,0,0,.55);
  pointer-events:none; opacity:0;
  transform:translateY(calc(12px*var(--lu))) scale(.985);
  transition:opacity .38s ease, transform .42s cubic-bezier(.16,1.05,.3,1); }
.cs-keys.on { opacity:1; transform:none; }
/* the accent hairline mirrors the menu card's team bar */
.cs-keys::before { content:''; position:absolute; left:calc(18px*var(--lu)); right:calc(18px*var(--lu));
  top:0; height:calc(2px*var(--lu)); border-radius:calc(2px*var(--lu));
  background:linear-gradient(90deg, rgba(143,216,255,0), #8fd8ff 40%, rgba(143,216,255,.25) 100%); }

.cs-keys .hd { display:flex; align-items:center; justify-content:space-between;
  gap:calc(22px*var(--lu)); margin-bottom:calc(11px*var(--lu));
  padding-bottom:calc(9px*var(--lu));
  border-bottom:calc(1.5px*var(--lu)) solid rgba(255,255,255,.10); }
.cs-keys .hd b { font-size:calc(11px*var(--lu)); letter-spacing:.3em; font-weight:900; color:#8fd8ff;
  text-shadow:0 calc(2px*var(--lu)) calc(5px*var(--lu)) rgba(0,0,0,.8); }
.cs-keys .hd em { font-style:normal; display:flex; align-items:center; gap:calc(7px*var(--lu));
  font-size:calc(9.5px*var(--lu)); letter-spacing:.2em; font-weight:900;
  color:rgba(186,204,238,.5); }
.cs-keys .hd em .cs-key { min-width:calc(21px*var(--lu)); height:calc(21px*var(--lu));
  padding:0 calc(6px*var(--lu)); font-size:calc(9.5px*var(--lu)); }
/* Two of the keys mean different things with and without the ball, so the legend
   says which half of the game you are in. ATTACKING / DEFENDING are the same
   length on purpose — the chip never changes width. */
.cs-keys .hd .md { font-size:calc(9.5px*var(--lu)); letter-spacing:.22em; font-weight:900;
  padding:calc(3px*var(--lu)) calc(9px*var(--lu)) calc(4px*var(--lu));
  border-radius:calc(5px*var(--lu)); color:#d7f0ff;
  background:rgba(143,216,255,.14);
  box-shadow:inset 0 0 0 calc(1.4px*var(--lu)) rgba(143,216,255,.34);
  text-shadow:0 calc(2px*var(--lu)) calc(4px*var(--lu)) rgba(0,0,0,.7); }
.cs-keys .hd .md.def { color:#ffdda8; background:rgba(255,181,46,.14);
  box-shadow:inset 0 0 0 calc(1.4px*var(--lu)) rgba(255,181,46,.36); }

.cs-keys .bd { display:flex; align-items:center; justify-content:center;
  gap:calc(20px*var(--lu)); }
.cs-keys .mv { display:flex; flex-direction:column; align-items:center; gap:calc(8px*var(--lu)); }
.cs-keys .mv .g { display:grid; grid-template-columns:repeat(3, auto); gap:calc(4px*var(--lu));
  justify-items:center; }
.cs-keys .mv .g.one { grid-template-columns:auto; }
/* the movement cluster is the control you use every frame — give it the weight */
.cs-keys .mv .cs-key { min-width:calc(31px*var(--lu)); height:calc(29px*var(--lu));
  font-size:calc(12.5px*var(--lu)); }
.cs-keys .lb { display:flex; flex-direction:column; align-items:center; gap:calc(3px*var(--lu));
  font-size:calc(9.5px*var(--lu)); letter-spacing:.26em; font-weight:900;
  color:rgba(200,216,244,.62); }
.cs-keys .lb i { font-style:normal; letter-spacing:.2em; color:rgba(178,196,232,.42); }
.cs-keys .sep { width:calc(1.5px*var(--lu)); align-self:stretch;
  background:linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,.13) 22%,
                                     rgba(255,255,255,.13) 78%, rgba(255,255,255,0)); }
.cs-keys .rows { display:grid; grid-template-columns:auto auto;
  gap:calc(6px*var(--lu)) calc(13px*var(--lu)); align-items:center; }
.cs-keys .rows .a { font-size:calc(11px*var(--lu)); letter-spacing:.2em; font-weight:900;
  color:rgba(228,240,255,.88);
  /* the contextual rows swap PASS<->SWITCH as possession turns over: reserve the
     width of the widest label so the panel does not breathe on every turnover */
  min-width:calc(112px*var(--lu));
  text-shadow:0 calc(2px*var(--lu)) calc(4px*var(--lu)) rgba(0,0,0,.75); }
/* second line under an action — the hold variant of a key that does two things */
.cs-keys .rows .a i { display:block; font-style:normal; font-weight:900;
  margin-top:calc(2px*var(--lu)); font-size:calc(8.5px*var(--lu)); letter-spacing:.18em;
  color:rgba(178,196,232,.5); text-shadow:none; }
.cs-keys .ft { margin-top:calc(11px*var(--lu)); padding-top:calc(9px*var(--lu));
  border-top:calc(1.5px*var(--lu)) solid rgba(255,255,255,.08);
  font-size:calc(9.5px*var(--lu)); letter-spacing:.2em; font-weight:900;
  color:rgba(180,198,234,.5); }

/* recall chip — what is left behind once the legend has faded out */
.cs-recall { position:absolute;
  left:calc(24px*var(--lu) + env(safe-area-inset-left, 0px));
  bottom:calc(24px*var(--lu) + env(safe-area-inset-bottom, 0px));
  display:flex; align-items:center; gap:calc(8px*var(--lu));
  padding:calc(5px*var(--lu)) calc(13px*var(--lu)) calc(6px*var(--lu)) calc(6px*var(--lu));
  border-radius:calc(22px*var(--lu)); background:rgba(6,10,22,.5);
  box-shadow:inset 0 0 0 calc(1.5px*var(--lu)) rgba(255,255,255,.13);
  font-size:calc(10px*var(--lu)); letter-spacing:.24em; font-weight:900;
  color:rgba(214,230,252,.72);
  text-shadow:0 calc(2px*var(--lu)) calc(4px*var(--lu)) rgba(0,0,0,.85);
  opacity:0; pointer-events:none; cursor:pointer; transition:opacity .35s ease; }
.cs-recall.on { opacity:.7; pointer-events:auto; }
.cs-recall:hover { opacity:1; }
.cs-recall .cs-key { min-width:calc(21px*var(--lu)); height:calc(21px*var(--lu));
  padding:0 calc(6px*var(--lu)); font-size:calc(9.5px*var(--lu)); }

/* short viewports: drop the footnote line before anything starts colliding */
@media (max-height:560px) { .cs-keys .ft { display:none; } }
@media (max-width:620px)  { .cs-keys .ft { display:none; } }

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
.cs-tip:empty { display:none; }

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
`;

// ---------------------------------------------------------------------------
// Touch-only styles. Injected by ensureTouch(), never on a desktop page.
// ---------------------------------------------------------------------------
const TOUCH_CSS = `
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

const TOUCH_HTML = `
  <div class="cs-stick" data-el="stick">
    <div class="ring"></div>
    <div class="ring2"></div>
    <div class="pad" data-el="pad">${ARROWS}</div>
  </div>
  <div class="cs-btn primary" data-el="primary">
    <span class="disc"></span><span class="rim"></span><span class="cd"></span><span class="arc"></span>
    <span class="lbl">SHOOT</span>
  </div>
  <div class="cs-btn sprint" data-el="sprint">
    <span class="disc"></span><span class="rim"></span><span class="cd"></span><span class="arc"></span>
    <span class="lbl">SPRINT</span>
  </div>
  <div class="cs-btn second" data-el="second">
    <span class="disc"></span><span class="rim"></span><span class="cd"></span><span class="arc"></span>
    <span class="lbl">PASS</span>
  </div>
`;

// ---------------------------------------------------------------------------
// The legend is data, not markup, so the keyboard and gamepad variants stay in
// lockstep with the bindings below and with each other.
//   move.caps.length === 4 -> arrow-cluster shape; otherwise a single wide cap.
//
// Two of the action keys are CONTEXTUAL — they do one thing with the ball and a
// different thing without it — so each device has an `attack` and a `defend`
// row set, keyed by the same `labelMode` the bindings switch on. A static list
// would have to lie about half of them.
//   row = [cap, action] or [cap, action, sub-line]
// ---------------------------------------------------------------------------
const LEGEND = {
  key: {
    title: 'CONTROLS',
    recall: 'H',
    move: { caps: ['↑', '←', '↓', '→'], label: 'MOVE', note: 'ARROW KEYS' },
    modes: {
      attack: {
        rows: [
          ['D', 'SHOOT'],
          ['S', 'PASS'],
          ['A', 'LOB'],
          ['SHIFT', 'SPRINT'],
        ],
        foot: 'HOLD D TO POWER THE SHOT  ·  ESC TO PAUSE',
      },
      defend: {
        rows: [
          ['D', 'SHOOT'],
          ['S', 'SWITCH', 'HOLD: PRESSURE'],
          ['A', 'TACKLE'],
          ['SHIFT', 'SPRINT'],
        ],
        foot: 'TAP S TO SWITCH  ·  HOLD S TO CLOSE HIM DOWN  ·  ESC TO PAUSE',
      },
    },
  },
  gamepad: {
    title: 'GAMEPAD',
    recall: 'H',
    move: { caps: ['L STICK'], label: 'MOVE', note: 'OR D-PAD' },
    modes: {
      attack: {
        rows: [
          ['A', 'SHOOT'],
          ['X', 'PASS'],
          ['B', 'LOB'],
          ['RT', 'SPRINT'],
        ],
        foot: 'HOLD A TO POWER THE SHOT  ·  START TO PAUSE',
      },
      defend: {
        rows: [
          ['A', 'SHOOT'],
          ['X', 'SWITCH', 'HOLD: PRESSURE'],
          ['B', 'TACKLE'],
          ['RT', 'SPRINT'],
        ],
        foot: 'TAP X TO SWITCH  ·  HOLD X TO CLOSE HIM DOWN  ·  START TO PAUSE',
      },
    },
  },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** True only for devices whose *primary* pointer is a finger. */
function coarsePointer() {
  try {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  } catch (e) { return false; }
}

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

    <div class="cs-keys" id="cs-keys"></div>
    <div class="cs-recall" id="cs-recall"></div>

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

  const bannerEl = $('cs-banner');
  const l3El = $('cs-l3');
  const ovEl = $('cs-ov');
  const introEl = $('cs-intro');
  const toastEl = $('cs-toast');
  const keysEl = $('cs-keys');
  const recallEl = $('cs-recall');
  const topEl = $('cs-top');

  // Touch controls live here once (and only once) they are actually needed.
  // `null` on every desktop: no DOM, no listeners, no per-frame work.
  let touch = null;

  // ---------------------------------------------------------------- scaling
  // One numeric unit drives the broadcast furniture. Sub-linear so a phone still
  // gets controls that are big enough to hit with a thumb. `--lu` is the same
  // number with a higher floor: the key legend must stay legible in a small
  // window instead of shrinking into unreadable specks.
  let U = 1;
  function rescale() {
    const w = el.clientWidth || window.innerWidth || 1920;
    const h = el.clientHeight || window.innerHeight || 1080;
    const m = Math.min(w / 1920, h / 1080);
    U = clamp(Math.pow(Math.max(0.001, m), 0.8), 0.40, 1.45);
    el.style.setProperty('--u', String(U));
    el.style.setProperty('--lu', String(clamp(U, 0.66, 1.12)));
    fitLabels();
  }
  function fitLabels() {
    if (!touch) return;
    for (const k in touch.btns) {
      const b = touch.btns[k];
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
    lobPressed: false,
    // 0..1 — how hard the player is leaning on the man in possession. A LEVEL,
    // not an event: it ramps while the key is held and decays when it is let go,
    // and consume() deliberately leaves it alone.
    pressureHeld: 0,
    anyGesture: false,
    consume() {
      const s = {
        slide: this.slide,
        switchPressed: this.switchPressed,
        passPressed: this.passPressed,
        lobPressed: this.lobPressed,
      };
      this.slide = false; this.switchPressed = false;
      this.passPressed = false; this.lobPressed = false;
      return s;
    },
  };

  const cooldowns = { primary: 0, sprint: 0, second: 0 };
  const cooldownMax = { primary: 1.2, sprint: 0, second: 0.35 };
  function setCooldown(name, secs) {
    if (!(name in cooldowns)) return;
    cooldownMax[name] = secs;
    cooldowns[name] = secs;
  }

  // `labelMode` is THE attacking/defending context — for the touch labels, for the
  // key legend, and (most importantly) for what S and A actually do. The host sets
  // it from possession every step; everything contextual reads it and nothing else.
  const LABELS = {
    attack: { primary: 'SHOOT', second: 'PASS' },
    defend: { primary: 'TACKLE', second: 'SWITCH' },
  };
  let labelMode = 'attack';
  let legendDirty = false;
  function setLabels(mode) {
    if (mode !== 'attack' && mode !== 'defend') return;
    if (mode === labelMode) return;
    labelMode = mode;
    // The legend is contextual too. Repainting it here would run twice in a frame
    // if two callers disagree, so flag it and let update() do the one DOM write.
    legendDirty = true;
    if (!touch) return;
    touch.btns.primary.querySelector('.lbl').textContent = LABELS[mode].primary;
    touch.btns.second.querySelector('.lbl').textContent = LABELS[mode].second;
    fitLabels();
  }

  // Which physical device is driving. `key` is the desktop default — the sim must
  // respond to WASD on the very first frame, without waiting for a keypress to
  // "prove" there is a keyboard.
  let device = coarsePointer() ? 'touch' : 'key';

  // ---------------------------------------------------------------- key legend
  // Declared up here (rather than beside showMenu) because syncLegend runs during
  // construction and has to be able to see whether a menu owns the screen.
  let menuKind = null;
  let mainMenuDone = false;

  let legendMode = 'key';       // which LEGEND variant is rendered
  let legendOn = false;         // wants to be visible
  let legendPinned = false;     // user pressed H to open it — no auto-hide
  let legendDismissed = false;  // user pressed H to close it — never auto-arm again
  let legendTimer = 0;          // seconds until auto-hide (0 = never)
  let cine = false;             // celebration: everything interactive gets out of the way

  function renderLegend() {
    legendDirty = false;
    const L = LEGEND[legendMode] || LEGEND.key;
    const M = L.modes[labelMode] || L.modes.attack;
    const cap = (t) => `<span class="cs-key">${t}</span>`;
    const mv = L.move.caps.length === 4
      ? `<div class="g"><i></i>${cap(L.move.caps[0])}<i></i>` +
        `${cap(L.move.caps[1])}${cap(L.move.caps[2])}${cap(L.move.caps[3])}</div>`
      : `<div class="g one">${L.move.caps.map(cap).join('')}</div>`;
    const rows = M.rows
      .map(([k, a, sub]) =>
        `${cap(k)}<span class="a">${a}${sub ? `<i>${sub}</i>` : ''}</span>`)
      .join('');
    const chip = labelMode === 'attack' ? 'ATTACKING' : 'DEFENDING';
    keysEl.innerHTML =
      `<div class="hd"><b>${L.title}</b>` +
        `<span class="md${labelMode === 'attack' ? '' : ' def'}">${chip}</span>` +
        `<em>${cap(L.recall)}<span>HIDE</span></em></div>` +
      `<div class="bd">` +
        `<div class="mv">${mv}` +
          `<span class="lb">${L.move.label}<i>${L.move.note}</i></span></div>` +
        `<div class="sep"></div>` +
        `<div class="rows">${rows}</div>` +
      `</div>` +
      `<div class="ft">${M.foot}</div>`;
    recallEl.innerHTML = `<span class="cs-key">${L.recall}</span><span>CONTROLS</span>`;
  }

  function syncLegend() {
    // Touch players get the stick, not a keyboard poster. Menus and goal
    // celebrations own the screen outright.
    const blocked = device === 'touch' || !!menuKind || cine;
    keysEl.classList.toggle('on', legendOn && !blocked);
    recallEl.classList.toggle('on', !legendOn && !blocked);
  }

  /** Show the legend. `secs > 0` auto-hides after that long; 0 pins it open. */
  function showControls(secs = 0) {
    legendOn = true;
    legendTimer = secs > 0 ? secs : 0;
    syncLegend();
  }
  function hideControls() {
    legendOn = false;
    legendTimer = 0;
    syncLegend();
  }
  function toggleControls() {
    if (legendOn) { legendPinned = false; legendDismissed = true; hideControls(); }
    else { legendPinned = true; legendDismissed = false; showControls(0); }
  }
  renderLegend();
  showControls(9);
  recallEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); toggleControls(); });

  function controlTip() {
    if (device === 'touch') return 'DRAG THE STICK TO MOVE  ·  TAP SHOOT TO STRIKE';
    if (device === 'gamepad') return 'LEFT STICK TO MOVE  ·  A TO SHOOT  ·  X TO PASS';
    return 'ARROWS TO MOVE  ·  D SHOOT  ·  S PASS  ·  A LOB  ·  H FOR CONTROLS';
  }

  function setCine(v) {
    if (v === cine) return;
    cine = v;
    if (touch) touch.layer.classList.toggle('cine', v);
    syncLegend();
  }

  function setDevice(d) {
    // Never fall back to touch on a machine that has no touch controls built.
    if (d === 'touch' && !touch) return;
    if (d === device) return;
    device = d;
    if (touch) touch.layer.classList.toggle('hidden', d !== 'touch');
    if (d === 'gamepad' && legendMode !== 'gamepad') {
      legendMode = 'gamepad';
      renderLegend();
      if (!legendPinned) showControls(6);
    } else if (d === 'key' && legendMode !== 'key') {
      legendMode = 'key';
      renderLegend();
    }
    syncLegend();
    emit('device', d);
  }

  // ---------------------------------------------------------------- touch UI
  // Built lazily. Everything below this line is dead weight on a desktop and is
  // never constructed there.
  function ensureTouch() {
    if (touch) return touch;
    if (!document.getElementById('cs-hud-touch-style')) {
      const st = document.createElement('style');
      st.id = 'cs-hud-touch-style';
      st.textContent = TOUCH_CSS;
      document.head.appendChild(st);
    }
    const layer = document.createElement('div');
    layer.className = 'cs-touch';
    layer.id = 'cs-touch';
    layer.innerHTML = TOUCH_HTML;
    el.insertBefore(layer, keysEl);      // menus and overlays still paint above

    const q = (n) => layer.querySelector(`[data-el="${n}"]`);
    const stick = q('stick');
    const pad = q('pad');
    const btns = { primary: q('primary'), sprint: q('sprint'), second: q('second') };
    touch = { layer, stick, pad, btns };

    // ---- virtual stick -----------------------------------------------------
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

    // ---- action buttons ----------------------------------------------------
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

    // paint the current state into the freshly built widgets
    btns.primary.querySelector('.lbl').textContent = LABELS[labelMode].primary;
    btns.second.querySelector('.lbl').textContent = LABELS[labelMode].second;
    layer.classList.toggle('cine', cine);
    layer.classList.toggle('hidden', device !== 'touch');
    fitLabels();
    syncLegend();
    return touch;
  }

  // ---------------------------------------------------------------- intents
  // S (keyboard) / X (pad) / the second touch button are ONE control with three
  // jobs, so the rules live here once instead of in three copies:
  //
  //   attacking                     press           -> PASS
  //   defending, tapped             press + release -> SWITCH
  //   defending, held past HOLD_S                   -> PRESSURE (a 0..1 level)
  //
  // The role is decided at press time and never revisited, so a turnover in the
  // middle of a hold cannot turn a pass into a switch on the way back up, and a
  // hold never fires the tap action when it is released.
  const HOLD_S = 0.18;            // seconds; under this the press counted as a tap
  const second = { down: false, at: 0, role: null };
  const nowMs = () => ((typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now());

  function secondPress() {
    if (second.down) return;                  // key auto-repeat, or a second device
    second.down = true;
    second.at = nowMs();
    second.role = labelMode === 'attack' ? 'pass' : 'defend';
    if (second.role === 'pass') input.passPressed = true;
  }
  function secondRelease() {
    if (!second.down) return;
    const held = (nowMs() - second.at) / 1000;
    if (second.role === 'defend' && held < HOLD_S) input.switchPressed = true;
    second.down = false;
    second.role = null;
  }
  function secondCancel() {
    second.down = false;
    second.role = null;
    input.pressureHeld = 0;
  }
  /** A (keyboard) / B (pad) / the first touch button off the ball. */
  function primaryAction() {
    if (labelMode === 'attack') { input.lobPressed = true; return; }
    if (cooldowns.primary <= 0) {
      input.slide = true;
      cooldowns.primary = cooldownMax.primary || 1.2;
    }
  }
  /** Ramp the pressure level — every frame, whichever device is driving. */
  function tickPressure(dt) {
    const on = second.down && second.role === 'defend' && labelMode !== 'attack'
      && (nowMs() - second.at) / 1000 >= HOLD_S;
    if (on) input.pressureHeld = Math.min(1, input.pressureHeld + dt * 4.5);
    else input.pressureHeld = Math.max(0, input.pressureHeld - dt * 9);
  }

  function press(slot) {
    input.anyGesture = true;
    setDevice('touch');
    emit('press', slot);
    if (slot === 'sprint') { input.sprint = true; return; }
    if (slot === 'primary') {
      if (labelMode === 'attack') { input.shootHeld = true; }
      else primaryAction();
      return;
    }
    if (slot === 'second') {
      secondPress();
      if (cooldowns.second <= 0) cooldowns.second = cooldownMax.second || 0.35;
    }
  }
  function release(slot) {
    if (slot === 'sprint') input.sprint = false;
    if (slot === 'primary' && labelMode === 'attack') input.shootHeld = false;
    if (slot === 'second') secondRelease();
  }

  // Phones and tablets get the touch layer up front. Hybrids (a laptop with a
  // touchscreen) report a fine primary pointer, so they only get it if and when
  // a real finger lands on the glass.
  if (coarsePointer()) ensureTouch();
  else {
    const onFirstTouch = () => {
      window.removeEventListener('touchstart', onFirstTouch, true);
      ensureTouch();
      setDevice('touch');
    };
    try {
      window.addEventListener('touchstart', onFirstTouch, { capture: true, passive: true });
    } catch (e) {
      window.addEventListener('touchstart', onFirstTouch, true);
    }
  }

  // ---- keyboard ------------------------------------------------------------
  // The desktop binding set — the classic PC football layout: the left hand plays
  // the game, the right hand steers. A, S and D are ACTIONS, which is why moving
  // is on the arrows alone; there is no WASD anywhere in here on purpose, so
  // holding A to lob can never also drag you left.
  //
  //                       ATTACKING            DEFENDING
  //   ARROWS   move       -                    -
  //   D        shoot      shoot (hold=power)   shoot (hold=power)
  //   S        second     pass                 tap: switch / hold: pressure
  //   A        primary    lob                  slide tackle
  //   SHIFT    sprint     H controls           ESC/P pause
  //
  // SPACE stays live as a second shoot key: it collides with nothing and every
  // player tries it once.
  const keys = new Set();
  const TRACKED = new Set([' ', 'a', 's', 'd', 'h', 'shift',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  function onKey(e, down) {
    const k = (e.key || '').toLowerCase();
    if (down) { keys.add(k); input.anyGesture = true; setDevice('key'); } else keys.delete(k);
    if (TRACKED.has(k) && e.preventDefault) e.preventDefault();
    // S: pass with the ball; without it, tap to switch and hold to press.
    if (k === 's') {
      if (!down) secondRelease();
      else if (!e.repeat) secondPress();
      return;
    }
    // A: lob with the ball, slide tackle without it. Auto-repeat must not
    // machine-gun either of them.
    if (k === 'a') {
      if (down && !e.repeat) primaryAction();
      return;
    }
    if (down && k === 'h' && !e.repeat) toggleControls();
    if (down && (k === 'escape' || k === 'p')) togglePause();
  }
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => {
    keys.clear();
    input.sprint = false;
    input.shootHeld = false;
    // A held key that is released off-window never sends its keyup: drop the hold
    // rather than leaving the player leaning on an opponent forever.
    secondCancel();
  });
  window.addEventListener('pointerdown', (e) => {
    input.anyGesture = true;
    // A mouse click must not hand control back to a touch layer that a hybrid
    // device happens to have built — only an actual finger does that.
    const t = e && e.pointerType;
    if (!t || t === 'touch' || t === 'pen') setDevice('touch');
  }, true);

  // ---- gamepad -------------------------------------------------------------
  // Standard Gamepad API mapping, one-for-one with the keyboard so the two never
  // disagree. Polled only once a pad has announced itself, so a keyboard-only
  // machine never pays for navigator.getGamepads() per frame.
  //   left stick / d-pad  move        A  shoot   (= D)
  //   RT / LT / LB        sprint      X  second  (= S: pass / switch / pressure)
  //   START               pause       B  primary (= A: lob / slide tackle)
  // Y is deliberately unbound: switching lives on X, exactly as it does on S.
  const PAD_DZ = 0.22;
  let padCount = 0;
  let padPrev = [];
  window.addEventListener('gamepadconnected', () => { padCount++; });
  window.addEventListener('gamepaddisconnected', () => {
    padCount = Math.max(0, padCount - 1);
    if (!padCount && device === 'gamepad') setDevice(touch ? 'touch' : 'key');
  });

  function pollGamepad() {
    if (!padCount) return false;
    let gp = null;
    try {
      const list = navigator.getGamepads ? navigator.getGamepads() : null;
      if (list) for (const g of list) if (g && g.connected) { gp = g; break; }
    } catch (e) { return false; }
    if (!gp) return false;
    const ax = gp.axes || [];
    const bt = gp.buttons || [];
    const bp = (i) => !!(bt[i] && bt[i].pressed);

    // radial deadzone, rescaled so the first millimetre past it is a slow walk
    let gx = ax[0] || 0, gy = ax[1] || 0;
    let mag = Math.hypot(gx, gy);
    if (mag > PAD_DZ) {
      const s = Math.min(1, (mag - PAD_DZ) / (0.95 - PAD_DZ)) / mag;
      gx *= s; gy *= s; mag = Math.hypot(gx, gy);
    } else { gx = 0; gy = 0; mag = 0; }
    // d-pad overrides an idle stick
    if (mag === 0) {
      const dx = (bp(15) ? 1 : 0) - (bp(14) ? 1 : 0);
      const dy = (bp(13) ? 1 : 0) - (bp(12) ? 1 : 0);
      if (dx || dy) {
        const l = Math.hypot(dx, dy) || 1;
        gx = dx / l; gy = dy / l; mag = 1;
      }
    }

    const active = mag > 0 || bp(0) || bp(1) || bp(2) || bp(3) || bp(6) || bp(7) || bp(9);
    if (active) setDevice('gamepad');
    if (device !== 'gamepad') return false;

    input.move.x = gx;
    input.move.y = gy;
    input.sprint = bp(7) || bp(6) || bp(5);
    input.shootHeld = bp(0);
    if (bp(2) && !padPrev[2]) secondPress();
    if (!bp(2) && padPrev[2]) secondRelease();
    if (bp(1) && !padPrev[1]) primaryAction();
    if (bp(9) && !padPrev[9]) togglePause();
    padPrev = bt.map((b) => !!(b && b.pressed));
    return true;
  }

  // ---- per-frame input resolution -----------------------------------------
  function pollKeys(dt) {
    if (pollGamepad()) return;
    // touch: the stick and buttons already wrote straight into `input`
    if (device === 'touch') return;
    // Arrows only. A/S/D are actions now, and a key that both steers and acts is
    // the one thing this layout cannot have.
    let x = 0, y = 0;
    if (keys.has('arrowleft')) x -= 1;
    if (keys.has('arrowright')) x += 1;
    if (keys.has('arrowup')) y -= 1;
    if (keys.has('arrowdown')) y += 1;
    const d = Math.hypot(x, y);
    if (d > 1) { x /= d; y /= d; }
    input.move.x = x; input.move.y = y;
    input.sprint = keys.has('shift');
    input.shootHeld = keys.has('d') || keys.has(' ');
  }

  function resolveCharge(dt) {
    if (input.shootHeld) input.shootCharge = Math.min(1, input.shootCharge + dt * 1.6);
    else input.shootCharge = Math.max(0, input.shootCharge - dt * 6);
    if (!touch) return;
    const b = touch.btns.primary;
    // the arc is a shot-power meter; it has no meaning while the button is SLIDE
    b.classList.toggle('charging', labelMode === 'attack' && input.shootCharge > 0.02);
    b.style.setProperty('--p', input.shootCharge.toFixed(3));
  }

  function tickCooldowns(dt) {
    for (const k in cooldowns) {
      if (cooldowns[k] <= 0) continue;
      cooldowns[k] = Math.max(0, cooldowns[k] - dt);
      if (!touch) continue;                       // the timer still gates the action
      const b = touch.btns[k];
      const p = cooldownMax[k] ? cooldowns[k] / cooldownMax[k] : 0;
      b.classList.add('cooling');
      b.style.setProperty('--cp', p.toFixed(3));
      if (cooldowns[k] <= 0) b.classList.remove('cooling');
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
      setCine(false);
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

    // Goal announcements also drive the broadcast lower third, and pull the
    // controls out of the way — you are not steering anyone during a celebration.
    if (/goal/i.test(t) && sub) {
      setCine(true);
      const teamIdx = sub.indexOf(TEAMS[1].name) === 0 ? 1 : 0;
      $('cs-l3-crest').src = teamIdx === 1 ? crestB : crestA;
      $('cs-l3-t').textContent = sub;
      // main.js announces the goal BEFORE it pushes the new score, so the tally is
      // resolved on the next update() instead of right now — otherwise every goal
      // reads one behind.
      pendingTally = teamIdx;
      const n0 = teamIdx === 0 ? scoreA : scoreB;
      $('cs-l3-s').textContent = `${n0} GOAL${n0 === 1 ? '' : 'S'} THIS MATCH`;
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
  function cta(label, cls, fn) {
    const b = document.createElement('button');
    b.className = 'cs-cta' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function setPaused(v) {
    const evt = v ? 'pause' : 'resume';
    // Prefer the owner's hook. Routing gameplay through the debug harness is only
    // a fallback for a host that never wired hud.on('pause'|'resume').
    const wired = (listeners.pause && listeners.pause.length)
      || (listeners.resume && listeners.resume.length);
    if (!wired) {
      try {
        if (window.__debug && typeof window.__debug.pause === 'function') window.__debug.pause(!!v);
      } catch (e) { /* ignore */ }
    }
    emit(evt, v);
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
      // Back to the match: put the legend up for a few seconds so the controls
      // are the first thing you read at kickoff, then let it get out of the way.
      // Someone who has already waved it off with H does not get it back.
      if (!legendPinned && !legendDismissed) showControls(9);
      syncLegend();
      return;
    }
    menuKind = kind;
    syncLegend();

    if (kind === 'main') {
      $('cs-wm').style.display = 'block';
      $('cs-menu-t').textContent = '';
      $('cs-menu-t').style.display = 'none';
      $('cs-menu-s').textContent = title || 'EXHIBITION MATCH';
      $('cs-menu-vs').style.display = 'flex';
      acts.appendChild(cta('KICK OFF', 'pulse', () => { mainMenuDone = true; showMenu(null); emit('start'); }));
      $('cs-menu-tip').textContent = controlTip();
    } else {
      $('cs-menu-t').style.display = '';
      $('cs-menu-t').textContent = title || (
        kind === 'pause' ? 'PAUSED' : kind === 'half' ? 'HALF TIME' : 'FULL TIME');
      $('cs-menu-s').textContent = sub || '';
      if (kind === 'pause') {
        setPaused(true);
        acts.appendChild(cta('RESUME', '', () => showMenu(null)));
        acts.appendChild(cta('RESTART', 'ghost', () => { showMenu(null); emit('restart'); }));
        $('cs-menu-tip').textContent = controlTip();
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
    tickPressure(dt);
    resolveCharge(dt);
    tickCooldowns(dt);
    // one DOM write per frame at most, however many callers moved the context
    if (legendDirty) renderLegend();

    // The auto-hide countdown only runs while the legend is actually on screen,
    // so a long stint in a menu does not eat the seconds it is meant to be read in.
    if (legendTimer > 0 && !menuKind && !cine && device !== 'touch') {
      legendTimer -= dt;
      if (legendTimer <= 0 && !legendPinned) hideControls();
    }
    if (bannerTimer > 0) { bannerTimer -= dt; if (bannerTimer <= 0) bannerEl.classList.remove('on'); }
    if (l3Timer > 0) {
      l3Timer -= dt;
      if (l3Timer <= 0) { l3El.classList.remove('on'); setCine(false); }
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
    showControls, hideControls,
    get device() { return device; },
    get unit() { return U; },
    dispose() { el.remove(); },
  };
  return api;
}
