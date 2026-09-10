import WebSocket from 'ws';

async function testPub0() {
  console.log('1. Conectando Host como doodledistrict-PUB0...');
  const wsHost = new WebSocket('wss://peerjs-server.onrender.com/peerjs?key=peerjs&id=doodledistrict-PUB0&token=tokhost&version=1.5.4');

  await new Promise((resolve, reject) => {
    wsHost.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'OPEN') {
        console.log('✅ Host doodledistrict-PUB0 registrado!');
        resolve();
      } else if (msg.type === 'ID-TAKEN') {
        console.log('⚠️ ID doodledistrict-PUB0 ya estaba tomado!');
        resolve();
      }
    });
    wsHost.on('error', reject);
  });

  console.log('2. Conectando Cliente con ID aleatorio...');
  const clientId = 'doodledistrict-TESTCLI' + Math.random().toString(36).slice(2, 6);
  const wsClient = new WebSocket(`wss://peerjs-server.onrender.com/peerjs?key=peerjs&id=${clientId}&token=tokcli&version=1.5.4`);

  await new Promise((resolve, reject) => {
    wsClient.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'OPEN') {
        console.log('✅ Cliente registrado como:', clientId);
        resolve();
      }
    });
    wsClient.on('error', reject);
  });

  console.log('3. Cliente enviando OFFER a doodledistrict-PUB0 (con cero)...');
  const offerToZero = new Promise((resolve) => {
    wsHost.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'OFFER') {
        console.log('✅ Host recibió OFFER correctamente de:', msg.src);
        resolve('OK');
      }
    });
    wsClient.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'EXPIRE') {
        console.log('❌ Cliente recibió EXPIRE para:', msg.src);
        resolve('EXPIRE');
      }
    });
  });

  wsClient.send(JSON.stringify({
    type: 'OFFER',
    dst: 'doodledistrict-PUB0',
    payload: { sdp: 'fake-sdp' }
  }));

  const res = await offerToZero;
  console.log('Resultado de oferta a PUB0 (con cero):', res);

  console.log('\n4. Cliente enviando OFFER a doodledistrict-PUBO (con letra O)...');
  const offerToO = new Promise((resolve) => {
    wsClient.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'EXPIRE' && msg.src === 'doodledistrict-PUBO') {
        console.log('⚠️ Confirmado: doodledistrict-PUBO (con letra O) da EXPIRE porque no existe!');
        resolve('EXPIRE_CONFIRMED');
      }
    });
  });

  wsClient.send(JSON.stringify({
    type: 'OFFER',
    dst: 'doodledistrict-PUBO',
    payload: { sdp: 'fake-sdp' }
  }));

  await offerToO;

  wsHost.close();
  wsClient.close();
  process.exit(0);
}

testPub0().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
