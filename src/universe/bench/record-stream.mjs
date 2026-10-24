#!/usr/bin/env node
// UNIVERSE phase 1.5 — record the stream, verbatim, and count what it carries.
//
// Writes every raw message of the ledger and transactions streams as one
// JSON line to a file outside the repository (the replay source of the
// acceptance check and the only source of test fixtures: a fixture is a
// recorded message, never hand-written), and beside it a histogram: every
// TransactionType with its count, split by whether the transaction was an
// inner transaction of a Batch (tfInnerBatchTxn, 0x40000000), and the
// sub-kinds the four-verb vocabulary cuts (partial payments, cross-currency
// payments, self-payments, dust, failed, trust lines set to zero, freezes,
// authorisations, brokered NFT accepts, offers placed and crossed, AccountSet
// with a Domain or a flag, …), so the thresholds in docs/universe.md are
// set on numbers. Requires Node 22+.
//
//   node src/universe/bench/record-stream.mjs [--minutes 60] [--dir C:/Users/LEET/xrpl-sonic-universe-data] [--network mainnet]
//       [--timed] [--proposed] [--validations] [--fee-every 1000] [--host wss://s1.ripple.com]
//
// With --timed every line is { at, from, msg }: the local receive time in
// milliseconds, the answering server (its endpoint, and its pubkey_node and
// hostid from server_info when it answered), and the raw message (R19 in
// docs/universe-requests.md, copied here until the shared recorder has it).
// --proposed adds the transactions_proposed stream (a superset of
// transactions: the in-flight ones have no meta and a ledger_current_index),
// --validations the validations stream, and --fee-every N polls the fee
// method every N milliseconds and records its result as a line of its own
// (msg.type "fee"). The replay feeder reads both line shapes.

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XrplStream, NETWORKS } from '../../ws.js';
import { classifyMessage, unwrapTransactionMessage, parseAmount } from '../../mapping.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const minutes = Math.max(1, Number(opt('minutes', 60)) || 60);
const timed = args.includes('--timed') || args.includes('--proposed') || args.includes('--validations') || args.includes('--fee-every');
const proposed = args.includes('--proposed');
const validations = args.includes('--validations');
const feeEvery = Math.max(0, Number(opt('fee-every', 0)) || 0);
let serverIdentity = null; // { endpoint, pubkey_node, hostid } once server_info answers
const dir = opt('dir', 'C:/Users/LEET/xrpl-sonic-universe-data');
const network = NETWORKS[opt('network', 'mainnet')];
if (!network || typeof globalThis.WebSocket !== 'function') {
  console.error('needs a known network and Node 22+');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const recordingPath = join(dir, `stream-${opt('network', 'mainnet')}-${stamp}.ndjson`);
const histogramPath = join(dir, `types-${opt('network', 'mainnet')}-${stamp}.json`);
const out = createWriteStream(recordingPath, { flags: 'w' });

const INNER = 0x40000000;
const TF_PARTIAL = 0x00020000;
const TF_SET_FREEZE = 0x00100000;
const TF_CLEAR_FREEZE = 0x00200000;
const TF_SET_DEEP_FREEZE = 0x00400000;
const TF_SETF_AUTH = 0x00010000;
const startedAt = Date.now();
let ledgers = 0;
let messages = 0;
let bytes = 0;
const seen = new Set();
const types = {}; // type → { all, inner, failed }
const kinds = {}; // sub-kind → count
const bump = (table, key, field = 'all') => {
  table[key] ??= { all: 0, inner: 0, failed: 0 };
  table[key][field] += 1;
};
const kind = (k) => (kinds[k] = (kinds[k] ?? 0) + 1);

const nodesOf = (meta) => (meta?.AffectedNodes ?? []).map((n) => ({ action: n.CreatedNode ? 'created' : n.ModifiedNode ? 'modified' : 'deleted', e: n.CreatedNode ?? n.ModifiedNode ?? n.DeletedNode }));

function count(u) {
  const tx = u.tx;
  const meta = u.meta;
  const type = tx.TransactionType;
  const flags = (Number(tx.Flags) || 0) >>> 0;
  const ok = u.result === 'tesSUCCESS';
  bump(types, type);
  if (flags & INNER) bump(types, type, 'inner');
  if (!ok) bump(types, type, 'failed');
  if (!ok) kind('failed (tec/other)');
  const nodes = nodesOf(meta);
  const entryTypes = nodes.map((n) => n.e?.LedgerEntryType);
  if (type === 'Payment') {
    const amount = parseAmount(tx.Amount ?? tx.DeliverMax);
    const delivered = parseAmount(meta?.delivered_amount);
    if (tx.Account === tx.Destination) kind('payment: self (Account = Destination)');
    if (flags & TF_PARTIAL) kind('payment: tfPartialPayment set');
    if (flags & TF_PARTIAL && delivered && amount && delivered.value < amount.value) kind('payment: delivered less than asked (partial)');
    if (amount && !amount.isXrp) kind('payment: issued currency');
    const sendMax = parseAmount(tx.SendMax);
    if (sendMax && amount && (sendMax.currency !== amount.currency || sendMax.issuer !== amount.issuer)) kind('payment: cross-currency (SendMax differs from Amount)');
    if (entryTypes.includes('Offer')) kind('payment: crossed the book (Offer nodes)');
    if (nodes.some((n) => n.e?.LedgerEntryType === 'AccountRoot' && (n.e.FinalFields ?? n.e.NewFields)?.AMMID)) kind('payment: through a pool (AMM root)');
    if (amount?.isXrp && amount.value < 1) kind('payment: dust (under 1 XRP)');
    if (nodes.some((n) => n.action === 'created' && n.e?.LedgerEntryType === 'AccountRoot')) kind('payment: funded a new account');
    if (Array.isArray(tx.Paths) && tx.Paths.length) kind('payment: with Paths');
  }
  if (type === 'TrustSet') {
    const limit = parseAmount(tx.LimitAmount);
    if (limit && limit.value === 0) kind('trustset: limit 0');
    if (flags & TF_SET_FREEZE) kind('trustset: tfSetFreeze');
    if (flags & TF_CLEAR_FREEZE) kind('trustset: tfClearFreeze');
    if (flags & TF_SET_DEEP_FREEZE) kind('trustset: tfSetDeepFreeze');
    if (flags & TF_SETF_AUTH) kind('trustset: tfSetfAuth');
    if (nodes.some((n) => n.action === 'created' && n.e?.LedgerEntryType === 'RippleState')) kind('trustset: line created');
    if (nodes.some((n) => n.action === 'deleted' && n.e?.LedgerEntryType === 'RippleState')) kind('trustset: line deleted');
  }
  if (type === 'OfferCreate') {
    if (nodes.some((n) => n.action === 'created' && n.e?.LedgerEntryType === 'Offer')) kind('offercreate: placed (Offer created)');
    const crossed = nodes.filter((n) => n.e?.LedgerEntryType === 'Offer' && (n.e.FinalFields ?? {}).Account !== tx.Account && n.e.PreviousFields);
    if (crossed.length) kind('offercreate: crossed the book');
    if (nodes.some((n) => n.e?.LedgerEntryType === 'AccountRoot' && (n.e.FinalFields ?? n.e.NewFields)?.AMMID)) kind('offercreate: through a pool');
    if (nodes.some((n) => n.action === 'deleted' && n.e?.LedgerEntryType === 'Offer' && !n.e.PreviousFields && (n.e.FinalFields ?? {}).Account !== tx.Account)) kind('offercreate: swept an untraded offer of someone else');
    if (flags & 0x00020000) kind('offercreate: tfImmediateOrCancel');
    if (flags & 0x00040000) kind('offercreate: tfFillOrKill');
    if (flags & 0x00080000) kind('offercreate: tfSell');
    if (tx.TakerGets && typeof tx.TakerGets === 'string' && typeof tx.TakerPays === 'string') kind('offercreate: XRP/XRP?');
    else if (typeof tx.TakerGets === 'string' || typeof tx.TakerPays === 'string') kind('offercreate: XRP book');
    else kind('offercreate: issued/issued book');
  }
  if (type === 'AccountSet') {
    if (typeof tx.Domain === 'string') kind('accountset: Domain set');
    if (tx.SetFlag != null) kind(`accountset: SetFlag ${tx.SetFlag}`);
    if (tx.ClearFlag != null) kind(`accountset: ClearFlag ${tx.ClearFlag}`);
    if (tx.SetFlag == null && tx.ClearFlag == null && tx.Domain == null) kind('accountset: no flag, no Domain');
  }
  if (type === 'NFTokenAcceptOffer') {
    if (tx.NFTokenSellOffer && tx.NFTokenBuyOffer) kind('nftaccept: brokered (both offers)');
    else if (tx.NFTokenSellOffer) kind('nftaccept: a sell offer');
    else if (tx.NFTokenBuyOffer) kind('nftaccept: a buy offer');
  }
  if (type === 'NFTokenCreateOffer') kind(flags & 1 ? 'nftoffer: sell' : 'nftoffer: buy');
  if (type === 'CheckCash') kind(tx.Amount ? 'checkcash: exact Amount' : 'checkcash: DeliverMin');
  if (type === 'EscrowCreate') kind(tx.FinishAfter != null ? 'escrowcreate: FinishAfter' : 'escrowcreate: no FinishAfter');
  if (type === 'AMMDeposit' || type === 'AMMWithdraw') kind(`${type.toLowerCase()}: flags 0x${(flags & 0x00ff0000).toString(16)}`);
  if (type === 'SignerListSet') kind(tx.SignerQuorum ? `signerlistset: quorum ${tx.SignerQuorum} of ${(tx.SignerEntries ?? []).length}` : 'signerlistset: removed');
  if (type === 'SetRegularKey') kind(tx.RegularKey ? 'setregularkey: set' : 'setregularkey: cleared');
  if (type === 'Batch') kind(`batch: ${(tx.RawTransactions ?? []).length} inner`);
  if (type === 'OracleSet') kind('oracleset');
  if (type === 'Clawback') kind('clawback');
  if (type === 'AccountDelete') kind('accountdelete');
  if (type === 'DepositPreauth') kind(tx.Authorize ? 'depositpreauth: authorize' : 'depositpreauth: unauthorize');
  if (type.startsWith('PaymentChannel')) kind(type.toLowerCase());
  if (type.startsWith('MPToken')) kind(type.toLowerCase());
  if (type.startsWith('Credential')) kind(type.toLowerCase());
  if (type === 'DIDSet' || type === 'DIDDelete') kind(type.toLowerCase());
}

function write(final = false) {
  const elapsed = (Date.now() - startedAt) / 60000;
  const total = Object.values(types).reduce((a, t) => a + t.all, 0);
  const rows = Object.entries(types)
    .sort((a, b) => b[1].all - a[1].all)
    .map(([type, t]) => ({ type, count: t.all, share: total ? Number((t.all / total).toFixed(4)) : 0, inner: t.inner, innerShare: t.all ? Number((t.inner / t.all).toFixed(3)) : 0, failed: t.failed }));
  writeFileSync(histogramPath, JSON.stringify({ network: opt('network', 'mainnet'), startedAt: new Date(startedAt).toISOString(), elapsedMinutes: Number(elapsed.toFixed(2)), final, recording: recordingPath, ledgers, messages, transactions: total, bytes, types: rows, kinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1])) }, null, 2));
}

