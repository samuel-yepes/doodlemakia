// Game bootstrap: solo waves, free-for-all lobbies, checkpoints, scoring, screens and the loop.
// Online play is peer-to-peer: one player's browser hosts the lobby and keeps score, every
// player runs their own body, and each one tells the others what it did.
import * as THREE from 'three';
import { InkRenderer, INK, makeInkMaterial, PLAYER_COLORS } from './render.js';
import { World } from './physics.js';
import { Input } from './input.js';
import { buildLevel, LEVELS } from './level.js';
import { NavGrid } from './nav.js';
import { Effects } from './effects.js';
import { EnemyManager, BOSSES } from './enemies.js';
import { Player } from './player.js';
import { RemotePlayer, encodeLocal } from './players.js';
import { Net, normalizeRoomCode } from './net.js';
import { HUD, CONTROLS_HTML, getControlsHTML } from './hud.js';
import { audio } from './audio.js';
import { rand, choose, clamp } from './util.js';

const canvas = document.getElementById('c');
const R = new InkRenderer(canvas);
const world = new World();
const knownMap = (k) => (LEVELS.some((m) => m.key === k) ? k : 'district');
let mapKey = knownMap(localStorage.getItem('doodle_map') || 'district');
let level = buildLevel(R.scene, world, mapKey, { arena: false });
let nav = new NavGrid(world, level.bounds, 1).build();
let loadedKey = mapKey, arenaLoaded = false;
const mapTune = (k) => (k === 'mexico' ? 'mexico' : 'district');
audio.setTune(mapTune(mapKey));
// the map in play: solo uses the picked map, a match uses the host's choice; a rebuild wipes broken props
function setLevel(key, on, force = false) {
  if (!force && key === loadedKey && on === arenaLoaded) return; loadedKey = key; arenaLoaded = on;
  for (const m of level.meshes) { R.scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.traverse) m.traverse((o) => { if (o !== m && o.geometry) o.geometry.dispose(); }); }
  level.animated.length = 0; world.clear();
  level = buildLevel(R.scene, world, key, { arena: on }); nav = new NavGrid(world, level.bounds, 1).build();
  ctx.level = level; ctx.nav = nav; if (window.__game) { window.__game.level = level; window.__game.nav = nav; }
  audio.setTune(mapTune(key));
}
const setArena = (on) => setLevel(knownMap(net.active ? (lobby.map || mapKey) : mapKey), on);
const input = new Input(canvas);
const hud = new HUD(document.getElementById('hud'));
const effects = new Effects(R.scene, world);
const ctx = { scene: R.scene, camera: R.camera, world, level, nav, input, hud, effects, audio, renderer: R };

// ---------------- persistent bits ----------------
let best = Number(localStorage.getItem('doodle_best') || 0);
let musicWanted = localStorage.getItem('doodle_music') !== '0';
let checkpoint = Number(localStorage.getItem('doodle_checkpoint') || 0);
let myName = (localStorage.getItem('doodle_name') || '').slice(0, 14) || 'Garabato' + Math.floor(Math.random() * 90 + 10);
const settings = { sens: Number(localStorage.getItem('doodle_sens') || 100), invert: localStorage.getItem('doodle_invert') === '1' };
function applySettings() {
  input.mouseSens = 0.0022 * settings.sens / 100; input.padSensX = 3.4 * settings.sens / 100; input.padSensY = 2.6 * settings.sens / 100; input.invertY = settings.invert;
  localStorage.setItem('doodle_sens', String(settings.sens)); localStorage.setItem('doodle_invert', settings.invert ? '1' : '0');
}
// ---------------- game state & map rotation ----------------
const FFA_TARGET = 20, FFA_TIME = 600, RESPAWN = 2.5;
let matchLeft = FFA_TIME, clockT = 0, clockRunning = false;
let mapRotationIndex = Number(localStorage.getItem('doodle_rot_idx') || 0);
let userExplicitlyPickedMap = false;
const MAP_ROTATION_INTERVAL = 180; // 3 minutos por rotación de mapa
let mapRotationTimer = MAP_ROTATION_INTERVAL;
let mapWarn15 = false;
let mapWarn5 = false;

const mmss = (t) => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const game = ctx.game = {
  state: 'start', mode: 'solo', menu: false, time: 0, hitstopT: 0, hitstopScale: 1, wave: 0, score: 0, combo: 0, comboT: 0, kills: 0, intermission: 0, queue: [], spawnT: 0, maxAlive: 6, deathT: 0,
  focus: { active: false, t: 0, chain: 0, target: null, dash: null, arm: 0, ready: false }, katanaStreak: 0, boss: null, respawnT: 0, matchT: 0, over: null, overT: 0,
  hitstop(d, s) { this.hitstopT = Math.max(this.hitstopT, d); this.hitstopScale = s; },
  addScore(pts, label) { const mult = 1 + Math.min(this.combo, 9) * 0.25; const p = Math.round(pts * mult); this.score += p; if (label) hud.kill(label, p); hud.setScore(this.score, this.combo); },
  onPlayerDeath() { endFocus(); onLocalDeath(); },
};
const online = () => game.mode === 'ffa';
const enemies = ctx.enemies = new EnemyManager(ctx);
const player = ctx.player = new Player(ctx);
player.name = myName;
const net = new Net();
net.onStateChange = (st) => { hud.setNetState(st); setStatus(st); };
const remote = new Map();      // peer id -> RemotePlayer
const lobby = { players: new Map(), hostId: null, isPublic: true, status: '', code: '', map: null, gameMode: 'ffa' };
const scores = new Map();      // peer id -> { name, kills, deaths }
let screen = 'main';           // which start-screen panel is showing: main | online | lobby
window.__game = { ctx, game, player, enemies, nav, world, level, hud, effects, input, net, remote, lobby, scores };

function getPlayerColor(id) {
  let idx = 0;
  if (lobby.order && lobby.order.includes(id)) {
    idx = lobby.order.indexOf(id);
  } else {
    const rows = lobbyRows();
    const found = rows.findIndex((p) => p.id === id);
    if (found !== -1) idx = found;
    else {
      let h = 0;
      for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      idx = h;
    }
  }
  return PLAYER_COLORS[Math.abs(idx) % PLAYER_COLORS.length];
}

function refreshPlayerColors() {
  for (const [id, r] of remote) {
    const col = getPlayerColor(id);
    r.color = col;
    r.setTeam(col.name, col.ink);
  }
}

function getNextRotatedMapKey() {
  const key = LEVELS[mapRotationIndex % LEVELS.length].key;
  mapRotationIndex = (mapRotationIndex + 1) % LEVELS.length;
  localStorage.setItem('doodle_rot_idx', String(mapRotationIndex));
  return key;
}

function rotateStartingMap() {
  if (userExplicitlyPickedMap) {
    userExplicitlyPickedMap = false;
    setLevel(mapKey, false, true);
    mapRotationTimer = MAP_ROTATION_INTERVAL;
    mapWarn15 = false;
    mapWarn5 = false;
    hud.message('🗺️ Mapa: ' + mapName(mapKey), '¡Sobrevive a las oleadas!', 3);
    return;
  }
  const nextKey = getNextRotatedMapKey();
  mapKey = nextKey;
  localStorage.setItem('doodle_map', nextKey);
  setLevel(nextKey, false, true);
  mapRotationTimer = MAP_ROTATION_INTERVAL;
  mapWarn15 = false;
  mapWarn5 = false;
  hud.message('🗺️ Mapa: ' + mapName(nextKey), '¡Sobrevive a las oleadas!', 3);
}

function teleportPlayerToMapStart(pos) {
  const b = player.body;
  b.pos.copy(pos);
  b.vel.set(0, 0, 0);
  b.onGround = false;
  player.detachGrapple(false);
  player.sliding = false;
  player.crouching = false;
  player.shieldT = 3;
  player.addAmmoAll(0.35);
  player.hp = Math.min(player.maxHp, player.hp + 30);
  hud.setHealth(player.hp, player.maxHp);
}

function rotateMapInGame() {
  const nextKey = getNextRotatedMapKey();
  mapKey = nextKey;
  localStorage.setItem('doodle_map', nextKey);
  setLevel(nextKey, false, true);

  teleportPlayerToMapStart(level.playerStart || new THREE.Vector3(0, 0, 42));

  for (const p of pickups) R.scene.remove(p.mesh);
  pickups.length = 0;
  pickupClock = 0;
  spawnPickup(); spawnPickup();

  enemies.clear();
  effects.clear();
  endFocus();
  game.intermission = 0;
  game.queue = [];
  startWave(Math.max(1, game.wave));

  hud.message('🗺️ ¡ROTACIÓN DE MAPA!', 'Ahora en: ' + mapName(nextKey), 3.8);
  audio.wave();
}

function applyOnlineMapRotation(nextKey) {
  mapKey = nextKey;
  lobby.map = nextKey;
  setLevel(nextKey, true, true);

  teleportPlayerToMapStart(arenaSpawn());

  for (const p of pickups) R.scene.remove(p.mesh);
  pickups.length = 0;
  pickupClock = 0;
  effects.clear();

  hud.message('🗺️ ¡ROTACIÓN DE MAPA!', 'El combate se traslada a: ' + mapName(nextKey), 3.8);
  audio.wave();
}

// anything a bullet or a blade can hit besides enemies
ctx.targets = () => [player, ...remote.values()];
ctx.canHurt = (t) => {
  if (!online() || !t || t === player) return false;
  return true;
};
ctx.raycastPlayers = (o, d, maxDist) => {
  let best = null;
  for (const t of remote.values()) {
    if (!t.alive || !ctx.canHurt(t)) continue;
    for (let i = 0; i < t.hit.length; i++) {
      const c = t.hitSpheres[i], r = t.hit[i][1];
      _v.subVectors(c, o); const tca = _v.dot(d); if (tca < 0 || tca > maxDist) continue;
      const d2 = _v.lengthSq() - tca * tca; if (d2 > r * r) continue;
      const tt = tca - Math.sqrt(r * r - d2); if (tt < 0) continue;
      if (!best || tt < best.dist) best = { player: t, part: t.hit[i][0], dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) };
    }
    // a raised katana sits in front of the chest: a ray that reaches it before the body is turned aside
    if (t.blocking) {
      _bc.set(t.center.x + t.forward.x * 0.5, t.center.y + 0.3, t.center.z + t.forward.z * 0.5); const r = 0.42;
      _v.subVectors(_bc, o); const tca = _v.dot(d);
      if (tca > 0 && tca <= maxDist) { const d2 = _v.lengthSq() - tca * tca; if (d2 <= r * r) { const tt = tca - Math.sqrt(r * r - d2); if (tt >= 0 && (!best || best.player !== t || tt < best.dist)) best = { player: t, part: 'blade', dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) }; } }
    }
  }
  return best;
};
const _bc = new THREE.Vector3();
ctx.playersInArc = (pos, dir, range, cosHalf) => { const out = []; for (const t of remote.values()) { if (!t.alive || !ctx.canHurt(t)) continue; _v.subVectors(t.center, pos); const d = _v.length(); if (d > range + 0.3) continue; if (d > 0.3 && _v.normalize().dot(dir) < cosHalf) continue; if (!world.hasLineOfSight(pos, t.center)) continue; out.push(t); } return out; };
const HOW = { rifle: 'Fusil', shotgun: 'Escopeta', sniper: 'Francotirador', smg: 'Subfusil', revolver: 'Revólver', launcher: 'Lanzagranadas', katana: 'Espada de Energía', grenade: 'Granada', deflect: 'su propia bala' };
function howWord(src) { return HOW[src] || null; }

function killRemotePlayer(t, info = {}) {
  if (!t || !t.alive) return;
  t.alive = false;
  t.hp = 0;
  const dir = info.dir ? info.dir.clone() : (info.from ? player.center.clone().sub(info.from).normalize() : player.forward.clone());
  const isOver = !!(info.crit || (info.amount && info.amount >= 90) || info.source === 'katana');
  t.ragdoll(dir, isOver);
  audio.enemyDie(t.center);
  audio.kill(true);
  game.kills++;
  const how = info.source ? howWord(info.source) : null;
  const detail = how ? ' · ' + how + (info.crit ? ' Tiro a la cabeza' : '') : (info.crit ? ' · Tiro a la cabeza' : '');
  game.addScore(100, 'Borrado a ' + (t.name || 'Garabato') + detail);
  hud.kill('Borrado a ' + (t.name || 'Garabato') + detail, 100);

  net.broadcast('pdead', {
    killer: net.id,
    victim: t.id,
    dir: dir.toArray().map((v) => +v.toFixed(2)),
    over: isOver,
    crit: !!info.crit,
    how
  });
  if (net.isHost) tallyDeath(t.id, net.id);
}

