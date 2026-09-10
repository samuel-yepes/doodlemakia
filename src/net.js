// Peer-to-peer networking over WebRTC, using the public PeerJS signalling service.
// Nothing runs on a server of ours: the host player's browser is the authority, every other
// player connects straight to it. That is what lets multiplayer work from a static Vercel deploy.
//
// Lobby codes are just peer ids. A private lobby takes a random 5 letter code; a public lobby
// claims one of a handful of well-known ids (PUB0..PUB15) so quick play can find it by knocking on
// every slot at once - a directory with no directory server. A connection only counts once the
// host has answered with a welcome, so a full or closed lobby can be skipped for the next one.

const PREFIX = 'doodledistrict-';
const PUBLIC_SLOTS = 16;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

// Public reliable STUN + TURN servers for corporate firewall & Symmetric NAT traversal
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};

// Strict controlled timeouts (maximum 8 seconds per requirements)
const JOIN_TIMEOUT = 8000, QUICK_TIMEOUT = 8000, SIGNAL_TIMEOUT = 8000;

function peerAvailable() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }
const idFromError = (err) => { const m = /peer\s+(\S+)/.exec(String(err && err.message || '')); return m ? m[1] : null; };

let _resolvedBroker = null;
export async function getBrokerConfig(forceCheck = false) {
  if (_resolvedBroker && !forceCheck) return _resolvedBroker;

  // Potential local/LAN signaling endpoints to probe (in order of priority)
  const probeCandidates = [];

  if (typeof location !== 'undefined') {
    const proto = location.protocol === 'https:' ? 'https:' : 'http:';
    const currentHost = location.hostname || 'localhost';
    const currentPort = location.port ? parseInt(location.port, 10) : (location.protocol === 'https:' ? 443 : 80);

    // 1. Current origin endpoint (if page was loaded directly from server.mjs)
    probeCandidates.push({
      label: `origen actual (${currentHost}:${currentPort})`,
      url: '/peerjs/id',
      host: currentHost,
      port: currentPort,
      secure: location.protocol === 'https:'
    });

    // 2. Current host on port 3000 (if page is running on Live Server 5500, Vite 5173, Python 8765/8910, etc.)
    if (currentPort !== 3000) {
      probeCandidates.push({
        label: `${currentHost}:3000`,
        url: `${proto}//${currentHost}:3000/peerjs/id`,
        host: currentHost,
        port: 3000,
        secure: false
      });
    }

    // 3. Localhost / 127.0.0.1 on port 3000
    if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
      probeCandidates.push({
        label: '127.0.0.1:3000',
        url: 'http://127.0.0.1:3000/peerjs/id',
        host: '127.0.0.1',
        port: 3000,
        secure: false
      });
      probeCandidates.push({
        label: 'localhost:3000',
        url: 'http://localhost:3000/peerjs/id',
        host: 'localhost',
        port: 3000,
        secure: false
      });
    } else if (currentPort !== 3000) {
      probeCandidates.push({
        label: '127.0.0.1:3000',
        url: 'http://127.0.0.1:3000/peerjs/id',
        host: '127.0.0.1',
        port: 3000,
        secure: false
      });
    }
  }

  // Probe candidates
  for (const c of probeCandidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(c.url, { signal: ctrl.signal, mode: 'cors' });
      clearTimeout(timer);
      if (res.ok) {
        _resolvedBroker = {
          host: c.host,
          port: c.port,
          path: '/',
          key: 'peerjs',
          secure: c.secure,
          debug: 1,
          config: ICE_CONFIG,
          isLocal: true
        };
        console.log(`[Net] ✅ Conectado con éxito al servidor local de señalización (${c.label}) en: ${c.host}:${c.port}`);
        return _resolvedBroker;
      }
    } catch (e) {
      // Candidate not reachable
    }
  }

  // Fallback to cloud only if no local broker found
  console.warn('[Net] ⚠️ Servidor local no detectado en puerto 3000. Probando 0.peerjs.com como respaldo…');
  _resolvedBroker = {
    debug: 0,
    config: ICE_CONFIG,
    isLocal: false
  };
  return _resolvedBroker;
}

