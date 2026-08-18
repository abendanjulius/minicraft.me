// touch.js — mobile joystick, look, tap-to-place / hold-to-mine, action pad
// Split out of ui.js so inventory UI and touch input stay independent.

import * as UI from './ui.js';
import { isInputLocked } from './player.js';

const $ = id => document.getElementById(id);
const invIsOpen = () => UI.invOpen;

export function initTouch(hooks){
  const joy = UI.joy;
  const toggleInv = (...a) => UI.toggleInv(...a);
  document.body.classList.add('touch');
  $('touchUI').style.display = 'block';
  const joyBase = $('joyBase'), joyStick = $('joyStick');
  let joyId = null, joyCX = 0, joyCY = 0, lookId = null, lookX = 0, lookY = 0;

  $('joyZone').addEventListener('touchstart', e=>{
    if(isInputLocked()) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    joyId = t.identifier; joyCX = t.clientX; joyCY = t.clientY;
    joyBase.style.display = joyStick.style.display = 'block';
    joyBase.style.left = (joyCX-55)+'px'; joyBase.style.top = (joyCY-55)+'px';
    joyStick.style.left = (joyCX-24)+'px'; joyStick.style.top = (joyCY-24)+'px';
  }, {passive:false});
  document.addEventListener('touchmove', e=>{
    for(const t of e.changedTouches){
      if(t.identifier===joyId){
        let dx = t.clientX-joyCX, dy = t.clientY-joyCY;
        const len = Math.hypot(dx,dy), max = 45;
        if(len>max){ dx*=max/len; dy*=max/len; }
        joy.x = dx/max; joy.y = dy/max;
        joyStick.style.left = (joyCX+dx-24)+'px'; joyStick.style.top = (joyCY+dy-24)+'px';
      } else if(t.identifier===lookId){
        hooks.look((t.clientX-lookX)*.004, (t.clientY-lookY)*.004);
        lookX = t.clientX; lookY = t.clientY;
      }
    }
  }, {passive:false});
  const clearTouchIds = e=>{
    for(const t of e.changedTouches){
      if(t.identifier===joyId){ joyId=null; joy.x=joy.y=0; joyBase.style.display=joyStick.style.display='none'; }
      if(t.identifier===lookId) lookId=null;
    }
  };
  document.addEventListener('touchend', clearTouchIds);
  document.addEventListener('touchcancel', clearTouchIds);
  // ========== Crosshair dig/place (Minecraft PE style) ==========
  // Aim with crosshair. Short tap = place. Hold = mine.
  // Looking is allowed on the same finger; only large early drag cancels a pending hold.
  let digId = null, digX = 0, digY = 0, digOriginX = 0, digOriginY = 0, digStart = 0, digMaxMove = 0;
  let digMining = false, digTimer = null;
  // Touch-to-place: you tap the block you want, so there is no crosshair.
  // A drag is looking and NEVER places, however it ends. TAP_SLOP is finger
  // jitter only — past it the gesture is a look, permanently.
  const HOLD_MS = 450;
  const TAP_SLOP = 12;     // px — beyond this the gesture is a drag, not a tap
  const MINE_CANCEL = 36;  // px — drag this much before HOLD cancels pending mine start
  $('crosshair')?.style.setProperty('display', 'none', 'important');

  function digClear(stopMine){
    if(digTimer){ clearTimeout(digTimer); digTimer = null; }
    if(stopMine && digMining){ hooks.mine(false); digMining = false; }
    digId = null;
  }

  function isUiTouch(x, y){
    const el = document.elementFromPoint(x, y);
    if(!el || !el.closest) return false;
    return !!el.closest('#hotbar,#joyZone,.tbtn,#btnChat,#btnQuit,#btnMode,#compass,#inv,#pauseMenu,#chatBox');
  }

  // Prefer the canvas; fall back to #game
  const digSurface = document.querySelector('#game canvas') || $('game');

  digSurface.addEventListener('touchstart', e=>{
    if(invIsOpen() || !hooks || isInputLocked()) return;
    // only primary finger for dig
    const t = e.changedTouches[0];
    if(isUiTouch(t.clientX, t.clientY)) return;
    // Keep clear of the joystick, but no further: isUiTouch already rejects
    // #joyZone and the rest of the HUD, and a 38% dead strip made most of a
    // landscape phone unable to place at all.
    if(t.clientX < innerWidth * 0.22) return;

    e.preventDefault();
    // Always claim this finger as the look finger. Makes the system self-healing
    // if a previous lookId was left stranded by a missed touchcancel/touchend.
    lookId = t.identifier; lookX = t.clientX; lookY = t.clientY;

    // Immediate combat: if the finger landed on a mob/animal, punch right away
    // (desktop does this on left mousedown). Don't start a dig timer for a punch.
    if(hooks.punch?.(t.clientX, t.clientY)){
      digId = null;
      return;
    }

    digId = t.identifier;
    digX = t.clientX; digY = t.clientY;
    digOriginX = t.clientX; digOriginY = t.clientY; // fixed origin for cancel threshold
    digStart = performance.now();
    digMaxMove = 0;
    digMining = false;
    if(digTimer) clearTimeout(digTimer);
    digTimer = setTimeout(()=>{
      digTimer = null;
      if(digId == null || invIsOpen()) return;
      if(digMaxMove > MINE_CANCEL) return; // was looking around
      digMining = true;
      // Use CURRENT finger pixel — digX/Y are updated on touchmove. The old
      // code froze the touchstart pixel while look still rotated the camera,
      // so the ray no longer matched what the finger was over.
      hooks.mine(true, digX, digY);
    }, HOLD_MS);
  }, {passive:false});

  document.addEventListener('touchmove', e=>{
    if(digId == null) return;
    for(const t of e.changedTouches){
      if(t.identifier !== digId) continue;
      // Track movement from the original touch for cancel/place thresholds
      const d = Math.hypot(t.clientX - digOriginX, t.clientY - digOriginY);
      if(d > digMaxMove) digMaxMove = d;
      if(!digMining && digMaxMove > MINE_CANCEL && digTimer){
        clearTimeout(digTimer); digTimer = null;
      }
      // Always keep digX/Y on the live finger so mine aim stays under it
      digX = t.clientX; digY = t.clientY;
      if(digMining) hooks.mineAim?.(digX, digY);
    }
  }, {passive:true});

  const endDig = e=>{
    if(digId == null) return;
    for(const t of e.changedTouches){
      if(t.identifier !== digId) continue;
      const held = performance.now() - digStart;
      const wasMining = digMining;
      const move = digMaxMove;
      if(digTimer){ clearTimeout(digTimer); digTimer = null; }
      if(digMining){ hooks.mine(false); digMining = false; }
      digId = null;

      // PLACE only on a clean tap — at the pixel that was tapped. Any drag past
      // TAP_SLOP was a look, so it never places no matter how it ended.
      if(!wasMining && !invIsOpen() && held < HOLD_MS && move < TAP_SLOP){
        const tx = t.clientX, ty = t.clientY;
        requestAnimationFrame(()=> hooks.place?.(tx, ty));
      }
    }
  };
  document.addEventListener('touchend', endDig);
  document.addEventListener('touchcancel', endDig);

  function bindPress(el, onStart, onEnd){
    if(!el) return;
    const down = e=>{ e.preventDefault(); e.stopPropagation(); el.classList.add('pressed'); onStart?.(e); };
    const up = e=>{ el.classList.remove('pressed'); onEnd?.(e); };
    el.addEventListener('touchstart', down, {passive:false});
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
  }
  bindPress($('btnJump'), ()=>hooks.jump(true), ()=>hooks.jump(false));
  // No mine/place buttons: you tap the block you want, and hold to dig it.
  const bm = $('btnMine'); if(bm) bm.style.display = 'none';
  const bp = $('btnPlace'); if(bp) bp.style.display = 'none';
  $('btnDrop')?.addEventListener('touchstart', e=>{ e.preventDefault(); hooks.drop?.(); });
  bindPress($('btnSprint'), ()=>hooks.sprint?.(true), ()=>hooks.sprint?.(false));
  bindPress($('btnDrop'), ()=>hooks.drop?.(), null);
  const bf = $('btnFly');
  if(bf){
    bf.addEventListener('touchstart', e=>{
      e.preventDefault(); e.stopPropagation();
      bf.classList.add('pressed');
      const on = hooks.fly?.();
      // Ensure toggle class even if player path missed it
      if(on === true) bf.classList.add('active');
      else if(on === false) bf.classList.remove('active');
      setTimeout(()=> bf.classList.remove('pressed'), 150);
    });
    bf.addEventListener('touchend', ()=> bf.classList.remove('pressed'));
    bf.addEventListener('touchcancel', ()=> bf.classList.remove('pressed'));
  }
  $('btnInv').addEventListener('touchstart', e=>{ e.preventDefault(); toggleInv(); });
}