ctx.hitPlayer = (t, dmg, info) => {
  if (!ctx.canHurt(t) || !t.alive) return;
  // a raised katana facing you parries a slash outright and turns some bullets aside
  // the bullet met the blade itself: it glances off, and now and then comes straight back at you
  if (info.part === 'blade') {
    effects.strokeBurst(info.point, INK.ORANGE, 8, 6, { life: 0.22, size: 0.035 }); audio.shieldHit(t.center);
    const ret = Math.random() < 0.4;
    if (ret) {
      effects.tracer(info.point, player.eye, INK.RED, 0.03, 0.08); hud.tip('¡Desviado!', 0.9); input.rumble(0.5, 0.4, 90);
      player.lastHitBy = t.id; player.lastHit = { from: t.center.toArray(), crit: false, amount: dmg * 0.6, src: 'deflect' }; player.takeDamage(dmg * 0.6, t.center);
    } else hud.tip('¡Rechazado!', 0.7);
    net.sendTo(t.id, 'parry', { ret, by: net.id });
    return;
  }
  const facing = t.blocking ? _v.subVectors(player.center, t.center).normalize().dot(t.forward) : -1;
  const frontHit = /^(head|torso|arm|fore)/.test(info.part || '');
  // a slash is only parried by a guard that just came up and faces you
  if (facing > 0.6 && frontHit && info.source === 'katana' && t.parryWindow) { effects.strokeBurst(info.point, INK.ORANGE, 10, 6, { life: 0.25, size: 0.04 }); audio.shieldHit(t.center); game.hitstop(0.08, 0.15); player.weapons[player.katanaIndex].cooldown = Math.max(player.weapons[player.katanaIndex].cooldown, 0.6); input.rumble(0.6, 0.3, 90); hud.tip('¡Bloqueado!', 0.9); return; }
  
  const damageVal = Math.round(dmg);
  effects.blood(info.point, info.dir, clamp(0.4 + damageVal / 80, 0.4, 1.6), { ink: INK.RED });
  hud.hitmarker(false, info.crit);
  audio.hitEnemy(t.center);
  t.flash();

  // Deduce vida inmediatamente en local para que la barra de salud baje al instante
  t.hp = Math.max(0, (t.hp != null ? t.hp : 100) - damageVal);

  net.sendTo(t.id, 'pdmg', {
    amount: damageVal,
    from: player.center.toArray().map((v) => +v.toFixed(1)),
    by: net.id,
    crit: !!info.crit,
    src: info.source
  });

  // Si la vida llega a 0, confirmar baja de inmediato
  if (t.hp <= 0 && t.alive) {
    killRemotePlayer(t, {
      crit: info.crit,
      amount: damageVal,
      source: info.source,
      dir: info.dir ? info.dir.clone() : player.forward.clone()
    });
  }
};
// a slash through another player's rope cuts it: their client drops the hook
const _rp = new THREE.Vector3(), _rq = new THREE.Vector3();
ctx.cutRopes = (eye, dir, range) => {
  let cut = false;
  for (const r of remote.values()) {
    if (!r.alive || !r.grappling) continue;
    _rp.set(r.body.pos.x + r.right.x * 0.35, r.body.pos.y + 1.25, r.body.pos.z + r.right.z * 0.35);
    for (let i = 0; i <= 14; i++) {
      _rq.lerpVectors(_rp, r.gPoint, i / 14).sub(eye); const t = _rq.dot(dir); if (t < 0.3 || t > range) continue;
      const lat = Math.sqrt(Math.max(0, _rq.lengthSq() - t * t)); if (lat > 0.9) continue;
      _rq.add(eye); effects.strokeBurst(_rq, INK.ORANGE, 10, 5, { life: 0.25, size: 0.035 }); net.sendTo(r.id, 'cut', {}); hud.tip('Cuerda cortada', 0.9); cut = true; break;
    }
  }
  return cut;
};
const _v = new THREE.Vector3();
// breakable props: bullets, blades and blasts break them, and everyone in a match sees it go
ctx.breakHit = (br, dmg, point, dir) => {
  if (!br.alive) return; br.hp -= dmg;
  if (br.hp <= 0) breakProp(br, dir, true); else { effects.strokeBurst(point, br.ink, 5, 4, { life: 0.2, size: 0.03 }); audio.shieldHit(point); }
};
ctx.breakablesInArc = (pos, dir, range, cosHalf) => level.breakables.filter((br) => { if (!br.alive) return false; _v.subVectors(br.pos, pos); const d = _v.length(); return d < range + 0.5 && (d < 0.4 || _v.divideScalar(d).dot(dir) > cosHalf); });
ctx.blastBreakables = (c, R) => { for (const br of level.breakables) if (br.alive && br.pos.distanceTo(c) < R * 0.9) breakProp(br, br.pos.clone().sub(c).normalize(), true); };
function breakProp(br, dir, local, quiet = false) {
  if (!br.alive) return; br.alive = false; world.removeBox(br.box);
  const g = br.group, pos = br.pos; const d = dir && dir.lengthSq() > 0.01 ? dir.clone().normalize() : new THREE.Vector3(rand(-1, 1), 1, rand(-1, 1)).normalize();
  if (quiet) { R.scene.remove(g); return; }
  g.updateMatrixWorld(true);
  for (const child of [...g.children]) {
    child.updateWorldMatrix(true, false); R.scene.attach(child);
    const v = d.clone().multiplyScalar(rand(2, 6)); v.x += rand(-3, 3); v.z += rand(-3, 3); v.y += rand(2.5, 6.5);
    effects.debris(child, child.position, v, new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), { radius: 0.14, blood: false, life: rand(6, 9) });
  }
  R.scene.remove(g);
  const up = new THREE.Vector3(0, 1, 0);
  if (br.kind === 'pinata') {
    for (const ink of [INK.PINK, INK.ORANGE, INK.GREEN]) effects.strokeBurst(pos, ink, 16, 7, { life: 0.7, size: 0.05 });
    effects.explosion(pos, 2.5, INK.PINK); if (!net.active || net.isHost) for (let i = 0; i < 2; i++) spawnPickup('health', pos.clone().add(new THREE.Vector3(rand(-1.2, 1.2), 0, rand(-1.2, 1.2))));
    if (game.mode === 'solo') game.addScore(25, 'Piñata');
  } else if (br.kind === 'cactus') { effects.blood(pos, d, 1.4, { ink: INK.GREEN }); effects.bloodPool(new THREE.Vector3(pos.x, 0, pos.z), 1.1, INK.GREEN); }
  else { effects.strokeBurst(pos, br.ink, 12, 5, { life: 0.35, size: 0.04 }); effects.smoke(pos, up, 3); }
  audio.smash(pos, br.kind === 'barrel' || br.kind === 'crate' || br.kind === 'cactus');
  if (local && net.active) net.broadcast('brk', { id: br.id });
}
// every ray a gun fires this tick is sent to the others, who draw it as a tracer from the shooter's gun
const shotQueue = [];
ctx.onShot = (end) => { if (net.active && inMatch()) shotQueue.push(+end.x.toFixed(1), +end.y.toFixed(1), +end.z.toFixed(1)); };
const TRACER_THICK = { rifle: 0.02, shotgun: 0.014, sniper: 0.03 };
const _sm = new THREE.Vector3(), _se = new THREE.Vector3();

