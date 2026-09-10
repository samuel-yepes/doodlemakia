// Automated signaling test for server.mjs
import WebSocket from 'ws';

async function test() {
  console.log('--- 1. Probando HTTP /peerjs/id en localhost ---');
  const res1 = await fetch('http://localhost:3000/peerjs/id');
  if (!res1.ok) throw new Error(`HTTP localhost falló: ${res1.status}`);
  const id1 = await res1.text();
  console.log('✅ HTTP localhost OK, ID generado:', id1);

  console.log('\n--- 2. Probando HTTP /peerjs/id en LAN IP ---');
  const res2 = await fetch('http://10.10.146.59:3000/peerjs/id');
  if (!res2.ok) throw new Error(`HTTP LAN falló: ${res2.status}`);
  const id2 = await res2.text();
  console.log('✅ HTTP LAN OK, ID generado:', id2);

  console.log('\n--- 3. Probando WebSocket para Host ---');
  const wsHost = new WebSocket('ws://localhost:3000/peerjs?key=peerjs&id=doodledistrict-PUB0&token=token1');
  await new Promise((resolve, reject) => {
    wsHost.on('open', () => console.log('Host socket conectado'));
    wsHost.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      console.log('Host recibió:', msg);
      if (msg.type === 'OPEN') resolve();
    });
    wsHost.on('error', reject);
  });
  console.log('✅ Host handshake OPEN exitoso');

  console.log('\n--- 4. Probando colisión de ID (ID-TAKEN) ---');
  const wsDuplicate = new WebSocket('ws://localhost:3000/peerjs?key=peerjs&id=doodledistrict-PUB0&token=token2');
  await new Promise((resolve, reject) => {
    wsDuplicate.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      console.log('Duplicate recibió:', msg);
      if (msg.type === 'ID-TAKEN') resolve();
    });
    wsDuplicate.on('error', reject);
  });
  console.log('✅ ID-TAKEN detectado correctamente ante duplicados');

  console.log('\n--- 5. Probando conexión de Cliente y enrutamiento con msg.src ---');
  const wsClient = new WebSocket('ws://localhost:3000/peerjs?key=peerjs&id=doodledistrict-CLIENT1&token=token3');
  await new Promise((resolve, reject) => {
    wsClient.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'OPEN') resolve();
    });
    wsClient.on('error', reject);
  });

  // Client sends OFFER to Host
  const offerPromise = new Promise((resolve) => {
    wsHost.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'OFFER') {
        console.log('Host recibió OFFER enrutado:', msg);
        if (msg.src === 'doodledistrict-CLIENT1') {
          console.log('✅ msg.src inyectado correctamente por el servidor!');
          resolve();
        }
      }
    });
  });

  wsClient.send(JSON.stringify({
    type: 'OFFER',
    dst: 'doodledistrict-PUB0',
    payload: { sdp: 'fake-sdp-test' }
  }));

  await offerPromise;

  console.log('\n--- 6. Probando EXPIRE cuando destino no existe ---');
  const expirePromise = new Promise((resolve) => {
    wsClient.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'EXPIRE' && msg.src === 'doodledistrict-INEXISTENTE') {
        console.log('✅ EXPIRE recibido con src correcto:', msg);
        resolve();
      }
    });
  });

  wsClient.send(JSON.stringify({
    type: 'OFFER',
    dst: 'doodledistrict-INEXISTENTE',
    payload: {}
  }));

  await expirePromise;

  wsHost.close();
  wsDuplicate.close();
  wsClient.close();

  console.log('\n🎉 ¡TODAS LAS PRUEBAS DE SEÑALIZACIÓN PASARON AL 100%!');
  process.exit(0);
}

test().catch((err) => {
  console.error('❌ Error en prueba:', err);
  process.exit(1);
});
