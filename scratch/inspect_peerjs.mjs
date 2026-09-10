import fs from 'node:fs';
const code = fs.readFileSync('./vendor/peerjs/peerjs.min.js', 'utf8');

// Find all occurrences of URL patterns or endpoints in peerjs.min.js
const idxs = [];
let pos = 0;
while ((pos = code.indexOf('/id', pos)) !== -1) {
  idxs.push(code.slice(Math.max(0, pos - 50), Math.min(code.length, pos + 50)));
  pos += 3;
}
console.log('ID occurrences:', idxs);

// Check retrieveId or similar
const retrieveIdx = code.indexOf('retrieveId');
if (retrieveIdx !== -1) {
  console.log('retrieveId:', code.slice(retrieveIdx, retrieveIdx + 200));
}

// Check how peer connects or url formation
const buildUrl = code.indexOf('buildUrl');
if (buildUrl !== -1) {
  console.log('buildUrl:', code.slice(buildUrl, buildUrl + 200));
}