// ---------------- pickups ----------------
const pickups = []; let pickupId = 1;
const pmat = { ammo: makeInkMaterial({ ink: INK.BLUE }), health: makeInkMaterial({ ink: INK.GREEN }), cap: makeInkMaterial({ ink: INK.BLACK }), shell: makeInkMaterial({ ink: INK.ORANGE }) };
function makePickup(kind) {
  const g = new THREE.Group();
  if (kind === 'ammo') { g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), pmat.ammo)); const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8), pmat.cap); c.position.y = 0.33; g.add(c); const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), pmat.cap); l.position.set(0, 0, 0.24); g.add(l); }
  else if (level.key === 'mexico') { const sh = new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12, 1, false, 0, Math.PI); sh.rotateZ(Math.PI / 2); sh.rotateX(-Math.PI / 2); g.add(new THREE.Mesh(sh, pmat.shell)); const f = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.2), pmat.health); f.position.y = 0.02; g.add(f); const m = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.08, 0.14), pmat.cap); m.position.y = 0.1; g.add(m); }
  else { g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), pmat.health), new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pmat.health)); }
  return g;
}
function spawnPickup(kind, pos, id = null) {
  const m = makePickup(kind); m.position.copy(pos); m.position.y += 0.6; R.scene.add(m);
  const p = { id: id ?? pickupId++, kind, mesh: m, base: m.position.y, t: rand(0, 6), life: 45 }; pickups.push(p);
  if (net.isHost) net.send('pickup', { id: p.id, kind, pos: pos.toArray() });
  return p;
}
function removePickup(p) { R.scene.remove(p.mesh); const i = pickups.indexOf(p); if (i >= 0) pickups.splice(i, 1); }
function collectPickup(p) {
  if (p.kind === 'ammo') { player.addAmmoAll(0.4); player.grenades = Math.min(player.maxGrenades, player.grenades + 1); hud.kill('+Munición · +Granada', 0); } else { player.hp = Math.min(player.maxHp, player.hp + 35); hud.kill(level.key === 'mexico' ? 'Taco · +35 Salud' : '+35 Salud', 0); }
  audio.pickup(); effects.strokeBurst(p.mesh.position, p.kind === 'ammo' ? INK.BLUE : INK.GREEN, 12, 4, { life: 0.3 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt; p.mesh.position.y = p.base + Math.sin(p.t * 2.5) * 0.12; p.mesh.rotation.y += dt * 1.8;
    if (player.alive && p.mesh.position.distanceTo(player.center) < 1.5) {
      collectPickup(p); removePickup(p);
      if (net.active) net.send(net.isHost ? 'taken' : 'take', { id: p.id });
      continue;
    }
    if (!net.active || net.isHost) { p.life -= dt; if (p.life <= 0) { removePickup(p); if (net.isHost) net.send('taken', { id: p.id }); } }
  }
}
let pickupClock = 0;
function updateArenaPickups(dt) {
  if (!net.isHost) return; pickupClock -= dt;
  if (pickupClock <= 0 && pickups.length < 10) { pickupClock = 7; spawnPickup('ammo', choose(level.pickups)); }
}

// ---------------- solo waves ----------------
const ROSTER = [
  { t: 'grunt', from: 1, w: 10 }, { t: 'rusher', from: 2, w: 6 }, { t: 'bomber', from: 3, w: 3 },
  { t: 'sniper', from: 3, w: 4 }, { t: 'flyer', from: 4, w: 4 }, { t: 'heavy', from: 5, w: 4 }, { t: 'shield', from: 6, w: 4 },
];
const MODIFIERS = [
  { name: '', apply: () => { enemies.mods.speed = 1; enemies.mods.damage = 1; } },
  { name: 'Cafeína · Movimiento más rápido', apply: () => { enemies.mods.speed = 1.35; enemies.mods.damage = 0.85; } },
  { name: 'Tinta pesada · Mayor daño', apply: () => { enemies.mods.speed = 0.9; enemies.mods.damage = 1.4; } },
  { name: 'Enjambre · Más enemigos, menor salud', apply: () => { enemies.mods.speed = 1.15; enemies.mods.damage = 0.9; } },
];
const tips = () => [
  `Mantén <b>${hud.key('grapple')}</b> para recoger cable · Pulsa en balanceo para soltarte`,
  `Bloquea con <b>${hud.key('block')}</b> para desviar algunas balas de vuelta`,
  'Las bajas aéreas dan más puntos · Intenta no tocar el suelo',
  `Lanza granadas con <b>${hud.key('grenade')}</b> · Los suministros recargan granadas`,
  `Pulsa de nuevo <b>${hud.key('jump')}</b> en el aire para doble salto`,
];
const bossFor = (n) => BOSSES[(Math.floor(n / 5) - 1) % BOSSES.length];
const enemyName = (t) => ({ boss: 'El Garabateador', eraser: 'El Borrador', inkblot: 'La Mancha de Tinta' })[t] || t.toUpperCase();
function startWave(n) {
  game.wave = n; game.queue = []; game.spawnT = 2; game.intermission = 0; game.boss = null; hud.setBoss(null, null);
  const boss = n > 0 && n % 5 === 0;
  const allowed = boss || n < 4 ? 1 : n < 6 ? 3 : MODIFIERS.length; const mod = MODIFIERS[Math.floor(Math.random() * allowed)];
  mod.apply(); enemies.mods.damage *= 1.2; hud.setModifier(mod.name);
  const swarm = mod.name.startsWith('Enjambre');
  // the crowd on screen and the wave size both keep growing with the wave number
  game.maxAlive = Math.min(4 + Math.floor(n * 0.9) + (swarm ? 3 : 0), (swarm ? 22 : 18) + Math.floor(n / 3));
  let count = Math.round(Math.min(5 + n * 2.0, 32 + n) * (swarm ? 1.35 : 1));
  if (boss) { count = 7 + n; game.maxAlive += 2 + Math.floor(n / 5); game.queue.push(bossFor(n)); }
  const pool = ROSTER.filter((r) => n >= r.from).map((r) => ({ t: r.t, w: r.w * Math.min(1, 0.3 + 0.25 * (n - r.from)) }));
  const total = pool.reduce((a, r) => a + r.w, 0);
  for (let i = 0; i < count; i++) { let r = Math.random() * total, t = pool[0].t; for (const c of pool) { r -= c.w; if (r <= 0) { t = c.t; break; } } game.queue.push(t); }
  if (boss) { hud.message('Oleada ' + n, enemyName(bossFor(n)) + ' se aproxima', 3); audio.bossRoar(player.center); }
  else hud.message('Oleada ' + n, n === 1 ? 'Se arrastran desde fuera del papel' : mod.name || choose(['Dibuja con más fuerza', 'Sigue garabateando', 'No te quedes en el suelo', 'Desenvaina y ataca', 'Devuelve las balas']), 2.6);
  audio.wave();
  if (n <= tips().length) hud.tip(tips()[n - 1], 7);
  player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
  for (let i = 0; i < 7; i++) spawnPickup(i < 5 ? 'ammo' : 'health', choose(level.pickups));
  if (n >= 5 && n % 5 === 0 && n > checkpoint) { checkpoint = n; localStorage.setItem('doodle_checkpoint', String(n)); hud.kill('Punto de control · Oleada ' + n, 0); }
}
function pickSpawn(type) {
  const spots = type === 'sniper' ? level.snipers : level.spawns; const pp = player.body.pos;
  if (type === 'flyer') { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 10; return new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, level.bounds.minX + 4, level.bounds.maxX - 4), pp.y + 12 + Math.random() * 6, clamp(pp.z + Math.sin(a) * r, level.bounds.minZ + 4, level.bounds.maxZ - 4)); }
  if (BOSSES.includes(type)) {
    const fits = (sp) => !world.overlapsAABB({ x: sp.x - 1.1, y: sp.y + 0.1, z: sp.z - 1.1 }, { x: sp.x + 1.1, y: sp.y + 5.2, z: sp.z + 1.1 });
    const open = spots.filter((sp) => fits(sp)); const far = open.filter((sp) => sp.distanceTo(pp) > 20);
    if (far.length) return choose(far).clone(); if (open.length) return choose(open).clone();
    for (let i = 0; i < 200; i++) { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 18; const c = new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, -44, 44), 0, clamp(pp.z + Math.sin(a) * r, -44, 44)); c.y = world.groundBelow(c.x, 30, c.z, 40); if (c.y > -3 && fits(c)) return c; }
    return level.playerStart.clone();
  }
  let cands = spots.filter((s) => { const d = s.distanceTo(pp); return d > 14 && d < 48; });
  if (cands.length < 2) cands = spots.filter((s) => s.distanceTo(pp) > 14);
  const hidden = cands.filter((s) => !world.hasLineOfSight(player.eye, new THREE.Vector3(s.x, s.y + 1.2, s.z)));
  return (choose(hidden.length ? hidden : cands.length ? cands : spots)).clone();
}
function updateWaves(dt) {
  if (game.intermission > 0) {
    game.intermission -= dt; hud.setTimer('Próxima oleada en ' + Math.ceil(game.intermission) + ' s');
    if (game.intermission <= 0) { hud.setTimer(''); startWave(game.wave + 1); }
    return;
  }
  if (game.queue.length && enemies.alive < game.maxAlive) {
    game.spawnT -= dt;
    if (game.spawnT <= 0) {
      game.spawnT = Math.max(0.7, 2.9 - game.wave * 0.13); const t = game.queue.shift(); const e = enemies.spawn(t, pickSpawn(t));
      if (e.T.boss) { const mul = 1 + 0.35 * Math.floor((game.wave - 5) / 15); e.hp = e.maxHp = Math.round(e.T.hp * mul); }
    }
  }
  if (!game.queue.length && enemies.alive === 0) {
    game.intermission = 8; hud.message('Oleada ' + game.wave + ' superada', 'Toma un respiro · +' + 200 * game.wave, 2.5);
    game.addScore(200 * game.wave, null); audio.waveClear(); player.hp = Math.min(player.maxHp, player.hp + 40);
  }
  hud.setWave(game.wave, enemies.alive + game.queue.length);
}
enemies.onKill = (e, info, over) => {
  game.kills++; game.combo++; game.comboT = 3.5;
  let label = e.T.name, pts = e.T.score;
  if (info.crit) { label = 'Tiro a la cabeza'; pts += 60; }
  if (info.source === 'katana') { label = over ? 'Cortado en dos' : 'Tajo'; pts += 50; }
  if (info.source === 'focus') { label = 'Ejecución'; pts += 150; }
  if (info.source === 'katana' || info.source === 'focus') { game.katanaStreak++; player.weapons[player.katanaIndex].addBlood(0.42); if (game.katanaStreak >= KATANA_CHARGE_KILLS) enterFocus(); }
  else if (info.source !== 'blast') game.katanaStreak = 0;
  if (info.source === 'deflect') { label = 'Devuelto'; pts += 120; }
  if (info.source === 'fall') label = 'Caída del papel';
  else if (!player.body.onGround && info.source !== 'deflect') { label += ' · Muerte aérea'; pts += 40; }
  game.addScore(pts, label); audio.kill(!!info.crit || e.T.boss);
  const r = Math.random(); if (r < 0.5) spawnPickup('ammo', e.body.pos); else if (r < 0.62) spawnPickup('health', e.body.pos);
};
enemies.onBoss = (e) => { if (!e.alive) { hud.setBoss(null, null); game.boss = null; } else { game.boss = e; hud.setBoss(e.T.name, e.hp / e.maxHp); } };
player.onThrow = (d) => { if (net.active) net.broadcast('nade', d); };

// ---------------- focus slash (solo only) ----------------
const FOCUS_TIME = 2.6, FOCUS_SCALE = 0.26, FOCUS_RANGE = 24, FOCUS_MAX_CHAIN = 2, FOCUS_ARM = 0.18, DASH_SPEED = 46, KATANA_CHARGE_KILLS = 3;
const _fv = new THREE.Vector3();
function focusCandidate() {
  let best = null, bestScore = -1;
  for (const e of enemies.enemies) {
    if (!e.alive || e.state === 'spawn') continue;
    _fv.subVectors(e.center, player.eye); const d = _fv.length(); if (d > FOCUS_RANGE || d < 0.5) continue;
    const aim = _fv.divideScalar(d).dot(player.forward); if (aim < 0.4) continue;
    if (!world.hasLineOfSight(player.eye, e.center)) continue;
    const score = aim * 3 - d / FOCUS_RANGE; if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
function enterFocus() {
  if (online() || game.focus.chain >= FOCUS_MAX_CHAIN || !focusCandidate()) return;
  const fresh = !game.focus.active;
  game.focus.active = true; game.focus.t = FOCUS_TIME; game.focus.chain++; game.focus.arm = FOCUS_ARM; game.focus.ready = false;
  if (fresh) { audio.focusIn(); hud.tip(`<b>Corte listo</b> · Mantén ${hud.key('focus')} para embestir`, 2.2); }
}
function endFocus() { if (!game.focus.active && !game.focus.dash) return; game.focus.active = false; game.focus.target = null; game.focus.chain = 0; game.focus.dash = null; game.katanaStreak = 0; player.dashLock = false; hud.setFocusMark(null); }
function startFocusDash(target) { game.focus.dash = { target, t: 0, trail: player.center.clone(), lastTrail: 0 }; player.dashLock = true; player.body.vel.set(0, 0, 0); audio.dash(); player.kickFov(5); input.rumble(0.5, 0.4, 120); hud.setFocusMark(null); }
function marchBody(b, nx, nz, dist) {
  let moved = 0;
  for (let step = Math.min(0.22, dist); moved + 1e-4 < dist;) { const s2 = Math.min(step, dist - moved); b.pos.x += nx * s2; b.pos.z += nz * s2; if (world.overlapsBody(b)) { b.pos.y += 0.65; if (world.overlapsBody(b)) { b.pos.y -= 0.65; b.pos.x -= nx * s2; b.pos.z -= nz * s2; return moved; } } moved += s2; }
  return moved;
}
function updateFocusDash(dt) {
  const d = game.focus.dash; if (!d) return true;
  const target = d.target; d.t += dt;
  if (!target.alive || d.t > 1.2) { endDash(false); return true; }
  const b = player.body; const dx = target.body.pos.x - b.pos.x, dz = target.body.pos.z - b.pos.z; const flat = Math.hypot(dx, dz); const nx = dx / (flat || 1), nz = dz / (flat || 1);
  player.yaw = Math.atan2(-dx, -dz); _fv.subVectors(target.center, player.eye); player.pitch = clamp(Math.atan2(_fv.y, Math.hypot(_fv.x, _fv.z)), -1.2, 1.2);
  const want = Math.max(0, flat - 1.1); const moved = marchBody(b, nx, nz, Math.min(DASH_SPEED * dt, want));
  const aimY = target.body.pos.y + (target.T.flying ? 0.2 : 0); const dy = aimY - b.pos.y;
  if (Math.abs(dy) > 0.05) { const y = b.pos.y; b.pos.y += clamp(dy, -DASH_SPEED * dt, DASH_SPEED * dt); if (world.overlapsBody(b)) { b.pos.y = y; d.stuckY = (d.stuckY || 0) + dt; } else d.stuckY = 0; }
  d.lastTrail += dt; if (d.lastTrail > 0.02) { d.lastTrail = 0; effects.tracer(d.trail, player.center, INK.BLUE, 0.045, 0.28); d.trail.copy(player.center); effects.strokeBurst(player.center, INK.BLUE, 2, 5, { life: 0.22, size: 0.03 }); }
  const reach = Math.hypot(flat, Math.max(0, Math.abs(dy) - 0.6));
  if (reach <= 1.5) { focusExecute(target); return true; }
  if (moved < 1e-4 && want > 0.05 && (d.stuckY || 0) > 0.08) { endDash(true); return true; }
  return false;
}
function endDash(blocked) { player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0); if (blocked) { player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0)); audio.katanaSwing(); hud.tip('Bloqueado · La embestida no acertó', 1.2); } }
function focusExecute(target) {
  player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0);
  player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0));
  _fv.subVectors(target.center, player.eye); const dir = _fv.clone().normalize(); const chainBefore = game.focus.chain;
  enemies.damage(target, 100000, { point: target.center.clone(), dir, part: 'head', source: 'focus', crit: true });
  audio.focusSlash(); game.hitstop(0.1, 0.08); effects.shakeAmt += 0.35; input.rumble(0.9, 0.7, 140); player.kickFov(6); player.hp = Math.min(player.maxHp, player.hp + 6);
  if (game.focus.chain === chainBefore) game.focus.t = Math.min(game.focus.t, 0.35);
  game.focus.target = null; hud.setFocusMark(null);
}
function updateFocus(dt) {
  const f = game.focus; if (!f.active) return;
  if (f.dash) { updateFocusDash(dt); return; }
  f.t -= dt; f.arm -= dt; if (f.t <= 0 || !player.alive) { endFocus(); return; }
  const combo = (input.down('aim') && input.down('fire')) || input.down('dash'); if (!combo) f.ready = true;
  const target = focusCandidate(); f.target = target;
  if (!target) { hud.setFocusMark(null); return; }
  _fv.copy(target.center).project(R.camera);
  if (_fv.z < 1) hud.setFocusMark((_fv.x * 0.5 + 0.5) * window.innerWidth, (-_fv.y * 0.5 + 0.5) * window.innerHeight); else hud.setFocusMark(null);
  if (combo && f.ready && f.arm <= 0) { input.consume('fire'); startFocusDash(target); }
}

