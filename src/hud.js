// DOM heads-up display drawn in "pen" style (multiplied over the paper canvas).
import * as THREE from 'three';
import { clamp } from './util.js';

const _vTag = new THREE.Vector3(), _toTag = new THREE.Vector3(), _camFwd = new THREE.Vector3();

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="nametags" id="nametags"></div>
      <div class="scope" id="scope"><div class="mask"></div><div class="ring"></div><div class="cx"></div><div class="cy"></div><div class="dot"></div></div>
      <div class="focus-meter" id="focusmeter"><div class="fm-label">Katana</div><div class="fm-tube"><div class="fm-fill" id="fmfill"></div><i class="fm-f1"></i><i class="fm-f2"></i><i class="fm-f3"></i></div><div class="fm-ready" id="fmready">Corte listo</div></div>
      <div class="focus-mark" id="focusmark"><i></i><i></i><i></i><i></i></div>
      <div class="crosshair" id="crosshair"><i class="ch-t"></i><i class="ch-b"></i><i class="ch-l"></i><i class="ch-r"></i><i class="ch-dot"></i></div>
      <div class="grapple-ret" id="gret"></div><div class="gstam" id="gstam" hidden><i id="gstamfill"></i></div>
      <div class="hitmarker" id="hitmarker"><i></i><i></i></div>
      <div class="dmg-ind" id="dmg"></div>
      <div class="hud-tl"><div class="score">Puntos <b id="score">0</b></div><div class="combo" id="combo"></div></div>
      <div class="hud-tr"><div class="wave">Oleada <b id="wave">1</b></div><div class="modifier" id="modifier"></div><div class="left"><b id="left">0</b> enemigos restantes</div><div class="timer" id="timer"></div><div class="pvpscore" id="pvpscore" hidden></div></div><div class="board" id="board" hidden></div>
      <div class="tdm-header" id="tdmHeader" hidden><span class="team-blue">Equipo Azul: <b id="blueKills">0</b></span> <span class="divider">|</span> <span class="team-red">Equipo Rojo: <b id="redKills">0</b></span><div class="tdm-target" id="tdmTarget">Primero a 30 bajas</div></div>
      <div class="net-status" id="netStatus" hidden><span id="netStatusText"></span></div>
      <div class="bossbar" id="bossbar"><div class="bossname" id="bossname"></div><div class="bar big"><div class="fill red" id="bossfill"></div></div></div>
      <div class="hud-bl">
        <div class="health"><span>Salud</span><div class="bar"><div class="fill" id="hpfill"></div></div><span id="hpnum">100</span></div>
        <div class="ammo"><b id="mag">30</b><span id="reserve">/120</span><span class="reloading" id="reloading"></span><span class="nades" id="nades" title="Granadas"></span></div>
        <div class="tally" id="tally"></div>
      </div>
      <div class="hud-br"><div class="slots" id="slots"></div><div class="weapon" id="weapon">Fusil</div><div class="hint" id="hint"></div></div>
      <div class="tip" id="tip"></div>
      <div class="message"><div class="msg-main" id="msg"></div><div class="msg-sub" id="msgsub"></div></div>
      <div class="killfeed" id="killfeed"></div>
      <div class="screen" id="screen"><div class="panel" id="panel"></div></div>`;
    const q = (id) => root.querySelector('#' + id);
    this.el = { crosshair: q('crosshair'), gret: q('gret'), hitmarker: q('hitmarker'), dmg: q('dmg'), score: q('score'), combo: q('combo'), wave: q('wave'), modifier: q('modifier'), left: q('left'), timer: q('timer'), hpfill: q('hpfill'), hpnum: q('hpnum'), mag: q('mag'), reserve: q('reserve'), reloading: q('reloading'), tally: q('tally'), weapon: q('weapon'), hint: q('hint'), slots: q('slots'), tip: q('tip'), msg: q('msg'), msgsub: q('msgsub'), killfeed: q('killfeed'), screen: q('screen'), panel: q('panel'), nades: q('nades'), scope: q('scope'), focusmark: q('focusmark'), focusmeter: q('focusmeter'), fmfill: q('fmfill'), bossbar: q('bossbar'), bossname: q('bossname'), bossfill: q('bossfill'), pvpscore: q('pvpscore'), board: q('board'), gstam: q('gstam'), gstamfill: q('gstamfill'), tdmHeader: q('tdmHeader'), blueKills: q('blueKills'), redKills: q('redKills'), tdmTarget: q('tdmTarget'), netStatus: q('netStatus'), netStatusText: q('netStatusText'), nametags: q('nametags') };
    this._msgT = 0; this._scope = false; this._nades = -1; this._pad = false; this.onDevice = null; this._fmShow = false; this._fmFrac = -1; this._fmReady = false; this._lastTally = -1; this._lastSlots = ''; this._ads = false; this._mode = ''; this.onScreenClick = null; this._tipT = 0;
    this._nameTags = new Map();
    this.el.screen.addEventListener('click', () => { if (this.onScreenClick) this.onScreenClick(); });
  }
  // katana charge gauge: fills with katana kills, catches fire when a focus slash is ready
  setFocusMeter(show, frac, ready, label = 'Katana') {
    const m = this.el.focusmeter;
    if (show !== this._fmShow) { this._fmShow = show; m.classList.toggle('on', show); }
    if (!show) return;
    if (label !== this._fmLabel) { this._fmLabel = label; m.querySelector('.fm-label').textContent = label; }
    const f = Math.max(0, Math.min(1, frac));
    if (Math.abs(f - (this._fmFrac ?? -1)) > 0.005) { this._fmFrac = f; this.el.fmfill.style.height = (f * 100).toFixed(1) + '%'; }
    if (ready !== this._fmReady) { this._fmReady = ready; m.classList.toggle('ready', ready); }
  }
  setGrenades(n) { if (n === this._nades) return; this._nades = n; let h = ''; for (let i = 0; i < n; i++) h += '<i></i>'; this.el.nades.innerHTML = h; }
  // control labels follow whatever you touched last
  setDevice(pad) { if (pad === this._pad) return; this._pad = pad; this.root.classList.toggle('pad', pad); if (this.onDevice) this.onDevice(pad); }
  key(action) { return (this._pad ? PAD_KEYS : KB_KEYS)[action] || action; }
  setScope(on) { if (on === this._scope) return; this._scope = on; this.el.scope.classList.toggle('on', on); }
  setFocusMark(x, y) {
    const m = this.el.focusmark;
    if (x == null) { m.classList.remove('on'); return; }
    m.classList.add('on'); m.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }
  setSpread(px) { this.el.crosshair.style.setProperty('--s', px.toFixed(1) + 'px'); }
  setCrosshairMode(mode) { this._mode = mode; this._applyCross(); }
  setAds(on) { if (on === this._ads) return; this._ads = on; this._applyCross(); }
  _applyCross() { this.el.crosshair.className = 'crosshair ' + this._mode + (this._ads ? ' ads' : ''); }
  setGrappleStamina(f) { const show = f < 0.995; if (this.el.gstam.hidden === show) this.el.gstam.hidden = !show; if (show) { this.el.gstamfill.style.width = (f * 100).toFixed(0) + '%'; this.el.gstam.classList.toggle('low', f < 0.2); } }
  grappleTarget(state) { this.el.gret.className = 'grapple-ret' + (state === 1 ? ' on' : state === 2 ? ' on attached' : ''); }
  hitmarker(kill = false, crit = false) { const h = this.el.hitmarker; h.className = 'hitmarker' + (kill ? ' kill' : '') + (crit ? ' crit' : ''); void h.offsetWidth; h.classList.add('show'); }
  setAmmo(mag, reserve, magSize, reloading = false) {
    this.el.mag.textContent = mag; this.el.reserve.textContent = '/' + reserve; this.el.reloading.textContent = reloading ? ' Recargando…' : '';
    if (mag !== this._lastTally) { this._lastTally = mag; let s = ''; for (let i = 0; i < Math.min(mag, 40); i++) s += '<i></i>'; this.el.tally.innerHTML = s; }
  }
  setKatana() { this.el.mag.textContent = '∞'; this.el.reserve.textContent = ''; this.el.reloading.textContent = ''; if (this._lastTally !== -1) { this.el.tally.innerHTML = ''; this._lastTally = -1; } }
  setSlots(slots) {
    const key = slots.map((s) => `${s.name}|${s.active ? 1 : 0}|${s.ammo}`).join(';'); if (key === this._lastSlots) return; this._lastSlots = key;
    this.el.slots.innerHTML = slots.map((s, i) => `<div class="slot${s.active ? ' active' : ''}${s.empty ? ' empty' : ''}"><span class="num">${i + 1}</span>${s.name}<span class="sammo">${s.ammo}</span></div>`).join('');
  }
  setHealth(hp, max) { const f = Math.max(0, hp / max); this.el.hpfill.style.width = (f * 100).toFixed(1) + '%'; this.el.hpnum.textContent = Math.ceil(hp); this.root.classList.toggle('low', f < 0.3); }
  setPvpScore(html) { const on = !!html; this.el.pvpscore.hidden = !on; if (on) this.el.pvpscore.innerHTML = html; this.el.wave.parentElement.hidden = on; this.el.left.parentElement.hidden = on; }
  setBoard(html) { const on = !!html; this.el.board.hidden = !on; if (on) this.el.board.innerHTML = html; }
  setTdmScore(show, blueKills = 0, redKills = 0, target = 30) {
    this.el.tdmHeader.hidden = !show;
    if (show) {
      this.el.blueKills.textContent = blueKills;
      this.el.redKills.textContent = redKills;
      this.el.tdmTarget.textContent = `Primero a ${target} bajas`;
      this.el.wave.parentElement.hidden = true;
      this.el.left.parentElement.hidden = true;
    }
  }
  setNetState(status) {
    const show = !!status;
    this.el.netStatus.hidden = !show;
    if (show) this.el.netStatusText.textContent = status;
  }
  setWave(n, left) { this.el.wave.textContent = n; this.el.left.textContent = left; }
  setModifier(text) { this.el.modifier.textContent = text || ''; }
  setTimer(text) { this.el.timer.textContent = text || ''; }
  setScore(score, combo) { this.el.score.textContent = score; this.el.combo.textContent = combo > 1 ? 'Combo x' + combo : ''; }
  setWeapon(name, hint) { this.el.weapon.textContent = name; this.el.hint.textContent = hint || ''; }
  setBoss(name, frac) { if (frac == null) { this.el.bossbar.classList.remove('show'); return; } this.el.bossbar.classList.add('show'); this.el.bossname.textContent = name; this.el.bossfill.style.width = (Math.max(0, frac) * 100).toFixed(1) + '%'; }
  tip(text, dur = 5) { this.el.tip.innerHTML = text; this.el.tip.classList.add('show'); this._tipT = dur; }
  message(main, sub = '', dur = 2.2) { const m = this.el.msg; m.textContent = main; m.classList.remove('show'); void m.offsetWidth; m.classList.add('show'); this.el.msgsub.textContent = sub; this._msgT = dur; }
  kill(text, pts) {
    const d = document.createElement('div'); d.innerHTML = pts > 0 ? `${text} <span class="pts">+${pts}</span>` : text; this.el.killfeed.appendChild(d);
    setTimeout(() => d.remove(), 1700); while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove();
  }
  damageFrom(angle) { const i = document.createElement('i'); i.style.transform = `rotate(${(angle * 180 / Math.PI).toFixed(1)}deg)`; this.el.dmg.appendChild(i); setTimeout(() => i.remove(), 1000); }
  showScreen(html) { this.el.panel.innerHTML = html; this.el.screen.classList.add('show'); }
  hideScreen() { this.el.screen.classList.remove('show'); }
  setGameplayVisible(v) {
    this.root.classList.toggle('nogame', !v);
    if (!v) this.clearNametags();
  }
  updateNametags(remotes, camera, world, localPlayer) {
    if (!this.el.nametags) return;
    const activeIds = new Set();
    const w = window.innerWidth, h = window.innerHeight;
    const camPos = camera.position;
    camera.getWorldDirection(_camFwd);

    for (const [id, rp] of remotes) {
      if (!rp || !rp.alive || rp.away || !rp.root || !rp.root.visible) continue;
      activeIds.add(id);

      _vTag.set(rp.body.pos.x, rp.body.pos.y + (rp.crouching ? 1.6 : 2.3), rp.body.pos.z);
      _toTag.subVectors(_vTag, camPos);
      const dist = _toTag.length();

      if (_toTag.dot(_camFwd) <= 0.1 || dist > 85) {
        const el = this._nameTags.get(id);
        if (el) el.style.display = 'none';
        continue;
      }

      _vTag.project(camera);
      if (_vTag.z > 1.0) {
        const el = this._nameTags.get(id);
        if (el) el.style.display = 'none';
        continue;
      }

      const sx = (_vTag.x * 0.5 + 0.5) * w;
      const sy = (-_vTag.y * 0.5 + 0.5) * h;

      _toTag.normalize();
      const hit = world ? world.raycast(camPos, _toTag, dist - 0.5) : null;
      const isTeammate = localPlayer && (localPlayer.team === rp.team);

      if (hit && !isTeammate) {
        const el = this._nameTags.get(id);
        if (el) el.style.display = 'none';
        continue;
      }

      let el = this._nameTags.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'nametag';
        el.innerHTML = '<span class="nt-header"><i class="nt-dot"></i><b class="nt-name"></b></span><div class="nt-bar"><i class="nt-fill"></i></div>';
        this.el.nametags.appendChild(el);
        this._nameTags.set(id, el);
      }

      const teamColor = (rp.team === 'red' || rp.ink === 1) ? 'red' : 'blue';
      el.className = `nametag team-${teamColor}${hit ? ' occluded' : ''}`;

      const nameEl = el.querySelector('.nt-name');
      if (nameEl && nameEl.textContent !== rp.name) nameEl.textContent = rp.name || 'Garabato';

      const hpFrac = clamp((rp.hp || 0) / (rp.maxHp || 100), 0, 1);
      const fillEl = el.querySelector('.nt-fill');
      if (fillEl) fillEl.style.width = (hpFrac * 100).toFixed(0) + '%';

      const scale = clamp(1.0 - (dist - 10) * 0.01, 0.68, 1.15);
      const opacity = hit ? 0.35 : clamp(1.0 - (dist - 55) / 30, 0.3, 1.0);

      el.style.display = 'flex';
      el.style.opacity = opacity.toFixed(2);
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
    }

    for (const [id, el] of this._nameTags) {
      if (!activeIds.has(id)) {
        el.remove();
        this._nameTags.delete(id);
      }
    }
  }
  clearNametags() {
    if (!this._nameTags) return;
    for (const el of this._nameTags.values()) el.remove();
    this._nameTags.clear();
  }
  update(dt) {
    if (this._msgT > 0) { this._msgT -= dt; if (this._msgT <= 0) { this.el.msg.classList.remove('show'); this.el.msgsub.textContent = ''; } }
    if (this._tipT > 0) { this._tipT -= dt; if (this._tipT <= 0) this.el.tip.classList.remove('show'); }
  }
}

export const KB_KEYS = { fire: 'Clic Izq', aim: 'Clic Der', block: 'Clic Der', jump: 'Espacio', sprint: 'Shift', slide: 'C', dash: 'C', grapple: 'Q', melee: 'F', reload: 'R', grenade: 'G', focus: 'Ambos clics (o X)', next: 'Rueda', pause: 'Esc', confirm: 'Espacio', score: 'Tab' };
export const PAD_KEYS = { fire: 'R2', aim: 'L2', block: 'L2', jump: '✕', sprint: 'L3', slide: '○', dash: '○', grapple: 'L1', melee: 'R1', reload: '□', grenade: 'R3', focus: 'L2 + R2', next: '△', pause: 'Options', confirm: '✕', score: 'Create' };
export const CONTROLS_HTML = `
<div class="cols">
  <div><div class="colhead">Ratón + Teclado</div>
    <div><b>WASD</b> Moverse &nbsp; <b>Ratón</b> Mirar &nbsp; <b>Shift</b> Esprintar</div>
    <div><b>Clic Izq</b> Disparar / Tajo &nbsp; <b>Clic Der</b> Apuntar / Bloquear</div>
    <div><b>Espacio</b> Saltar (en pared = salto de pared)</div>
    <div>En el aire pulsa <b>Espacio</b> = Doble salto</div>
    <div><b>C / Ctrl</b> Deslizarse en suelo · Embestida aérea</div>
    <div><b>Q / E</b> Gancho: toque para balanceo, mantener para recoger, saltar para impulso</div>
    <div><b>F</b> Tajo rápido de katana &nbsp; <b>R</b> Recargar &nbsp; <b>M</b> Música</div>
    <div><b>G</b> Granada · Mantén para lanzar más lejos</div>
    <div><b>Tab</b> Marcador (en línea) &nbsp; <b>Esc</b> Pausa</div>
    <div><b>1-7 / Rueda</b> Fusil · Escopeta · Sniper · Subfusil · Revólver · Lanzatintas · Katana</div>
    <div><b>Trampolines / Resortes</b> Salta sobre ellos para impulsarte a gran altura</div>
  </div>
  <div><div class="colhead">Mando PS5</div>
    <div><b>Stick Izq</b> Moverse &nbsp; <b>Stick Der</b> Mirar &nbsp; <b>L3</b> Esprintar</div>
    <div><b>R2</b> Disparar / Tajo &nbsp; <b>L2</b> Apuntar / Bloquear</div>
    <div><b>✕</b> Saltar &nbsp; <b>○</b> Deslizarse · Embestida aérea</div>
    <div><b>L1</b> Gancho (mantener para recoger, ✕ para impulso)</div>
    <div><b>L2 + R2</b> Embestida con corte con energía al máximo</div>
    <div><b>R1</b> Tajo rápido de katana y vuelve al arma</div>
    <div><b>□</b> Recargar &nbsp; <b>△</b> Siguiente arma</div>
    <div><b>R3 / D-pad Arriba</b> Granada · Mantén para lanzar más lejos</div>
    <div><b>Create</b> Marcador (en línea) &nbsp; <b>Options</b> Pausa</div>
  </div>
</div>`;
