// Simulation of join with normalization
function normalizeCode(raw) {
  let code = String(raw || '').trim().toUpperCase();
  if (/^PUB[O0]$/i.test(code)) {
    code = 'PUB0';
  } else if (/^PUB[O0]-(\d+)$/i.test(code)) {
    code = code.replace(/^PUB[O0]/i, 'PUB0');
  }

  const PREFIX = 'doodledistrict-';
  const ids = [];
  if (code === 'PUB0') {
    ids.push(PREFIX + 'PUB0', PREFIX + 'PUBO');
  } else {
    ids.push(PREFIX + code);
    if (code.includes('O')) ids.push(PREFIX + code.replace(/O/g, '0'));
    if (code.includes('0')) ids.push(PREFIX + code.replace(/0/g, 'O'));
  }
  return { code, ids };
}

console.log('PUBO ->', normalizeCode('PUBO'));
console.log('pub0 ->', normalizeCode('pub0'));
console.log('PUB0 ->', normalizeCode('PUB0'));
console.log('X9O2B ->', normalizeCode('X9O2B'));
console.log('X902B ->', normalizeCode('X902B'));