// ---------------- free for all: spawning, death, scoring ----------------
const spawnSpots = () => (level.arenaSpawns && level.arenaSpawns.length ? level.arenaSpawns : level.spawns);
function arenaSpawn() {
  const spots = spawnSpots();
  const others = [...remote.values()].filter((r) => r.alive && r.root && r.root.visible);
  const scored = spots.map((s) => ({ s, d: others.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999) }));
  scored.sort((a, b) => b.d - a.d);
  return choose(scored.slice(0, Math.min(3, scored.length))).s.clone();
}
// a spot for a late joiner: the one farthest from everybody already in the match
function farthestSpawnIndex() {
  const spots = spawnSpots(); const bodies = [player, ...remote.values()].filter((r) => r.alive); let best = 0, bd = -1;
  spots.forEach((s, i) => { const d = bodies.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999); if (d > bd) { bd = d; best = i; } });
  return best;
}
function onLocalDeath() {
  if (!online()) { game.state = 'dying'; game.deathT = 0; return; }
  const killer = player.lastHitBy || null; const h = player.lastHit || {};
  const dir = h.from ? player.center.clone().sub(new THREE.Vector3().fromArray(h.from)).normalize().toArray().map((v) => +v.toFixed(2)) : null;
  const how = killer ? howWord(h.src) : null;
  net.broadcast('pdead', { killer, victim: net.id, dir, over: !!(h.crit || h.amount >= 90 || h.src === 'katana'), how, crit: !!h.crit });
  if (net.isHost) tallyDeath(net.id, killer);
  game.respawnT = RESPAWN; game.state = 'dying'; game.deathT = 0;
  const kn = killer && scores.get(killer) ? scores.get(killer).name : null;
  hud.kill(kn ? 'Borrado por ' + kn + (how ? ' · ' + how + (h.crit ? ' Tiro a la cabeza' : '') : '') : 'Borrado', 0);
}
function respawnLocal() {
  player.reset(arenaSpawn()); player.name = myName; player.lastHitBy = null; player.lastHit = null; game.state = 'play'; player.shieldT = 2; hud.tip('Protección de reaparición · 2 s', 1.6);
  effects.strokeBurst(player.center, INK.CYAN, 24, 6, { life: 0.5, size: 0.03 }); audio.spawn(player.center);
}
function tallyDeath(victim, killer) {
  const v = scores.get(victim); if (v) v.deaths++;
  if (killer && killer !== victim) {
    const k = scores.get(killer); if (k) k.kills++;
  }
  sendScores(); checkWin();
}
function sendScores() {
  const rows = [...scores.entries()].map(([id, s]) => ({ id, ...s }));
  net.send('score', { rows, mode: 'ffa' });
  applyScores({ rows, mode: 'ffa' });
}
function applyScores(data) {
  const rows = Array.isArray(data) ? data : (data && data.rows ? data.rows : []);
  if (data && data.mode) game.mode = data.mode;
  scores.clear();
  for (const r of rows) scores.set(r.id, { name: r.name, kills: r.kills, deaths: r.deaths });
  refreshScoreHud();
}
function sortedScores() { return [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills || a[1].deaths - b[1].deaths); }
function refreshScoreHud() {
  if (!online()) return;
  hud.setTdmScore(false, 0, 0, 0);
  const rows = sortedScores(); const top = rows.slice(0, 3); const myIdx = rows.findIndex(([id]) => id === net.id);
  if (myIdx >= 3) top.push(rows[myIdx]);
  hud.setPvpScore(top.map(([id, sc]) => `<div class="row${id === net.id ? ' me' : ''}"><span class="rank">${rows.findIndex(([x]) => x === id) + 1}.</span><span>${esc(sc.name)}${id === net.id ? ' (Tú)' : ''}</span><b>${sc.kills}</b></div>`).join('') + `<div class="target">Primero a ${FFA_TARGET} bajas</div>`);
  hud.setModifier('');
  if (!hud.el.board.hidden) hud.setBoard(boardHTML());
}
function boardHTML(title) {
  const rows = sortedScores();
  return `<h3>${title || 'Todos contra todos'}</h3>${rows.map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}"><span>${esc(s.name)}${id === net.id ? ' (Tú)' : ''}</span><span>${s.kills} bajas · ${s.deaths} muertes</span></div>`).join('')}<div class="foot">Primero a ${FFA_TARGET} bajas · Quedan ${mmss(matchLeft)} · Sala ${String(net.aliasCode || net.code || '').replace(/-\d+$/, '')}</div>`;
}
function checkWin() {
  if (!net.isHost || !online() || game.over) return;
  let winner = null;
  for (const [id, s] of scores) if (s.kills >= FFA_TARGET) winner = { id, name: s.name };
  if (winner) { net.send('end', winner); endMatch(winner); }
}
function endMatch(winner) {
  game.over = winner; game.overT = 0; game.state = 'over'; endFocus(); input.exitLock(); hud.setBoard(null);
  const title = (winner && winner.id === net.id) ? '¡Has ganado!' : ((winner && winner.name) || 'Alguien') + ' ha ganado';
  hud.setGameplayVisible(false);
  const content = `<div class="scoreboard">${sortedScores().map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}"><span>${esc(s.name)}</span><span>${s.kills} bajas · ${s.deaths} muertes</span></div>`).join('')}</div>`;
  hud.showScreen(`<h1>${title}</h1>${content}<div class="go" id="overGo">Volviendo a la sala…</div>`);
}

// ---------------- networking ----------------
function addRemote(id, name) {
  const color = getPlayerColor(id);
  if (remote.has(id)) {
    const r = remote.get(id);
    r.name = name;
    r.color = color;
    r.setTeam(color.name, color.ink);
    return r;
  }
  const rp = new RemotePlayer(ctx, id, name, color.name, color.ink);
  rp.color = color;
  rp.onDamage = (t, amount, fromPos) => {
    if (!ctx.canHurt(t) || !t.alive) return;
    hud.hitmarker(false, false);
    const dmg = Math.round(amount);
    t.hp = Math.max(0, (t.hp != null ? t.hp : 100) - dmg);
    net.sendTo(t.id, 'pdmg', {
      amount: dmg,
      from: fromPos ? fromPos.toArray().map((v) => +v.toFixed(1)) : null,
      by: net.id,
      src: 'grenade'
    });
    if (t.hp <= 0 && t.alive) {
      killRemotePlayer(t, { source: 'grenade', from: fromPos, amount: dmg });
    }
  };
  remote.set(id, rp); return rp;
}
function removeRemote(id) { const r = remote.get(id); if (r) { r.dispose(); remote.delete(id); } lobby.players.delete(id); scores.delete(id); }
function lobbyRows() {
  const map = new Map(lobby.players);
  if (net.id && !map.has(net.id)) {
    map.set(net.id, { name: myName });
  }
  return [...map.entries()].map(([id, p]) => ({ id, name: p.name || 'Garabato' }));
}
net.getLobbyInfo = () => ({
  players: lobbyRows(),
  hostId: net.id,
  map: lobby.map || mapKey,
  gameMode: 'ffa'
});
net.onAdopt = (hostId, welcome) => {
  if (welcome && welcome.lobby) {
    const d = welcome.lobby;
    lobby.hostId = d.hostId || hostId;
    if (d.map) lobby.map = knownMap(d.map);
    lobby.gameMode = 'ffa';
    if (d.players && Array.isArray(d.players)) {
      for (const p of d.players) {
        lobby.players.set(p.id, { name: p.name });
      }
    }
  }
  lobby.players.set(net.id, { name: myName });
  net.send('join_info', { name: myName });
  refreshPlayerColors();
  renderLobby();
};
function broadcastLobby() {
  refreshPlayerColors();
  net.send('lobby', { players: lobbyRows(), hostId: net.id, isPublic: lobby.isPublic, map: lobby.map || mapKey, gameMode: 'ffa', shown: net.aliasCode || net.code });
  renderLobby();
}
const inMatch = () => ['play', 'dying', 'over'].includes(game.state);
net.onPeerLeave = (id) => {
  const nm = (lobby.players.get(id) || {}).name;
  removeRemote(id);
  broadcastLobby();
  hud.tip(`👋 <b>${esc(nm || 'Alguien')}</b> ha salido de la sala`, 2.5);
  if (inMatch()) { hud.kill((nm || 'Alguien') + ' se fue', 0); sendScores(); }
  renderLobby();
};
net.onDisconnect = () => { if (lobby.order && lobby.order.some((id) => id !== lobby.hostId)) migrateHost(); else leaveOnline('El anfitrión abandonó la sala'); };
// ---- host transfer: when the host goes, the earliest-joined player left takes over on a generation
// code (the old code is slow to free up on the signalling server); everyone else rejoins there
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let migrating = false;
async function migrateHost() { if (migrating) return; migrating = true; try { await _migrateHost(); } finally { migrating = false; } }
async function _migrateHost() {
  const oldHost = lobby.hostId, myId = net.id; const gen = (lobby.gen || 0) + 1; lobby.gen = gen;
  const base = (lobby.code || net.code || '').replace(/-\d+$/, ''); const code = base + '-' + gen;
  const roster = (lobby.order || []).filter((id) => id !== oldHost && lobby.players.has(id)); if (!roster.length || !base) { leaveOnline('El anfitrión abandonó la sala'); return; }
  const successor = roster[0]; const wasInMatch = inMatch();
  if (oldHost) { const r = remote.get(oldHost); if (r) r.dispose(); remote.delete(oldHost); lobby.players.delete(oldHost); scores.delete(oldHost); }
  hud.message('El anfitrión se fue', successor === myId ? 'Ahora eres el anfitrión' : 'Cambiando a nuevo anfitrión…', 2.6);
  if (successor === myId) {
    let ok = false;
    for (let tries = 0; tries < 2 && !ok; tries++) { try { await net.host({ isPublic: lobby.isPublic, code }); ok = true; } catch (e) { await sleep(800); } }
    if (!ok) { leaveOnline('No se pudo tomar el control de la sala'); return; }
    const mine = lobby.players.get(myId) || { name: myName }; lobby.players.delete(myId); lobby.players.set(net.id, mine);
    const ms = scores.get(myId); scores.delete(myId); if (ms) scores.set(net.id, ms);
    lobby.hostId = net.id; lobby.code = code; lobby.order = [net.id, ...roster.filter((id) => id !== myId)]; net.accepting = true; game.clockStarted = clockRunning || matchLeft < FFA_TIME;
    net.onAlias = () => { broadcastLobby(); hud.kill('Código de sala ' + base + ' restaurado', 0); }; net.claimAlias(base);
    if (game.state === 'over') { /* the results stay up; the host timer now runs here */ } else if (wasInMatch) { if (game.state !== 'play' && game.state !== 'dying') game.state = 'play'; refreshScoreHud(); } else { game.state = 'lobby'; screen = 'lobby'; showStart(); }
    broadcastLobby();
  } else {
    await sleep(1200);
    const deadline = performance.now() + 20000; let joined = false;
    while (!joined && performance.now() < deadline) { try { await net.join(code, { name: myName, prev: myId }); joined = true; } catch (e) { await sleep(1200); } }
    if (!joined) { leaveOnline('El anfitrión se fue, partida perdida'); return; }
    lobby.code = code; if (!wasInMatch) { game.state = 'lobby'; screen = 'lobby'; showStart(); }
  }
}
net.on('refused', (d) => leaveOnline(d.reason));
net.hostName = myName;
net.onPeerJoin = (from, meta) => {
  const name = String(meta && meta.name || 'doodle').slice(0, 14);
  if (meta && meta.prev && meta.prev !== from) { const sc = scores.get(meta.prev); if (sc) { scores.delete(meta.prev); scores.set(from, sc); } const r = remote.get(meta.prev); if (r) r.dispose(); remote.delete(meta.prev); lobby.players.delete(meta.prev); if (lobby.order) lobby.order = lobby.order.filter((id) => id !== meta.prev); }
  const isNew = !lobby.players.has(from);
  lobby.players.set(from, { name }); addRemote(from, name); broadcastLobby();
  if (game.state === 'play' || game.state === 'dying') {
    if (!scores.has(from)) scores.set(from, { name, kills: 0, deaths: 0 });
    net.sendTo(from, 'start', { late: true, spawn: farthestSpawnIndex(), map: lobby.map || mapKey, gameMode: 'ffa', broken: level.breakables.filter((b) => !b.alive).map((b) => b.id) });
    sendScores();
    hud.kill(name + ' se unió', 0);
  } else if (isNew) {
    hud.tip(`🎮 <b>${esc(name)}</b> ha entrado a la sala`, 2.5);
    try { audio.buy(); } catch (e) {}
  }
};
net.on('join_info', (d, from) => {
  if (!net.isHost) return;
  const name = String(d && d.name || 'doodle').slice(0, 14);
  const isNew = !lobby.players.has(from);
  lobby.players.set(from, { name });
  addRemote(from, name);
  broadcastLobby();
  renderLobby();
  if (isNew) {
    hud.tip(`🎮 <b>${esc(name)}</b> ha entrado a la sala`, 2.5);
    try { audio.buy(); } catch (e) {}
  }
});
net.on('lobby', (d) => {
  lobby.hostId = d.hostId; lobby.isPublic = !!d.isPublic; lobby.code = net.code; lobby.shown = d.shown || net.code;
  if (d.map) lobby.map = knownMap(d.map);
  lobby.gameMode = 'ffa';
  if (inMatch()) game.mode = 'ffa';
  lobby.order = d.players.map((p) => p.id);

  for (const p of d.players) {
    if (p.id !== net.id && !lobby.players.has(p.id)) {
      hud.tip(`🎮 <b>${esc(p.name)}</b> ha entrado a la sala`, 2.5);
      try { audio.buy(); } catch (e) {}
    }
  }

  lobby.players.clear();
  for (const p of d.players) {
    lobby.players.set(p.id, { name: p.name });
  }
  for (const p of d.players) {
    if (p.id !== net.id) {
      const color = getPlayerColor(p.id);
      const r = remote.get(p.id);
      if (r) { r.name = p.name; r.color = color; r.setTeam(color.name, color.ink); }
      else addRemote(p.id, p.name);
    }
  }
  for (const id of [...remote.keys()]) if (!lobby.players.has(id)) removeRemote(id);
  refreshPlayerColors();
  if (inMatch()) {
    for (const p of d.players) {
      if (!scores.has(p.id)) scores.set(p.id, { name: p.name, kills: 0, deaths: 0 });
    }
    refreshScoreHud();
  }
  renderLobby();
});
net.on('setname', (d, from) => {
  if (!net.isHost) return;
  const p = lobby.players.get(from);
  if (p && d.name) {
    p.name = String(d.name).slice(0, 14);
    const r = remote.get(from);
    if (r) r.name = p.name;
    broadcastLobby();
  }
});
net.on('leave', (d) => {
  const nm = (lobby.players.get(d.id) || {}).name;
  removeRemote(d.id);
  hud.tip(`👋 <b>${esc(nm || 'Alguien')}</b> ha salido de la sala`, 2.5);
  if (inMatch()) hud.kill((nm || 'Alguien') + ' se fue', 0);
  renderLobby();
});
net.on('start', (d) => {
  if (net.isHost) return;
  if (d.map) {
    const k = knownMap(d.map);
    lobby.map = k;
    mapKey = k;
    const idx = LEVELS.findIndex((m) => m.key === k);
    if (idx !== -1) {
      mapRotationIndex = (idx + 1) % LEVELS.length;
      localStorage.setItem('doodle_rot_idx', String(mapRotationIndex));
    }
  }
  mapRotationTimer = MAP_ROTATION_INTERVAL;
  mapWarn15 = false;
  mapWarn5 = false;
  if (d.gameMode) lobby.gameMode = d.gameMode;
  startMatch(!!d.late, d.spawns ? d.spawns[net.id] : d.spawn, d.gameMode || lobby.gameMode);
  if (d.broken) for (const id of d.broken) { const br = level.breakables[id]; if (br) breakProp(br, null, false, true); }
});
net.on('startreq', () => { if (net.isHost && game.state === 'lobby') hostStart(); });
net.on('end', (d) => endMatch(d));
net.on('backtolobby', () => { if (!net.isHost) toLobbyScreen(); });
net.on('maprot', (d) => { if (!net.isHost && d && d.map) applyOnlineMapRotation(knownMap(d.map)); });
net.on('pickup', (d) => { if (!net.isHost) spawnPickup(d.kind, new THREE.Vector3().fromArray(d.pos), d.id); });
net.on('taken', (d) => { const p = pickups.find((x) => x.id === d.id); if (p) removePickup(p); });
net.on('take', (d) => { if (!net.isHost) return; const p = pickups.find((x) => x.id === d.id); if (p) { removePickup(p); net.send('taken', { id: d.id }); } });
net.on('ps', (d, from) => { const r = remote.get(from); if (r) { r.push(d, performance.now() / 1000); r.lastSeen = performance.now(); } });
net.on('pdmg', (d) => {
  if (!player.alive) return;
  player.lastHitBy = d.by || null; player.lastHit = { from: d.from || null, crit: !!d.crit, amount: d.amount, src: d.src };
  player.takeDamage(d.amount, d.from ? new THREE.Vector3().fromArray(d.from) : null);
});
net.on('pdead', (d, from) => {
  const victimId = d.victim || from;
  if (victimId === net.id) {
    if (player.alive) {
      player.lastHitBy = d.killer || null;
      player.die();
    }
    return;
  }
  const r = remote.get(victimId);
  const vn = r ? r.name : ((lobby.players.get(victimId) || {}).name || 'Alguien');
  const kn = d.killer && scores.get(d.killer) ? scores.get(d.killer).name : (d.killer === net.id ? myName : null);
  if (r && r.alive) {
    r.alive = false;
    r.hp = 0;
    r.ragdoll(d.dir ? new THREE.Vector3().fromArray(d.dir) : null, !!d.over);
    audio.enemyDie(r.center);
  }
  const how = d.how ? ' · ' + d.how + (d.crit ? ' Tiro a la cabeza' : '') : '';
  if (d.killer !== net.id) {
    hud.kill(kn ? kn + ' borró a ' + vn + how : vn + ' cayó del papel', 0);
  }
  if (net.isHost) tallyDeath(victimId, d.killer);
});
net.on('nade', (d) => player.throwGrenade(d));
net.on('brk', (d) => { const br = level.breakables[d.id]; if (br) breakProp(br, null, false); });
net.on('parry', (d) => { audio.shieldHit(player.center); input.rumble(0.35, 0.3, 60); effects.strokeBurst(player.eye.clone().addScaledVector(player.forward, 0.5), INK.ORANGE, 8, 5, { life: 0.2, size: 0.03 }); hud.kill(d.ret ? 'Devuelto' : 'Rechazado', d.ret ? 25 : 0); });
net.on('shots', (d, from) => {
  const r = remote.get(from); if (!r || !r.root || !r.alive) return;
  _sm.set(r.body.pos.x + r.right.x * 0.3 + r.forward.x * 0.8, r.body.pos.y + 1.35 + r.forward.y * 0.8, r.body.pos.z + r.right.z * 0.3 + r.forward.z * 0.8);
  const th = TRACER_THICK[d.k] || 0.02; const e = d.e || [];
  const tracerInk = (r.ink != null) ? r.ink : INK.CYAN;
  for (let i = 0; i + 2 < e.length; i += 3) { _se.set(e[i], e[i + 1], e[i + 2]); effects.tracer(_sm, _se, tracerInk, th, 0.06); }
  r.flash(); audio.remoteShot(d.k, _sm);
});
net.on('cut', () => { if (player.grapple.state !== 'idle') { player.detachGrapple(false); effects.strokeBurst(player.center, INK.ORANGE, 8, 4, { life: 0.25, size: 0.03 }); hud.tip('Tu cuerda fue cortada', 1.3); input.rumble(0.5, 0.3, 80); } });
net.on('score', (rows) => { if (!net.isHost) applyScores(rows); });
net.on('fell', (d, from) => { if (!net.isHost) return; const sc = scores.get(from); if (sc) { sc.kills = Math.max(0, sc.kills - 1); sendScores(); net.send('feed', { text: sc.name + ' cayó del papel · -1' }); hud.kill(sc.name + ' cayó del papel · -1', 0); } });
net.on('feed', (d) => hud.kill(String(d.text || ''), 0));
player.onFall = () => {
  if (!online() || !inMatch()) return;
  hud.kill('Caída del papel · Baja -1', 0);
  if (net.isHost) { const sc = scores.get(net.id); if (sc) { sc.kills = Math.max(0, sc.kills - 1); sendScores(); net.send('feed', { text: sc.name + ' cayó del papel · -1' }); } }
  else net.send('fell', {});
};
net.on('clock', (d) => { if (!net.isHost) { matchLeft = d.left; clockRunning = !!d.on; } });

