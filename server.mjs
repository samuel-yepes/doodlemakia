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
      // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const server = http.createServer((req, res) => {
  // Universal CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // PeerJS HTTP endpoints (/peerjs/id or /peerjs/:key/id)
  if (req.url.startsWith('/peerjs/id') || req.url.match(/^\/peerjs\/[^/]+\/id/)) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(crypto.randomUUID());
    return;
  }

  // Diagnostics and health check
  if (req.url === '/peerjs/status' || req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      status: 'online',
      serverTime: Date.now(),
      peersOnline: clients.size,
      activePeers: [...clients.keys()]
    }));
    return;
  }

  // Static File Serving
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const safePath = path.normalize(path.join(__dirname, pathname));
  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso denegado');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
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

// WebSocket signaling broker
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/peerjs')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = url.searchParams.get('id') || crypto.randomUUID();
      const token = url.searchParams.get('token') || '';

      // Clean up previous socket with same id if any
      const existing = clients.get(id);
      if (existing && existing.ws !== ws) {
        try { existing.ws.close(); } catch (e) {}
      }
      clients.set(id, { ws, token, lastSeen: Date.now() });

      // Signal handshake OPEN
      ws.send(JSON.stringify({ type: 'OPEN' }));

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'HEARTBEAT') {
            const c = clients.get(id);
            if (c) c.lastSeen = Date.now();
            return;
          }

          const dst = msg.dst;
          if (dst) {
            const target = clients.get(dst);
            if (target && target.ws.readyState === 1) {
              target.ws.send(JSON.stringify(msg));
            } else {
              ws.send(JSON.stringify({
                type: 'ERROR',
                payload: { msg: `Could not connect to peer ${dst}` },
                dst: msg.src,
                src: dst
              }));
            }
          }
        } catch (e) {}
      });

      const cleanup = () => {
        if (clients.get(id)?.ws === ws) {
          clients.delete(id);
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
