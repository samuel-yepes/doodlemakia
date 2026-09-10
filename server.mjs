// Embedded Game & P2P Signaling Server (Zero-Build, Anti-Firewall & Local LAN support)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// MIME Types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

// PeerJS active clients map: id -> { ws, token, lastSeen }
const clients = new Map();

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const server = http.createServer((req, res) => {
  // Universal CORS headers for all origins and ports (e.g. 5500 Live Server, 8000, 3000)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // PeerJS HTTP endpoints (/peerjs/id, /peerjs/peerjs/id, /peerjs/:key/id, /id, etc.)
  if (pathname.endsWith('/id') || pathname.includes('/id') || pathname.includes('/peerjs/id')) {
    const assignedId = crypto.randomUUID();
    console.log(`[HTTP ID] Generando ID para cliente: ${assignedId} (desde ${req.socket.remoteAddress})`);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(assignedId);
    return;
  }

  // Diagnostics and health check
  if (pathname === '/peerjs/status' || pathname === '/api/status' || pathname === '/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      status: 'online',
      serverTime: Date.now(),
      lanIp: getLanIp(),
      port: PORT,
      peersOnline: clients.size,
      activePeers: [...clients.keys()]
    }));
    return;
  }

  // Static File Serving
  let filePath = pathname;
  if (filePath.endsWith('/')) filePath += 'index.html';

  const safePath = path.normalize(path.join(__dirname, filePath));
  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso denegado');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      console.warn(`[HTTP 404] Archivo no encontrado: ${pathname}`);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Archivo no encontrado');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    fs.createReadStream(safePath).pipe(res);
  });
});

// WebSocket signaling broker compatible with PeerJS protocol v1.5+
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Accept WebSocket upgrades on /peerjs, /peerjs/peerjs, or /
  if (pathname.includes('peerjs') || pathname === '/') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = url.searchParams.get('id') || crypto.randomUUID();
      const token = url.searchParams.get('token') || '';

      // Check if ID is already in use by another active peer
      if (clients.has(id)) {
        const existing = clients.get(id);
        if (existing && existing.ws.readyState === 1 && existing.ws !== ws) {
          console.warn(`[Signaling] ID ocupado: ${id} · Rechazando conexión entrante`);
          try {
            ws.send(JSON.stringify({
              type: 'ID-TAKEN',
              payload: { msg: `ID "${id}" is taken` }
            }));
            setTimeout(() => { try { ws.close(); } catch (e) {} }, 100);
          } catch (e) {}
          return;
        }
      }

      clients.set(id, { ws, token, lastSeen: Date.now() });
      console.log(`[Signaling] ✅ Peer conectado: ${id} · Clientes activos: ${clients.size}`);

      // Handshake: PeerJS client expects { type: "OPEN" }
      try {
        ws.send(JSON.stringify({ type: 'OPEN' }));
      } catch (e) {
        console.error('[Signaling] Error al enviar OPEN:', e.message);
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Heartbeat handling
          if (msg.type === 'HEARTBEAT') {
            const c = clients.get(id);
            if (c) c.lastSeen = Date.now();
            return;
          }

          const dst = msg.dst;
          if (dst) {
            const target = clients.get(dst);
            if (target && target.ws.readyState === 1) {
              // Crucial: sender ID must be attached as msg.src so receiver knows who sent OFFER/ANSWER/CANDIDATE
              msg.src = id;
              target.ws.send(JSON.stringify(msg));
            } else {
              // PeerJS client expects EXPIRE with src: dst to trigger 'peer-unavailable'
              ws.send(JSON.stringify({
                type: 'EXPIRE',
                src: dst,
                payload: { msg: `Could not connect to peer ${dst}` }
              }));
            }
          }
        } catch (e) {
          console.error('[Signaling] Error procesando mensaje WS:', e.message);
        }
      });

      const cleanup = () => {
        if (clients.get(id)?.ws === ws) {
          clients.delete(id);
          console.log(`[Signaling] ❌ Peer desconectado: ${id} · Clientes activos: ${clients.size}`);
        }
      };

      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  } else {
    socket.destroy();
  }
});

// Heartbeat purge for inactive sockets every 15s
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > 45000 || c.ws.readyState > 1) {
      try { c.ws.terminate(); } catch (e) {}
      clients.delete(id);
    }
  }
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`
┌──────────────────────────────────────────────────────────────┐
│  🎮 DISTRITO GARABATO - SERVIDOR DE JUEGO & SEÑALIZACIÓN P2P │
├──────────────────────────────────────────────────────────────┤
│  Local:    http://localhost:${PORT}                             │
│  Red LAN:  http://${lanIp}:${PORT}                        │
│  Señal:    ws://${lanIp}:${PORT}/peerjs                   │
│  Estado:   ✅ Listo para salas multijugador sin bloqueos     │
└──────────────────────────────────────────────────────────────┘
`);
});