// ---- idle players: a warning, then out; a lobby with nobody active in it shuts down ----
const IDLE_FLAG = 30, IDLE_MATCH = 150, IDLE_LOBBY = 300, IDLE_WARN = 20;
let idleWarned = false, idleCheckT = 0;
function idleUpdate(dt) {
  if (!net.active) { idleWarned = false; return; }
  idleCheckT -= dt; if (idleCheckT > 0) return; idleCheckT = 1;
  const limit = inMatch() ? IDLE_MATCH : IDLE_LOBBY; const idle = input.idleSeconds;
  const othersActive = [...remote.values()].some((r) => !r.idle);
  // a host that still has active players stays; kicking it would end their match
  const canDrop = !net.isHost || !othersActive;
  if (idle > limit - IDLE_WARN && !idleWarned && canDrop) { idleWarned = true; hud.message('¿Sigues ahí?', 'Muévete o serás expulsado por inactividad', 3); audio.empty(); }
  if (idle <= limit - IDLE_WARN) idleWarned = false;
  if (idle > limit && canDrop) { const back = net.isHost ? null : String(net.aliasCode || net.code || '').replace(/-\d+$/, ''); leaveOnline(net.isHost ? 'Sala cerrada: todos inactivos' : 'Expulsado por inactividad'); lobby.rejoinCode = back; if (back) showStart(); return; }
  // the host also clears out a client that has sat idle past the limit, in case its tab cannot do it itself
  if (net.isHost) for (const [id, r] of remote) if (r.idle && r.idleSince && performance.now() / 1000 - r.idleSince > limit - IDLE_FLAG + 15) { net.sendTo(id, 'kick', { reason: 'Expulsado por inactividad' }); const c = net.conns.get(id); setTimeout(() => { try { c && c.close(); } catch (e) { /* ignore */ } }, 500); }
}
net.on('kick', (d) => { const back = String(net.aliasCode || net.code || '').replace(/-\d+$/, ''); leaveOnline(d && d.reason || 'Expulsado'); lobby.rejoinCode = back; if (back) showStart(); });
let syncTick = 0;
function netUpdate(dt) {
  idleUpdate(dt);
  if (!net.active) return; const now = performance.now() / 1000; syncTick++;
  for (const r of remote.values()) r.update(dt, now);
  // a connection that died without saying so leaves a figure standing around: drop anyone silent too long
  if (inMatch() && !migrating) for (const [id, r] of remote) { if (r.lastSeen && performance.now() - r.lastSeen > 9000) { if (!net.isHost && id === net.hostId) { net.leave(); migrateHost(); break; } const nm = r.name; removeRemote(id); hud.kill(nm + ' perdió la conexión', 0); if (net.isHost) { const c = net.conns.get(id); if (c) { try { c.close(); } catch (e) { /* ignore */ } net.conns.delete(id); } net.send('leave', { id }); broadcastLobby(); sendScores(); } } }
  if (syncTick % 3 === 0 && inMatch()) net.send('ps', encodeLocal(player, player.weaponIndex, { firing: player.firing, idle: input.idleSeconds > IDLE_FLAG }), true);
  if (shotQueue.length) net.broadcast('shots', { k: player.weapon.kind, e: shotQueue.splice(0) });
  if (net.isHost && inMatch() && remote.size > 0) game.clockStarted = true;
  const clockOn = inMatch() && !game.over && (net.isHost ? !!game.clockStarted : clockRunning);
  if (inMatch() && !game.over) { if (clockOn) matchLeft = Math.max(0, matchLeft - dt); if (net.isHost) { clockT -= dt; if (clockT <= 0) { clockT = 2; net.send('clock', { left: Math.round(matchLeft), on: clockOn }); } } hud.setTimer(clockOn ? mmss(matchLeft) : 'El tiempo inicia al unirse otro jugador'); }
  if (net.isHost && clockOn) { game.matchT += dt; if (matchLeft <= 0) { const rows = sortedScores(); const w = rows.length ? { id: rows[0][0], name: rows[0][1].name } : { id: net.id, name: myName }; net.send('end', w); endMatch(w); } }
}
function leaveOnline(reason) {
  history.replaceState(null, '', window.location.pathname);
  hud.clearNametags();
  net.leave(); for (const id of [...remote.keys()]) removeRemote(id); lobby.players.clear(); scores.clear(); hud.setBoard(null);
  if (game.state !== 'start') { game.state = 'start'; game.mode = 'solo'; setArena(false); resetGame(); hud.setGameplayVisible(false); }
  game.menu = false; lobby.status = reason || ''; screen = 'online'; showStart();
}
async function createLobby(isPublic) {
  setStatus('Creando sala…');
  try { await net.host({ isPublic }); }
  catch (err) { setStatus(friendlyError(err)); unlockButtons(); return; }
  lobby.isPublic = isPublic; lobby.map = mapKey; lobby.gameMode = 'ffa'; lobby.players.clear(); lobby.players.set(net.id, { name: myName }); lobby.hostId = net.id; lobby.status = '';
  const code = String(net.aliasCode || net.code || '').replace(/-\d+$/, '');
  if (code) history.replaceState(null, '', '?room=' + code);
  game.state = 'lobby'; screen = 'lobby'; showStart();
}
async function joinLobby(code) {
  code = normalizeRoomCode(code);
  setStatus('Conectando…');
  try { await net.join(code, { name: myName }); } catch (err) { setStatus(friendlyError(err)); unlockButtons(); return; }
  lobby.isPublic = net.isPublic; lobby.status = '';
  const roomCode = String(net.aliasCode || net.code || code || '').replace(/-\d+$/, '');
  if (roomCode) history.replaceState(null, '', '?room=' + roomCode);
  game.state = 'lobby'; screen = 'lobby'; showStart();
}
async function quickPlay() {
  try { await net.quickJoin({ name: myName }, setStatus); lobby.isPublic = true; lobby.status = ''; game.state = 'lobby'; screen = 'lobby'; showStart(); return; }
  catch (err) { if (!/no open public/.test(String(err.message))) { setStatus(friendlyError(err)); unlockButtons(); return; } }
  setStatus('No hay salas abiertas · Creando una sala pública para ti…');
  await createLobby(true);
}
function friendlyError(err) {
  const m = String(err && err.message || err || ''); if (!m) return 'Ocurrió un problema al conectar';
  if (/rate limit|1015|429/i.test(m)) return 'La red externa está saturada o limitada por Cloudflare. Usa el servidor local para jugar sin restricciones.';
  if (/networking library/.test(m)) return 'No se pudo cargar la librería de red · Revisa tu conexión y recarga';
  if (/timed out|signalling/.test(m)) return 'No se pudo conectar al servidor de señalización · La red de tu trabajo o firewall podría restringir WebSockets externos';
  if (/no lobby with that code/.test(m)) return 'No se encontró ninguna sala con ese código · Confirma el código con tu amigo';
  if (/no answer/.test(m)) return 'Sala encontrada pero no responde · La red de alguno de los jugadores bloquea conexiones directas';
  if (/full/.test(m)) return 'Esta sala está llena · Prueba con otro código';
  if (/leave the lobby/.test(m)) return 'Debes salir de la sala actual primero';
  return m;
}
function setStatus(t) { lobby.status = t; const el = hud.el.panel.querySelector('#status'); if (el) el.textContent = t; }

