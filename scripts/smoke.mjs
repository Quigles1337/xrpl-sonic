#!/usr/bin/env node
// Smoke test: connect to a public XRPL node with the same client the browser
// uses, wait for one ledger close and a handful of transactions, print what
// they would sound like, and exit. Requires Node 22+ (global WebSocket).
//
//   node scripts/smoke.mjs            # mainnet
//   node scripts/smoke.mjs testnet    # testnet
//   TIMEOUT_MS=30000 node scripts/smoke.mjs

import { XrplStream, NETWORKS } from '../src/ws.js';
import { txToEvent, ledgerToEvent, classifyMessage } from '../src/mapping.js';

if (typeof globalThis.WebSocket !== 'function') {
  console.error('This smoke test needs a global WebSocket (Node 22+).');
  process.exit(2);
}

const network = NETWORKS[process.argv[2] ?? 'mainnet'];
if (!network) {
  console.error(`Unknown network "${process.argv[2]}". Use mainnet or testnet.`);
  process.exit(2);
}
const timeoutMs = Number(process.env.TIMEOUT_MS) || 20000;
const wantTx = Number(process.env.WANT_TX) || 5;

let ledgers = 0;
let txs = 0;
let done = false;

const finish = (code, reason) => {
  if (done) return;
  done = true;
  stream.close();
  console.log(`\n${reason}: ${ledgers} ledger close(s), ${txs} transaction(s)`);
  process.exit(code);
};

const stream = new XrplStream({
  endpoints: network.endpoints,
  onStatus: (s) => console.log(`[status] ${s.state} ${s.endpoint}${s.error ? ` — ${s.error}` : ''}`),
  onMessage: (msg) => {
    const kind = classifyMessage(msg);
    if (kind === 'response' && msg.result?.ledger_index) {
      console.log(`[subscribed] ledger #${msg.result.ledger_index} on ${msg.result.hostid ?? '?'}`);
      return;
    }
    if (kind === 'ledger') {
      const ev = ledgerToEvent(msg);
      ledgers += 1;
      console.log(`[ledger] ${ev.text} @ ${ev.closeTimeIso}`);
    } else if (kind === 'transaction') {
      const ev = txToEvent(msg);
      if (!ev) return;
      txs += 1;
      if (txs <= wantTx) {
        console.log(`[tx] ${ev.text}  →  ${ev.sound} ${ev.note} vel=${ev.velocity.toFixed(2)} dur=${ev.duration.toFixed(2)}s${ev.sub ? ' SUB' : ''}`);
      }
    } else if (kind === 'error') {
      console.log(`[error] ${JSON.stringify(msg)}`);
    }
    if (ledgers >= 1 && txs >= wantTx) finish(0, 'ok');
  },
});

setTimeout(() => finish(ledgers >= 1 ? 0 : 1, ledgers >= 1 ? 'ok (timeout)' : 'FAILED: no ledger close within timeout'), timeoutMs);
stream.connect();