export class Net {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false; this.id = null; this.code = null; this.hostId = null;
    this.handlers = new Map(); this.connected = false; this.onPeerJoin = null; this.onPeerLeave = null; this.onDisconnect = null;
    this.onStateChange = null; this.maxPlayers = 10; this.accepting = true; this.hostName = ''; this.stats = { sent: 0, recv: 0 };
    this.isPublic = false; this._heartbeatTimer = null; this.connectionState = '';
  }
  get active() { return !!this.peer && this.connected; }
  get peerIds() { return [...this.conns.keys()]; }
  on(type, fn) { this.handlers.set(type, fn); }
  _emit(type, data, from) { const h = this.handlers.get(type); if (h) h(data, from); }

  _setState(state, cb = null) {
    this.connectionState = state;
    if (cb) cb(state);
    if (this.onStateChange) this.onStateChange(state);
  }

  async _newPeer(id) {
    if (!peerAvailable()) throw new Error('networking library did not load');
    const opts = await getBrokerConfig();
    return new Promise((resolve, reject) => {
      let peer;
      try {
        peer = new window.Peer(id, opts);
      } catch (err) {
        return reject(err);
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { peer.destroy(); } catch (e) {}
          reject(new Error('signalling server timed out'));
        }
      }, SIGNAL_TIMEOUT);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch (e) {}
        reject(err);
      });
    });
  }

  _wire(conn) {
    conn.on('data', (msg) => {
      this.stats.recv++;
      if (!msg || typeof msg !== 'object') return;
      // WebRTC keep-alive heartbeat handling
      if (msg.t === '__ping__') {
        try { if (conn.open) conn.send({ t: '__pong__', ts: msg.ts }); } catch (e) { /* ignore */ }
        return;
      }
      if (msg.t === '__pong__') {
        conn.lastPong = Date.now();
        return;
      }
      this._route(msg, conn.peer);
    });
    conn.on('close', () => this._drop(conn.peer));
    conn.on('error', () => this._drop(conn.peer));
  }

  _drop(pid) {
    if (this.leaving || !this.conns.has(pid)) return;
    this.conns.delete(pid);
    if (this.isHost) {
      if (this.onPeerLeave) this.onPeerLeave(pid);
      this.broadcast('leave', { id: pid });
    } else if (pid === this.hostId) {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect();
    }
  }

  _route(msg, from) {
    // clients can address each other; the host forwards those
    if (this.isHost && msg.to && msg.to !== this.id) { const c = this.conns.get(msg.to); if (c && c.open) c.send(msg); return; }
    if (this.isHost && msg.relay) { for (const [pid, c] of this.conns) if (pid !== from && c.open) c.send({ t: msg.t, d: msg.d, from }); }
    this._emit(msg.t, msg.d, msg.from || from);
  }

  // broker & P2P keep-alive: automatic reconnect on broker disconnect and periodic ping/pong every 3s
  _keepAlive(peer) {
    peer.on('disconnected', () => {
      if (this.peer === peer && !peer.destroyed && !this.leaving) {
        try { peer.reconnect(); } catch (e) { /* ignore */ }
      }
    });
    peer.on('close', () => {
      if (this.peer === peer && !this.leaving) {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
      }
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this.connected && !this.isHost) return;
      // Reconnect to PeerJS broker if disconnected without breaking session
      if (this.peer && this.peer.disconnected && !this.peer.destroyed && !this.leaving) {
        try { this.peer.reconnect(); } catch (e) { /* ignore */ }
      }
      // Send keepalive ping to all active peer connections
      for (const conn of this.conns.values()) {
        if (conn && conn.open) {
          try { conn.send({ t: '__ping__', ts: Date.now() }); } catch (e) { /* ignore */ }
        }
      }
    }, 3000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ---- lobby creation / joining ----
  async host({ isPublic = false, code = null } = {}) {
    this.leave(); this.isHost = true; this.isPublic = isPublic;
    this._setState('Iniciando sala…');
    if (code) {
      this.code = String(code).toUpperCase();
      this.peer = await this._newPeer(PREFIX + this.code);
    } else if (isPublic) {
      for (let slot = 0; slot < PUBLIC_SLOTS; slot++) {
        try {
          this.peer = await this._newPeer(PREFIX + 'PUB' + slot);
          this.code = 'PUB' + slot;
          break;
        } catch (e) {
          if (e && e.type === 'unavailable-id') {
            continue;
          }
          // If the signaling server timed out or failed to connect, don't loop through 16 slots!
          throw e;
        }
      }
      // If all public slots are busy, seamlessly generate a room code so user is never blocked
      if (!this.peer) {
        this.code = makeCode();
        this.peer = await this._newPeer(PREFIX + this.code);
      }
    } else {
      for (let tries = 0; tries < 5 && !this.peer; tries++) {
        this.code = makeCode();
        try {
          this.peer = await this._newPeer(PREFIX + this.code);
        } catch (e) {
          if (!(e && e.type === 'unavailable-id') || tries === 4) throw e;
        }
      }
    }
    this.id = this.peer.id; this.hostId = this.id; this.connected = true; this.accepting = true;
    this.peer.on('connection', (conn) => this._incoming(conn));
    this._keepAlive(this.peer);
    this._startHeartbeat();
    this._setState('Conectado');
    return this.code;
  }

  // someone knocking: a quick-play probe is told how full we are and only seated once it says it is staying
  _incoming(conn) {
    conn.on('open', () => {
      if (!this.accepting || this.conns.size >= this.maxPlayers - 1) {
        conn.send({
          t: 'refused',
          d: {
            reason: this.accepting ? 'La sala está llena' : 'La sala está cerrada',
            code: this.aliasCode || this.code,
            players: this.conns.size + 1,
            max: this.maxPlayers,
            inMatch: !!this.inMatch,
            hostName: this.hostName
          }
        });
        setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 600);
        return;
      }
      const seat = () => {
        if (this.conns.has(conn.peer)) return;
        this.conns.set(conn.peer, conn);
        this._wire(conn);
        if (this.onPeerJoin) this.onPeerJoin(conn.peer, conn.metadata || {});
      };
      const welcome = {
        hostId: this.id,
        code: this.aliasCode || this.code,
        isPublic: this.isPublic,
        players: this.conns.size + 1,
        max: this.maxPlayers,
        inMatch: !!this.inMatch,
        hostName: this.hostName,
        lobby: this.getLobbyInfo ? this.getLobbyInfo() : null
      };
      if (conn.metadata && conn.metadata.probe) {
        conn.send({ t: 'welcome', d: welcome, from: this.id });
        const onData = (msg) => { if (msg && msg.t === 'stay') { conn.off('data', onData); seat(); } };
        conn.on('data', onData);
      } else {
        conn.send({ t: 'welcome', d: welcome, from: this.id });
        seat();
      }
    });
  }

  claimAlias(code, tries = 20) {
    if (!this.isHost || this.alias || this._aliasTimer) return;
    const attempt = async () => {
      this._aliasTimer = null; if (!this.isHost || this.alias) return;
      try {
        const peer = await this._newPeer(PREFIX + code);
        if (!this.isHost) { peer.destroy(); return; }
        this.alias = peer; this.aliasCode = code;
        peer.on('connection', (conn) => this._incoming(conn));
        if (this.onAlias) this.onAlias(code);
      } catch (e) {
        if (--tries > 0) this._aliasTimer = setTimeout(attempt, 6000);
      }
    };
    this._aliasTimer = setTimeout(attempt, 1500);
  }

  async join(code, meta = {}, onStatus = null) {
    this.leave(); this.isHost = false; code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('Ingresa un código de sala');
    this._setState('Buscando anfitrión…', onStatus);
    this.peer = await this._newPeer(null);
    this.id = this.peer.id; this._keepAlive(this.peer);

    // a lobby that changed hosts lives on a generation code; the plain code still finds it
    const base = code.replace(/-\d+$/, '');
    const ids = [code, ...['-1', '-2', '-3'].map((suf) => base + suf).filter((c) => c !== code)].map((c) => PREFIX + c);
    let res;
    try {
      res = await this._knockAny(ids, meta, JOIN_TIMEOUT, onStatus);
    } catch (e) {
      this.leave();
      throw e;
    }
    const { hostId, conn, welcome } = res;
    this._adopt(hostId, conn, welcome);
    this._startHeartbeat();
    this.code = (welcome && welcome.code) || hostId.slice(PREFIX.length);
    this._setState('Conectado', onStatus);
    return this.code;
  }

  // try every public slot at the same time and take the first host that says welcome
  async quickJoin(meta = {}, onStatus = null) {
    this.leave(); this.isHost = false;
    this._setState('Buscando anfitrión…', onStatus);
    this.peer = await this._newPeer(null); this.id = this.peer.id; this._keepAlive(this.peer);
    this._setState('Negociando WebRTC…', onStatus);
    const ids = []; for (let i = 0; i < PUBLIC_SLOTS; i++) for (const suf of ['', '-1', '-2', '-3']) ids.push(PREFIX + 'PUB' + i + suf);
    const winner = await new Promise((resolve) => {
      let pending = ids.length, done = false; const attempts = [], offers = []; let gather = null;
      const pick = () => { if (!offers.length) return null; offers.sort((a, b) => (b.welcome.players || 0) - (a.welcome.players || 0)); return offers[0]; };
      const settle = () => {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(gather);
        this.peer.off('error', onErr); const val = pick();
        for (const a of attempts) {
          if (!val || a.conn !== val.conn) { try { a.conn.close(); } catch (e) {} }
          else if (a.onData) { try { a.conn.off('data', a.onData); } catch (e) {} }
        }
        resolve(val);
      };
      const failOne = (a) => { if (a.done) return; a.done = true; pending--; if (pending <= 0) settle(); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a); } };
      this.peer.on('error', onErr);
      const timer = setTimeout(settle, QUICK_TIMEOUT);
      const probeMeta = { ...meta, probe: true };
      for (const hostId of ids) {
        let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: probeMeta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false, onData: null }; attempts.push(a);
        const onData = (msg) => {
          if (!msg || a.done) return;
          if (msg.t === 'welcome') {
            a.done = true; pending--; offers.push({ conn, hostId, welcome: msg.d });
            this._setState(`Se encontraron ${offers.length} salas abiertas…`, onStatus);
            if (pending <= 0) settle(); else if (!gather) gather = setTimeout(settle, 1200);
          } else if (msg.t === 'refused') failOne(a);
        };
        a.onData = onData;
        conn.on('data', onData);
        conn.on('error', () => failOne(a)); conn.on('close', () => failOne(a));
      }
      if (pending <= 0) settle();
    });
    if (!winner) { this.leave(); throw new Error('no open public lobbies'); }
    this._setState('Sincronizando estado…', onStatus);
    winner.conn.send({ t: 'stay' });
    this._adopt(winner.hostId, winner.conn, winner.welcome);
    this._startHeartbeat();
    this.code = (winner.welcome && winner.welcome.code) || winner.hostId.slice(PREFIX.length);
    this._setState('Conectado', onStatus);
    return this.code;
  }

  async listLobbies(meta = {}, onStatus = null) {
    if (this.active) throw new Error('leave the lobby first');
    const peer = await this._newPeer(null);
    const ids = []; for (let i = 0; i < PUBLIC_SLOTS; i++) for (const suf of ['', '-1', '-2', '-3']) ids.push(PREFIX + 'PUB' + i + suf);
    const found = await new Promise((resolve) => {
      let pending = ids.length, done = false; const attempts = [], offers = []; let gather = null;
      const settle = () => {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(gather);
        peer.off('error', onErr);
        for (const a of attempts) { try { a.conn.close(); } catch (e) { /* ignore */ } }
        resolve(offers);
      };
      const failOne = (a) => { if (a.done) return; a.done = true; pending--; if (pending <= 0) settle(); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a); } };
      peer.on('error', onErr);
      const timer = setTimeout(settle, QUICK_TIMEOUT);
      const probeMeta = { ...meta, probe: true };
      for (const hostId of ids) {
        let conn; try { conn = peer.connect(hostId, { reliable: true, serialization: 'json', metadata: probeMeta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => {
          if (!msg || a.done) return;
          if (msg.t === 'welcome' || msg.t === 'refused') {
            a.done = true; pending--; const d = msg.d || {};
            offers.push({ id: hostId.slice(PREFIX.length), code: d.code || hostId.slice(PREFIX.length), players: d.players || 0, max: d.max || 10, inMatch: !!d.inMatch, hostName: d.hostName || '', full: msg.t === 'refused' });
            if (onStatus) onStatus(`Se encontraron ${offers.length}…`);
            if (pending <= 0) settle(); else if (!gather) gather = setTimeout(settle, 1800);
          }
        });
        conn.on('error', () => failOne(a)); conn.on('close', () => failOne(a));
      }
      if (pending <= 0) settle();
    });
    try { peer.destroy(); } catch (e) { /* ignore */ }
    const byCode = new Map();
    for (const o of found) {
      const k = o.code.replace(/-\d+$/, '');
      const prev = byCode.get(k);
      if (!prev || o.players > prev.players) byCode.set(k, { ...o, code: k });
    }
    return [...byCode.values()].sort((a, b) => b.players - a.players);
  }

  _knockAny(ids, meta, timeoutMs, onStatus = null) {
    return new Promise((resolve, reject) => {
      let pending = ids.length, done = false, lastErr = null; const attempts = [];
      const finish = (err, val) => {
        if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr);
        for (const a of attempts) if (!val || a.conn !== val.conn) { try { a.conn.close(); } catch (e) { /* ignore */ } }
        if (val) resolve(val); else reject(err || new Error('no lobby with that code'));
      };
      const failOne = (a, err) => {
        if (a.done) return; a.done = true;
        if (err && !/no lobby/.test(String(err.message))) lastErr = err;
        pending--;
        if (pending <= 0) finish(lastErr || new Error('no lobby with that code'));
      };
      const onErr = (err) => {
        if (err && err.type === 'peer-unavailable') {
          const a = attempts.find((x) => x.hostId === idFromError(err));
          if (a) failOne(a, new Error('no lobby with that code'));
        }
      };
      this.peer.on('error', onErr);
      const timer = setTimeout(() => finish(new Error('La sala no responde o está llena (tiempo de espera agotado)')), timeoutMs);

      this._setState('Negociando WebRTC…', onStatus);

      for (const hostId of ids) {
        let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: meta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        const onData = (msg) => {
          if (!msg || a.done) return;
          if (msg.t === 'welcome') {
            a.done = true;
            try { conn.off('data', onData); } catch (e) {}
            this._setState('Sincronizando estado…', onStatus);
            finish(null, { hostId, conn, welcome: msg.d });
          } else if (msg.t === 'refused') {
            try { conn.off('data', onData); } catch (e) {}
            failOne(a, new Error(msg.d && msg.d.reason || 'La sala rechazó la conexión'));
          }
        };
        conn.on('data', onData);
        conn.on('error', (e) => failOne(a, e instanceof Error ? e : new Error('Error al negociar WebRTC')));
        conn.on('close', () => failOne(a, null));
      }
      if (pending <= 0) finish(lastErr || new Error('no lobby with that code'));
    });
  }

  _adopt(hostId, conn, welcome) {
    this.hostId = hostId; this.conns.set(hostId, conn); this.connected = true;
    this.isPublic = !!(welcome && welcome.isPublic); this._wire(conn);
    if (this.onAdopt) this.onAdopt(hostId, welcome);
  }

  leave() {
    this.leaving = true;
    this._stopHeartbeat();
    clearTimeout(this._aliasTimer); this._aliasTimer = null;
    if (this.alias) { try { this.alias.destroy(); } catch (e) { /* ignore */ } }
    this.alias = null; this.aliasCode = null;
    for (const c of this.conns.values()) { try { c.close(); } catch (e) { /* ignore */ } }
    this.conns.clear();
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
    this.peer = null; this.connected = false; this.isHost = false; this.id = null; this.code = null; this.hostId = null;
    this.connectionState = '';
    this.leaving = false;
  }

  // ---- messaging ----
  send(type, data, relay = false) {
    this.stats.sent++;
    if (this.isHost) {
      const m = { t: type, d: data, from: this.id };
      for (const c of this.conns.values()) if (c.open) c.send(m);
    } else {
      const c = this.conns.get(this.hostId);
      if (c && c.open) c.send({ t: type, d: data, relay });
    }
  }
  broadcast(type, data) { this.send(type, data, true); }
  sendTo(pid, type, data) {
    this.stats.sent++;
    if (this.isHost) {
      const c = this.conns.get(pid);
      if (c && c.open) c.send({ t: type, d: data, from: this.id });
    } else {
      const c = this.conns.get(this.hostId);
      if (c && c.open) c.send({ t: type, d: data, to: pid, from: this.id });
    }
  }
}