// ---------------- screens ----------------
function settingsHTML() {
  return `<div class="settings-panel" id="settings">
    <div class="settings-header">
      <span class="settings-title"><span class="settings-icon">⚙️</span> Configuración del Sistema</span>
      <span class="settings-badge">PARÁMETROS EN VIVO</span>
    </div>
    <div class="settings-grid">
      <div class="setting-item setting-slider">
        <div class="setting-label">
          <span class="setting-icon">🎚️</span>
          <span>Sensibilidad ratón</span>
        </div>
        <div class="slider-track-wrap">
          <input type="range" class="cyber-range" id="setSens" min="25" max="250" step="5" value="${settings.sens}">
          <b class="setting-val" id="setSensV">${settings.sens}%</b>
        </div>
      </div>
      <div class="setting-item setting-toggle">
        <label class="cyber-check-label" for="setInv">
          <input type="checkbox" class="cyber-check" id="setInv" ${settings.invert ? 'checked' : ''}>
          <span class="cyber-check-box"></span>
          <span class="check-text">Invertir eje Y</span>
        </label>
      </div>
      <div class="setting-item setting-toggle">
        <label class="cyber-check-label" for="setMus">
          <input type="checkbox" class="cyber-check" id="setMus" ${musicWanted ? 'checked' : ''}>
          <span class="cyber-check-box"></span>
          <span class="check-text">Música <kbd class="kbadge-mini">M</kbd></span>
        </label>
      </div>
    </div>
  </div>`;
}
function wireSettings() {
  const box = hud.el.panel.querySelector('#settings'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const sens = box.querySelector('#setSens'), out = box.querySelector('#setSensV');
  sens.addEventListener('input', () => { settings.sens = Number(sens.value); out.textContent = settings.sens + '%'; applySettings(); });
  box.querySelector('#setInv').addEventListener('change', (e) => { settings.invert = e.target.checked; applySettings(); });
  box.querySelector('#setMus').addEventListener('change', (e) => { musicWanted = e.target.checked; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); });
}
function wireName(box) {
  const nb = box.querySelector('#setName'); if (!nb) return;
  nb.addEventListener('input', (e) => {
    myName = e.target.value.trim().slice(0, 14) || myName;
    localStorage.setItem('doodle_name', myName);
    player.name = myName;
    net.hostName = myName;
    if (net.active) {
      const lp = lobby.players.get(net.id);
      if (lp) lp.name = myName;
      if (net.isHost) broadcastLobby();
      else net.send('setname', { name: myName });
    }
  });
}
function checkpointHTML() {
  if (checkpoint < 5) return '';
  let h = '<div class="checkpoints"><span>Puntos de control</span>';
for (let w = 5; w <= checkpoint; w += 5) h += `<button type="button" data-cp="${w}">Oleada ${w}</button>`;
  return h + '</div>';
}
function wireCheckpoints(onGo) { const box = hud.el.panel.querySelector('.checkpoints'); if (!box) return; box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('button'); if (b) onGo(Number(b.dataset.cp)); }); }
const mapName = (k) => (LEVELS.find((m) => m.key === k) || LEVELS[0]).name;
function mapHTML(sel, canPick) { if (LEVELS.length < 2) return ''; return `<div class="mapsel" id="mapsel"><span>Mapa</span>${LEVELS.map((m) => `<button type="button" class="mapbtn${m.key === sel ? ' on' : ''}" data-map="${m.key}" ${canPick ? '' : 'disabled'}>${m.name}<i>${m.blurb}</i></button>`).join('')}</div>`; }
function wireMap(onPick) {
  const box = hud.el.panel.querySelector('#mapsel'); if (!box) return;
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('.mapbtn');
    if (b && !b.disabled) {
      userExplicitlyPickedMap = true;
      const k = b.dataset.map;
      const idx = LEVELS.findIndex((m) => m.key === k);
      if (idx !== -1) {
        mapRotationIndex = (idx + 1) % LEVELS.length;
        localStorage.setItem('doodle_rot_idx', String(mapRotationIndex));
      }
      onPick(k);
    }
  });
}
function wireControlsTabs(root = hud.el.panel) {
  if (!root) return;
  const ctrlBox = root.querySelector('.ctrl-box');
  if (ctrlBox) {
    ctrlBox.addEventListener('click', (e) => e.stopPropagation());
    ctrlBox.addEventListener('keydown', (e) => e.stopPropagation());
  }
  const tabs = root.querySelectorAll('.ctrl-tab');
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = tab.dataset.tab;
      root.querySelectorAll('.ctrl-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === target));
      const kbPane = root.querySelector('#ctrlPaneKb');
      const padPane = root.querySelector('#ctrlPanePad');
      if (kbPane) kbPane.classList.toggle('active', target === 'kb');
      if (padPane) padPane.classList.toggle('active', target === 'pad');
    });
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function mainHTML() {
  const curControls = getControlsHTML(input.usingGamepad ? 'pad' : 'kb');
  return `<h1>Distrito Garabato</h1><h2>Un shooter de supervivencia dibujado a mano</h2>
    <div class="mainbtns"><button type="button" class="start" id="soloBtn">Jugar en solitario<i>Un jugador · Resiste oleadas de enemigos</i></button><button type="button" id="onlineBtn">Jugar en línea<i>Todos contra todos · Hasta 10 jugadores</i></button></div>
    ${mapHTML(mapKey, true)}${curControls}${settingsHTML()}${checkpointHTML()}${best ? `<div class="beststat">Récord: ${best}</div>` : ''}`;
}
function onlineHTML() {
  return `<h1>Jugar en línea</h1><h2>Todos contra todos · Primero a ${FFA_TARGET} bajas · Hasta 10 jugadores</h2>
    <div class="online" id="online">
      <div class="row"><span>Tu apodo</span><input type="text" class="namebox" id="setName" maxlength="14" value="${esc(myName)}"></div>
      <div class="row"><button type="button" class="big" id="quickBtn">Partida rápida</button><span class="hint">Únete a una sala pública abierta; si no hay ninguna, creará una para ti</span></div>
      <div class="row split"><span>o</span></div>
      <div class="row"><button type="button" id="createBtn">Crear sala</button><div class="radio"><label><input type="radio" name="vis" value="public" ${lobby.isPublic ? 'checked' : ''}> Pública</label><label><input type="radio" name="vis" value="private" ${lobby.isPublic ? '' : 'checked'}> Privada · Solo amigos</label></div></div>
      <div class="row"><span>¿Tienes un código?</span><input type="text" id="codeBox" placeholder="CÓDIGO (ej. PUB0)" maxlength="8" autocomplete="off"><button type="button" id="joinBtn">Unirse</button></div>
      <div class="lobbylist" id="lobbylist"><div class="row"><span>Salas públicas</span><button type="button" class="alt" id="refreshBtn">Actualizar</button></div><div class="rows" id="lobbyRows">${lobbyListHTML()}</div></div>
      <div class="status" id="status">${esc(lobby.status || '')}</div>
      ${lobby.rejoinCode ? `<div class="row"><button type="button" class="big" id="rejoinBtn">Volver a unirse a ${esc(lobby.rejoinCode)}</button></div>` : ''}
      <div class="row"><button type="button" class="alt" id="backBtn">Volver</button></div>
    </div>`;
}
function lobbyHTML() {
  const rows = lobbyRows(); const host = net.isHost; const n = rows.length;
  const code = String(net.isHost ? (net.aliasCode || net.code) : (lobby.shown || net.code) || '').replace(/-\d+$/, '');
  return `<h1>Sala de Espera</h1><h2>Todos contra todos · Primero a ${FFA_TARGET} bajas</h2>
    <div class="online" id="online">
      <div class="row room-code-row">
        <span>Código de Sala:</span><span class="code">${code}</span>
        ${code === 'PUB0' ? '<span class="code-subhint" style="font-size:12px;color:var(--amber);margin-left:8px;">(número <b>0</b> cero · o usa «Partida rápida»)</span>' : ''}
        <button type="button" class="alt" id="copyLinkBtn">Copiar enlace</button>
      </div>

      <div class="room-roster-box">
        <div class="room-roster-header">
          <span class="room-roster-title">👥 Jugadores en la sala (<b id="rosterCount">${n}</b> / ${net.maxPlayers})</span>
          <span class="room-roster-badge">${n < 2 ? '⏳ Esperando que entren más jugadores…' : '✅ ' + n + ' jugadores listos para combatir'}</span>
        </div>
        <div class="room-player-grid">
          ${rows.map((p) => {
            const isHost = (p.id === lobby.hostId);
            const isMe = (p.id === net.id);
            const col = getPlayerColor(p.id);
            return `
              <div class="room-player-card${isMe ? ' me' : ''}${isHost ? ' is-host' : ''}" style="border-left: 4px solid ${col.hex}; box-shadow: 0 0 12px ${col.hex}33;">
                <div class="rpc-avatar" style="border-color: ${col.hex}; color: ${col.hex}; text-shadow: 0 0 8px ${col.hex};">
                  <span class="rpc-icon">${isHost ? '👑' : '✏️'}</span>
                </div>
                <div class="rpc-info">
                  <div class="rpc-name-row">
                    <span class="rpc-name">${esc(p.name)}</span>
                    <span class="rpc-color-pill" style="color: ${col.hex}; border: 1px solid ${col.hex}; background: ${col.hex}22;">● ${col.name}</span>
                    ${isMe ? '<span class="rpc-tag me-tag">Tú</span>' : ''}
                    ${isHost ? '<span class="rpc-tag host-tag">Anfitrión</span>' : ''}
                  </div>
                  <div class="rpc-meta">
                    <span class="rpc-status">● En la sala</span>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="row">
        <span>Tu apodo:</span>
        <input type="text" class="namebox" id="setName" maxlength="14" value="${esc(myName)}">
      </div>

      ${mapHTML(lobby.map || mapKey, host)}
      <div class="hint">${lobby.isPublic ? 'Esta sala es pública: cualquiera puede unirse por partida rápida, código o enlace directo' : 'Sala privada: comparte el código o enlace directo con tus amigos'}</div>
      <div class="row"><button type="button" class="big" id="startBtn">Comenzar partida</button><button type="button" class="alt" id="leaveBtn">Salir de la sala</button></div>
      <div class="status" id="status">${esc(lobby.status || '')}</div><div class="hint">Cualquiera puede iniciar · ${n < 2 ? 'Otros pueden unirse tras empezar' : n + ' jugadores listos'}</div>
    </div>`;
}
let lobbyList = null, listBusy = false;
function lobbyListHTML() {
  if (listBusy) return '<div class="hint">Buscando salas…</div>';
  if (!lobbyList) return '<div class="hint">Haz clic en «Actualizar» para buscar salas abiertas</div>';
  if (!lobbyList.length) return '<div class="hint">Haz clic en «Partida rápida» para unirte o abrir una sala</div>';
  return lobbyList.map((l) => `<div class="lobbyrow"><span class="code">${esc(l.code)}</span><span>Sala de ${esc(l.hostName || 'Alguien')}</span><span>${l.players}/${l.max}${l.inMatch ? ' · En partida' : ''}</span>${l.full ? '<span class="status">Llena</span>' : `<button type="button" data-join="${esc(l.code)}">Unirse</button>`}</div>`).join('');
}
async function refreshLobbies() {
  if (listBusy || net.active) return; listBusy = true; const box = hud.el.panel.querySelector('#lobbyRows'); if (box) box.innerHTML = lobbyListHTML();
  let err = null; try { lobbyList = await net.listLobbies({ name: myName }); } catch (e) { lobbyList = []; err = e; }
  listBusy = false; const rows = hud.el.panel.querySelector('#lobbyRows'); if (rows) rows.innerHTML = err ? `<div class="hint">Error al buscar: ${esc(friendlyError(err))}</div>` : lobbyListHTML();
}
function wireOnline() {
  const box = hud.el.panel.querySelector('#online'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const q = (id) => box.querySelector('#' + id); wireName(box);
  if (q('copyLinkBtn')) {
    q('copyLinkBtn').addEventListener('click', () => {
      const code = String(net.isHost ? (net.aliasCode || net.code) : (lobby.shown || net.code) || '').replace(/-\d+$/, '');
      const url = window.location.origin + window.location.pathname + '?room=' + encodeURIComponent(code);
      navigator.clipboard.writeText(url).then(() => {
        const b = q('copyLinkBtn');
        if (b) {
          b.textContent = '¡Enlace copiado!';
          b.classList.add('copied');
          setTimeout(() => { if (b) { b.textContent = 'Copiar enlace de sala'; b.classList.remove('copied'); } }, 2000);
        }
      }).catch(() => {
        prompt('Copia este enlace de la sala:', url);
      });
    });
  }

  if (q('quickBtn')) q('quickBtn').addEventListener('click', () => { lockButtons(box); quickPlay(); });
  if (q('createBtn')) q('createBtn').addEventListener('click', () => {
    lockButtons(box);
    const pub = box.querySelector('input[name=vis]:checked')?.value === 'public';
    createLobby(pub);
  });
  const codeBox = q('codeBox');
  if (codeBox) {
    codeBox.addEventListener('input', () => {
      let val = codeBox.value.toUpperCase().replace(/\s+/g, '');
      if (val === 'PUBO') val = 'PUB0';
      else if (val === 'PUBI') val = 'PUB1';
      codeBox.value = val;
    });
    codeBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') q('joinBtn')?.click(); });
  }
  if (q('joinBtn')) q('joinBtn').addEventListener('click', () => {
    let c = (q('codeBox')?.value || '').trim();
    if (!c) { setStatus('Escribe un código de sala'); return; }
    c = normalizeRoomCode(c);
    lockButtons(box); joinLobby(c);
  });
  if (q('refreshBtn')) q('refreshBtn').addEventListener('click', () => refreshLobbies());
  if (q('rejoinBtn')) q('rejoinBtn').addEventListener('click', () => { const c = lobby.rejoinCode; lobby.rejoinCode = null; lockButtons(box); joinLobby(c); });
  if (q('backBtn')) q('backBtn').addEventListener('click', () => { screen = 'main'; showStart(); });
  const rows = q('lobbyRows');
  if (rows) rows.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.join) { lockButtons(box); joinLobby(b.dataset.join); } });
  wireMap((k) => { if (net.isHost) { lobby.map = k; broadcastLobby(); } });
  if (q('startBtn')) q('startBtn').addEventListener('click', () => { if (net.isHost) hostStart(); else { net.send('startreq', {}); setStatus('Solicitando al anfitrión comenzar…'); } });
  if (q('leaveBtn')) q('leaveBtn').addEventListener('click', () => { lobby.rejoinCode = null; leaveOnline(''); });
}
function lockButtons(box) { for (const b of box.querySelectorAll('button')) if (b.id !== 'backBtn') b.disabled = true; }
function unlockButtons() { const box = hud.el.panel.querySelector('#online'); if (box) for (const b of box.querySelectorAll('button')) b.disabled = false; }
function renderLobby() { if (game.state === 'lobby') showStart(); }
function showStart() {
  hud.setGameplayVisible(false);
  if (game.state === 'lobby') screen = 'lobby';
  const html = screen === 'lobby' ? lobbyHTML() : screen === 'online' ? onlineHTML() : mainHTML();
  hud.showScreen(html);
  const p = hud.el.panel;
  wireControlsTabs(p);
  if (screen === 'main') {
    wireSettings(); wireCheckpoints((w) => beginAtWave(w)); wireMap((k) => { mapKey = k; localStorage.setItem('doodle_map', k); setLevel(k, false, true); showStart(); });
    p.querySelector('#soloBtn').addEventListener('click', (e) => { e.stopPropagation(); begin(); });
    p.querySelector('#onlineBtn').addEventListener('click', (e) => { e.stopPropagation(); screen = 'online'; showStart(); });
  } else wireOnline();
}
function showPause() {
  const curControls = getControlsHTML(input.usingGamepad ? 'pad' : 'kb');
  const mins = Math.floor(game.time / 60);
  const secs = Math.floor(game.time % 60);
  const timeStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  if (online()) {
    const title = 'Todos contra todos';
    const content = `<div class="scoreboard">${sortedScores().map(([id, s]) => `<div class="${id === net.id ? 'me' : ''}"><span>${esc(s.name)}${id === net.id ? ' (Tú)' : ''}</span><span>${s.kills} bajas · ${s.deaths} muertes</span></div>`).join('')}</div>`;
    hud.showScreen(`
      <div class="pause-modal">
        <div class="pause-header">
          <div class="pause-badge"><span class="pulse-dot"></span> // SALA EN LÍNEA · TÁCTICO //</div>
          <h1 class="pause-title">MENÚ DE SALA</h1>
          <div class="pause-meta">
            <div class="pause-chip chip-cyan"><span class="chip-icon">🌐</span><div class="chip-content"><span class="chip-label">MODO</span><span class="chip-val">${title}</span></div></div>
            <div class="pause-chip chip-code"><span class="chip-icon">🔑</span><div class="chip-content"><span class="chip-label">SALA</span><span class="chip-val">${String(net.aliasCode || net.code || '').replace(/-\d+$/, '')}</span></div></div>
          </div>
        </div>
        ${content}
        ${curControls}
        ${settingsHTML()}
        <div class="pause-actions" id="online">
          <button type="button" class="pause-btn resume-btn" id="resumeBtn"><span class="btn-icon">▶</span><span class="btn-text">Continuar partida</span></button>
          <button type="button" class="pause-btn leave-btn" id="leaveBtn"><span class="btn-icon">🚪</span><span class="btn-text">Abandonar sala</span></button>
        </div>
        <div class="pause-resume-prompt">
          <span class="prompt-pulse-icon">◆</span>
          <span>Pulsa <kbd class="kbadge kbd-primary">${hud.key('confirm')}</kbd> o haz clic para reanudar</span>
          <span class="prompt-pulse-icon">◆</span>
        </div>
      </div>
    `);
    wireSettings(); wireControlsTabs(); wireMenuBtn(); wireOnline(); return;
  }
  hud.showScreen(`
    <div class="pause-modal">
      <div class="pause-header">
        <div class="pause-badge"><span class="pulse-dot"></span> // SISTEMA EN PAUSA · CONTROL TÁCTICO //</div>
        <h1 class="pause-title">PAUSA</h1>
        <div class="pause-meta">
          <div class="pause-chip chip-wave">
            <span class="chip-icon">🌊</span>
            <div class="chip-content"><span class="chip-label">OLEADA</span><span class="chip-val">${game.wave}</span></div>
          </div>
          <div class="pause-chip chip-score">
            <span class="chip-icon">💎</span>
            <div class="chip-content"><span class="chip-label">PUNTOS</span><span class="chip-val">${game.score.toLocaleString()}</span></div>
          </div>
          <div class="pause-chip chip-kills">
            <span class="chip-icon">💀</span>
            <div class="chip-content"><span class="chip-label">BAJAS</span><span class="chip-val">${game.kills}</span></div>
          </div>
          <div class="pause-chip chip-time">
            <span class="chip-icon">⏱️</span>
            <div class="chip-content"><span class="chip-label">TIEMPO</span><span class="chip-val">${timeStr}</span></div>
          </div>
        </div>
      </div>
      ${curControls}
      ${settingsHTML()}
      ${menuBtnHTML()}
      <div class="pause-resume-prompt">
        <span class="prompt-pulse-icon">◆</span>
        <span>Pulsa <kbd class="kbadge kbd-primary">${hud.key('confirm')}</kbd> o haz clic en cualquier lugar para reanudar</span>
        <span class="prompt-pulse-icon">◆</span>
      </div>
    </div>
  `);
  wireSettings(); wireControlsTabs(); wireMenuBtn();
}
function showClickToPlay() { hud.showScreen(`<h1>Partida iniciada</h1><h2>Todos contra todos · Primero a ${FFA_TARGET} bajas</h2><div class="go">Haz clic en cualquier lugar (o pulsa ${hud.key('confirm')}) para entrar al combate</div>`); }
function showDead() {
  hud.setGameplayVisible(false); const nb = game.score > best; if (nb) { best = game.score; localStorage.setItem('doodle_best', String(best)); }
  hud.showScreen(`<h1>Borrado</h1><div class="stats">Sobreviviste a <b>${game.wave}</b> oleadas · <b>${game.kills}</b> bajas · Puntos <b>${game.score}</b>${nb ? ' · <b>¡Nuevo récord!</b>' : ` · Récord ${best}`}</div>${checkpointHTML()}${menuBtnHTML()}<div class="go">Haz clic (o pulsa ${hud.key('confirm')}) para volver a dibujar</div>`);
  wireCheckpoints((w) => beginAtWave(w)); wireMenuBtn();
}
function menuBtnHTML() {
  return `<div class="pause-actions">
    <button type="button" class="pause-btn resume-btn" id="resumeBtn">
      <span class="btn-icon">▶</span>
      <span class="btn-text">Reanudar partida</span>
    </button>
    <button type="button" class="pause-btn menu-btn" id="menuBtn">
      <span class="btn-icon">⏏</span>
      <span class="btn-text">Menú principal</span>
    </button>
  </div>`;
}
function wireMenuBtn() {
  const m = hud.el.panel.querySelector('#menuBtn');
  if (m) m.addEventListener('click', (e) => { e.stopPropagation(); toMainMenu(); });
  const r = hud.el.panel.querySelector('#resumeBtn');
  if (r) r.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!input.usingGamepad) input.requestLock();
    hud.hideScreen();
    game.menu = false;
  });
}
function toMainMenu() {
  mapRotationTimer = MAP_ROTATION_INTERVAL; mapWarn15 = false; mapWarn5 = false;
  history.replaceState(null, '', window.location.pathname); game.state = 'start'; game.mode = 'solo'; game.menu = false; setArena(false); resetGame(); audio.reelLoop(false); input.exitLock(); hud.setGameplayVisible(false); screen = 'main'; showStart();
}
function toLobbyScreen() { net.inMatch = false; for (const r of remote.values()) r.lastSeen = performance.now(); setArena(true); resetGame(); game.state = 'lobby'; game.over = null; game.menu = false; hud.setGameplayVisible(false); hud.setBoard(null); screen = 'lobby'; showStart(); }

// ---------------- run control ----------------
function resetGame() {
  mapRotationTimer = MAP_ROTATION_INTERVAL; mapWarn15 = false; mapWarn5 = false;
  if (level.breakables.some((b) => !b.alive)) setLevel(loadedKey, arenaLoaded, true);
  enemies.clear(); effects.clear(); for (const p of pickups) R.scene.remove(p.mesh); pickups.length = 0; pickupClock = 0;
  player.maxHp = online() ? 100 : 120; player.regenDelay = online() ? 4 : 4.5; player.regenRate = online() ? 14 : 11;
  player.reset(level.playerStart); player.name = myName; player.lastHitBy = null; player.lastHit = null; enemies.mods.speed = 1; enemies.mods.damage = 1; hud.setModifier(''); hud.setBoss(null, null); game.boss = null; endFocus(); game.katanaStreak = 0;
  game.score = 0; game.kills = 0; game.combo = 0; game.wave = 0; game.intermission = 0; game.queue = []; game.time = 0; game.over = null; game.matchT = 0; hud.setScore(0, 0); hud.setTimer(''); hud.setPvpScore(null); hud.setTdmScore(false, 0, 0, 0); hud.setWave(1, 0); hud.setBoard(null);
}
function beginCommon() { audio.init(); audio.resume(); if (!input.usingGamepad) input.requestLock(); if (musicWanted && !audio.musicPlaying) audio.musicOn(true); hud.hideScreen(); hud.setGameplayVisible(true); game.menu = false; }
function begin() {
  game.mode = 'solo'; setArena(false); beginCommon();
  if (game.state === 'start' || game.state === 'dead') {
    rotateStartingMap();
    resetGame();
    startWave(1);
  }
  game.state = 'play';
}
function beginAtWave(n) {
  game.mode = 'solo'; setArena(false); beginCommon();
  if (!userExplicitlyPickedMap) {
    const nextKey = getNextRotatedMapKey();
    mapKey = nextKey;
    localStorage.setItem('doodle_map', nextKey);
    setLevel(nextKey, false, true);
  }
  userExplicitlyPickedMap = false;
  mapRotationTimer = MAP_ROTATION_INTERVAL; mapWarn15 = false; mapWarn5 = false;
  resetGame(); startWave(n); game.state = 'play';
}
function jumpToWave(n) { enemies.clear(); effects.clear(); enemies.mods.speed = 1; enemies.mods.damage = 1; endFocus(); game.intermission = 0; game.queue = []; startWave(n); hud.hideScreen(); hud.setGameplayVisible(true); game.state = 'play'; game.menu = false; audio.reelLoop(false); }
function hostStart() {
  scores.clear();
  for (const [id, p] of lobby.players) scores.set(id, { name: p.name, kills: 0, deaths: 0 });

  if (!userExplicitlyPickedMap) {
    const nextKey = getNextRotatedMapKey();
    lobby.map = nextKey;
    mapKey = nextKey;
  }
  userExplicitlyPickedMap = false;
  mapRotationTimer = MAP_ROTATION_INTERVAL; mapWarn15 = false; mapWarn5 = false;

  setArena(true); const order = spawnSpots().map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const spawns = {}; [...lobby.players.keys()].forEach((id, i) => { spawns[id] = order[i % order.length]; });
  net.send('start', { spawns, map: lobby.map || mapKey, gameMode: 'ffa' });
  startMatch(false, spawns[net.id], 'ffa');
  sendScores();
}
function startMatch(late, spawnIdx, mode = 'ffa') {
  net.inMatch = true; game.mode = 'ffa'; setArena(true); resetGame(); matchLeft = FFA_TIME; clockT = 0; game.clockStarted = false;
  mapRotationTimer = MAP_ROTATION_INTERVAL; mapWarn15 = false; mapWarn5 = false;
  // nobody sends snapshots in the lobby, so the silence clock restarts here or the sweep would drop everyone
  for (const r of remote.values()) {
    r.lastSeen = performance.now();
  }
  if (!scores.size) for (const [id, p] of lobby.players) scores.set(id, { name: p.name, kills: 0, deaths: 0 });
  const spots = spawnSpots();
  player.reset(spawnIdx != null && spots[spawnIdx] ? spots[spawnIdx].clone() : arenaSpawn());
  const myColor = getPlayerColor(net.id);
  player.setTeam(myColor.name, myColor.ink);
  refreshPlayerColors();
  beginCommon(); game.state = 'play'; screen = 'lobby'; player.shieldT = 2;
  refreshScoreHud();
  hud.message('Todos contra todos', late ? 'Te uniste a una partida en curso' : 'Primero a ' + FFA_TARGET + ' bajas · ' + Math.round(FFA_TIME / 60) + ' minutos · Todos son enemigos', 3);
  hud.tip(`Mantén pulsado <b>${hud.key('score')}</b> para ver el marcador`, 5);
  // a match started by someone else's click cannot grab the mouse: ask for a click
  setTimeout(() => { if (game.state === 'play' && !input.pointerLocked && !input.usingGamepad) { game.menu = true; showClickToPlay(); } }, 250);
}
function pause() { if ((game.state !== 'play' && !(game.state === 'dying' && online())) || game.menu) return; if (!online()) game.state = 'pause'; game.menu = true; showPause(); audio.reelLoop(false); }
function resume() { if (online()) { game.menu = false; if (game.state === 'dying' && game.respawnT <= 0) game.respawnArm = input.lastActive; hud.hideScreen(); hud.setGameplayVisible(true); if (!input.usingGamepad) input.requestLock(); return; } begin(); }
Object.assign(window.__game, { startWave, updateWaves, begin, beginAtWave, jumpToWave, resetGame, spawnPickup, focusCandidate, enterFocus, pickSpawn, startMatch, createLobby, joinLobby, quickPlay, leaveOnline, hostStart });
hud.onScreenClick = () => {
  const st = game.state;
  if (st === 'over') { if (net.isHost) { net.send('backtolobby', {}); toLobbyScreen(); } return; }
  if (st === 'lobby') return;
  if (st === 'start') { if (screen === 'main') begin(); return; }
  if ((st === 'play' || st === 'dying') && game.menu) { resume(); return; }
  if (st === 'pause' || st === 'dead') resume();
};
canvas.addEventListener('click', () => { if (game.state === 'play' && !game.menu && !input.pointerLocked && !input.usingGamepad) input.requestLock(); });
input.onLockChange = (locked) => { if (!locked && (game.state === 'play' || (game.state === 'dying' && online())) && !game.menu && !input.usingGamepad) pause(); };
input.onDeviceChange = (pad) => {
  hud.setDevice(pad);
  hud.setWeapon(player.weapon.name, player.weapon.hint);
  const target = pad ? 'pad' : 'kb';
  const root = hud.el.panel;
  if (root) {
    root.querySelectorAll('.ctrl-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === target));
    const kbPane = root.querySelector('#ctrlPaneKb');
    const padPane = root.querySelector('#ctrlPanePad');
    if (kbPane) kbPane.classList.toggle('active', target === 'kb');
    if (padPane) padPane.classList.toggle('active', target === 'pad');
  }
};
window.addEventListener('pagehide', () => { if (net.active) net.leave(); });
// browsers only let audio start on a gesture; any press wakes the context if it went to sleep
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { audio.init(); audio.resume(); }, { passive: true });
hud.setDevice(input.usingGamepad); applySettings(); hud.setWeapon(player.weapon.name, player.weapon.hint); showStart();
const urlRoom = new URLSearchParams(window.location.search).get('room');
if (urlRoom) {
  const code = normalizeRoomCode(urlRoom);
  if (code) {
    screen = 'online';
    showStart();
    setStatus('Buscando anfitrión…');
    joinLobby(code);
  }
}

// ---------------- loop ----------------
let last = performance.now(), boardToggle = false, lockTipT = 0.5, musicHealT = 2;
function tick(now) { requestAnimationFrame(tick); step(now); }
// browsers starve animation frames in hidden tabs; a host that alt-tabs would freeze everyone's
// match, so a coarse timer runs extra steps (never extra frame chains) while that happens
setInterval(() => { if (net.active && performance.now() - last > 300) step(performance.now()); }, 250);
function step(now) {
  // never more than 50 ms a step: a bigger jump (a tab coming back) makes the springs in the view model fly apart
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  input.update(dt);
  const st = game.state; const playing = st === 'play' || st === 'dying';
  if (st === 'start' || st === 'pause' || st === 'dead' || st === 'over') { if (input.pressed('jump') || input.pressed('confirm') || (st === 'pause' && input.pressed('pause'))) hud.onScreenClick(); }
  else if ((st === 'play' || (st === 'dying' && online())) && input.pressed('pause')) { if (game.menu) resume(); else { pause(); input.exitLock(); } }
  else if ((st === 'play' || st === 'dying') && game.menu && (input.pressed('jump') || input.pressed('confirm'))) resume();
  if (input.pressed('music')) { musicWanted = !musicWanted; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); hud.tip(musicWanted ? 'Música activada' : 'Música desactivada', 1.5); }
  if (online() && playing) {
    if (input.usingGamepad && input.pressed('score')) boardToggle = !boardToggle;
    const want = ((input.down('score') && !input.usingGamepad) || boardToggle) && !game.menu; if (want !== !hud.el.board.hidden) hud.setBoard(want ? boardHTML() : null);
  } else boardToggle = false;
  if (st === 'play' && !game.menu && !input.pointerLocked && !input.usingGamepad) { lockTipT -= dt; if (lockTipT <= 0) { lockTipT = 2.5; hud.tip('Haz clic en la pantalla para bloquear el ratón', 2); } }
  let scale = 1;
  if (game.hitstopT > 0) { game.hitstopT -= dt; scale = game.hitstopScale; }
  else if (game.focus.active) scale = FOCUS_SCALE;
  const sdt = dt * scale;
  if (st === 'play' && !online()) updateFocus(dt); else endFocus();
  if (playing) {
    game.time += sdt; if (player.shieldT > 0) player.shieldT -= dt;
    musicHealT -= dt; if (musicHealT <= 0) { musicHealT = 2; if (musicWanted && st === 'play' && !audio.musicPlaying && audio.ctx) audio.musicOn(true); if (input.anyInput) audio.resume(); }
    { const B = level.bounds, bp = player.body.pos; if (bp.x < B.minX - 8 || bp.x > B.maxX + 8 || bp.z < B.minZ - 8 || bp.z > B.maxZ + 8 || bp.y > 150) bp.y = -100; }
    player.update(sdt); enemies.update(sdt); effects.update(sdt); updatePickups(sdt); netUpdate(dt);
    if (st === 'play' && !online()) updateWaves(sdt);
    if (online()) updateArenaPickups(dt);
    if (st === 'play' && !game.menu) {
      const isSolo = !online();
      const isHost = online() && net.active && net.isHost;
      if (isSolo || isHost) {
        mapRotationTimer -= dt;
        const nextKey = LEVELS[mapRotationIndex % LEVELS.length].key;
        const nextName = mapName(nextKey);

        if (mapRotationTimer <= 15 && !mapWarn15) {
          mapWarn15 = true;
          hud.message('🗺️ Próxima rotación de mapa', `En 15s el combate se traslada a: ${nextName}`, 4);
          if (online()) net.send('feed', { text: `🗺️ Rotación de mapa en 15s: ${nextName}` });
        } else if (mapRotationTimer <= 5 && !mapWarn5) {
          mapWarn5 = true;
          hud.tip(`⏳ Cambiando a ${nextName} en 5 segundos...`, 4.5);
        }

        if (mapRotationTimer <= 0) {
          mapRotationTimer = MAP_ROTATION_INTERVAL;
          mapWarn15 = false;
          mapWarn5 = false;
          if (online()) {
            const rotKey = getNextRotatedMapKey();
            net.send('maprot', { map: rotKey });
            applyOnlineMapRotation(rotKey);
          } else {
            rotateMapInGame();
          }
        }
      }
    }
    if (game.comboT > 0) { game.comboT -= sdt; if (game.comboT <= 0) { game.combo = 0; hud.setScore(game.score, 0); } }
    if (st === 'dying') {
      game.deathT += dt;
      if (online()) {
        const before = Math.ceil(game.respawnT); game.respawnT -= dt; const left = Math.ceil(game.respawnT);
        if (left > 0) {
          if (left !== before || game.deathT <= dt) hud.message(String(left), 'Reapareciendo pronto', 1.1);
        } else {
          respawnLocal();
        }
      }
      else if (game.deathT > 1.7) { game.state = 'dead'; showDead(); input.exitLock(); }
    }
  } else {
    game.time += dt; if (st === 'start' || st === 'dead' || st === 'lobby' || st === 'over') player.idleCam(game.time); effects.update(dt); if (net.active) netUpdate(dt);
    if (st === 'over') { game.overT += dt; if (net.isHost && game.overT > 8) { net.send('backtolobby', {}); toLobbyScreen(); } else if (!net.isHost && game.overT > 15) { toLobbyScreen(); } }
  }
  for (const a of level.animated) a.update(game.time);
  audio.setListener(player.eye, player.right);
  const w = player.weapon; if (w.isGun) hud.setAmmo(w.mag, w.reserve, w.magSize, w.reloading); else hud.setKatana();
  hud.setSlots(player.weapons.map((wp, i) => ({ name: wp.name, active: i === player.weaponIndex, ammo: wp.isGun ? wp.mag + '/' + wp.reserve : '∞', empty: wp.isGun && wp.mag === 0 && wp.reserve === 0 })));
  hud.setGrenades(player.grenades); hud.setGrappleStamina(player.grapStam); hud.setHealth(player.hp, player.maxHp); hud.setSpread(w.spreadPx); hud.update(dt);
  if (online()) hud.setFocusMeter(playing, player.grapStam, false, 'Gancho');
  else hud.setFocusMeter(playing && (w.kind === 'katana' || game.katanaStreak > 0 || game.focus.active), game.focus.active ? 1 : clamp(game.katanaStreak / KATANA_CHARGE_KILLS, 0, 1), game.focus.active, 'Espada');
  if (online() && playing) hud.updateNametags(remote, R.camera, world, player);
  else hud.clearNametags();
  if (game.boss) { if (game.boss.alive) hud.setBoss(game.boss.T.name, game.boss.hp / game.boss.maxHp); else { hud.setBoss(null, null); game.boss = null; } }
  audio.setIntensity(clamp((enemies.alive + game.queue.length + remote.size * 2) / 12, 0, 1) * (game.intermission > 0 ? 0.25 : 1));
  R.render(game.time, { hurt: player.hurtFx, flash: player.flashFx, slow: scale < 1 ? 1 : 0, lowHp: player.alive && player.hp < 30 ? 1 - player.hp / 30 : 0 });
}
requestAnimationFrame(tick);