const stream = new XrplStream({
  endpoints: opt('host', null) ? [opt('host', null)] : network.endpoints,
  onStatus: (s) => console.error(`[status] ${s.state} ${s.endpoint}${s.error ? ` — ${s.error}` : ''}`),
  onRaw: (text) => {
    bytes += Buffer.byteLength(text, 'utf8');
    const flat = text.replace(/\r?\n/g, ' ');
    if (timed) {
      // the raw message is kept verbatim inside the envelope (no re-serialisation), with the time and the server
      out.write(`{"at":${Date.now()},"from":${JSON.stringify(serverIdentity ?? { endpoint: stream.endpoint ?? null })},"msg":${flat}}\n`);
    } else {
      out.write(flat);
      out.write('\n');
    }
  },
  onMessage: (msg) => {
    messages += 1;
    const k = classifyMessage(msg);
    if (k === 'ledger') {
      ledgers += 1;
      return;
    }
    if (k !== 'transaction') return;
    if (msg.validated === false || (!msg.meta && !msg.metadata)) return; // in flight (transactions_proposed): not a record, not in the histogram
    const u = unwrapTransactionMessage(msg);
    if (!u) return;
    const hash = typeof u.hash === 'string' ? u.hash.toUpperCase() : null;
    if (hash) {
      if (seen.has(hash)) return;
      seen.add(hash);
    }
    count(u);
  },
});
stream.connect();
if (timed) {
  // the answering server's identity, the extra streams and the fee poll, once connected
  const onceConnected = setInterval(async () => {
    if (!stream.ws || stream.ws.readyState !== 1) return;
    clearInterval(onceConnected);
    try {
      const info = (await stream.request({ command: 'server_info' })).result?.info ?? {};
      // a rippled node names itself (hostid, pubkey_node, build_version); a Clio front-end names its versions only
      serverIdentity = { endpoint: stream.endpoint ?? null, pubkey_node: info.pubkey_node ?? null, hostid: info.hostid ?? null, build_version: info.build_version ?? null, clio_version: info.clio_version ?? null, libxrpl_version: info.libxrpl_version ?? null, rippled_version: info.rippled_version ?? null };
      console.error(`[server] ${serverIdentity.hostid ?? (serverIdentity.clio_version ? `Clio ${serverIdentity.clio_version}` : '?')} ${serverIdentity.pubkey_node ?? serverIdentity.rippled_version ?? ''}`);
    } catch (err) {
      console.error(`[server] server_info failed: ${err?.message ?? err}`);
    }
    const streams = [...(proposed ? ['transactions_proposed'] : []), ...(validations ? ['validations'] : [])];
    if (streams.length) await stream.request({ command: 'subscribe', streams }).catch((err) => console.error(`[subscribe] ${err?.message ?? err}`));
    if (feeEvery) {
      setInterval(async () => {
        try {
          const r = await stream.request({ command: 'fee' });
          const line = JSON.stringify({ type: 'fee', at: Date.now(), result: r.result });
          out.write(`{"at":${Date.now()},"from":${JSON.stringify(serverIdentity)},"msg":${line}}\n`);
        } catch {
          // a refused poll is a missing sample, not an error of the recording
        }
      }, feeEvery);
    }
  }, 250);
}
const timer = setInterval(() => {
  write(false);
  const elapsed = (Date.now() - startedAt) / 60000;
  console.error(`[${elapsed.toFixed(0)} min] ledgers ${ledgers} · tx ${seen.size} · ${(bytes / 1048576).toFixed(0)} MiB · types ${Object.keys(types).length} · kinds ${Object.keys(kinds).length}`);
  if (elapsed >= minutes) {
    clearInterval(timer);
    stream.close();
    write(true);
    out.end(() => {
      console.error(`done: ${recordingPath}\n      ${histogramPath}`);
      process.exit(0);
    });
  }
}, 5 * 60000);
process.on('SIGINT', () => {
  write(true);
  out.end(() => process.exit(0));
});
