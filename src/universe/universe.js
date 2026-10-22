// UNIVERSE spike — the observed universe.
//
// What the page has seen, and nothing it has not. `Universe` takes the raw
// stream messages (ledgerClosed and transaction), keeps compact records
// (src/universe/records.js), one planet per account that appeared in a
// validated record, the edges between accounts that one transaction named
// together, and per ledger what was heard against the ledger's txn_count.
// The stream is not ordered (docs/save-this-moment.md), so a ledger's
// transactions are counted as they arrive and a ledger is closed when its
// ledgerClosed message comes; `coverage()` reports closed ledgers only and
// says how many transactions arrived for ledgers not yet closed.
//
// A planet's properties are what the record carried: its balance, flags,
// regular key, domain and AMMID from the last AccountRoot seen; the holders
// it issues to and the issuers it holds from the RippleStates seen; its open
// offers from Offer entries created and deleted; what it submitted and what
// it was involved in, by category. None of it claims completeness.
//
// Pure: no DOM, no network, no canvas.

import { unwrapTransactionMessage, extractAmount, RIPPLE_EPOCH_OFFSET } from '../mapping.js';
import { Interner, compactRecord, rootsOf, linesOf, issuerOfLine, offersOf, TYPE_CODES } from './records.js';

export const DEFAULT_MAX_RECORDS = 250000;
/** Ledgers kept for hash deduplication and coverage; the live stream trails a ledger's transactions by several ledgers, so this is generous. */
export const DEFAULT_MAX_LEDGERS = 4000;
/** The decay of a planet's activity per ledger (glow); half-life about six ledgers. */
export const ACTIVITY_DECAY = 0.89;

const HASH = /^[0-9A-F]{64}$/i;
const edgeKey = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);

export class Universe {
  constructor({ maxRecords = DEFAULT_MAX_RECORDS, maxLedgers = DEFAULT_MAX_LEDGERS } = {}) {
    this.maxRecords = maxRecords;
    this.maxLedgers = maxLedgers;
    this.addresses = new Interner();
    this.currencies = new Interner();
    this.planets = [null]; // by id; id 0 is none
    this.edges = new Map(); // edgeKey → { a, b, count, byCategory, trust, lastLedger }
    this.records = []; // ring buffer of compact records
    this.recordHead = 0;
    this.recordCount = 0;
    this.ledgers = new Map(); // index → { index, txnCount, received, closeTime, closed, hashes: Set }
    this.startedAt = null;
    this.latestClosed = null;
    this.currentLedger = null; // the highest ledger index a transaction named
    this.counts = { messages: 0, transactions: 0, dupes: 0, failed: 0, notTransactions: 0 };
  }

  get planetCount() {
    return this.planets.length - 1;
  }

  /** The planet for an address, made on first sight. */
  planet(address, ledger = null) {
    const id = this.addresses.id(address);
    if (!id) return null;
    let p = this.planets[id];
    if (!p) {
      p = {
        id,
        address,
        firstLedger: ledger,
        lastLedger: ledger,
        ledgersSeen: 0,
        lastCountedLedger: null,
        submitted: 0,
        involved: 0,
        sentPayments: 0,
        receivedPayments: 0,
        byCategory: [0, 0, 0, 0, 0, 0, 0, 0],
        activity: 0,
        balanceDrops: null,
        flags: null,
        ownerCount: null,
        regularKey: undefined, // undefined: no AccountRoot seen yet; null: seen, none set
        domain: null,
        ammId: null,
        created: false,
        deleted: false,
        holders: null, // Set of holder ids, when this planet issues
        issuers: null, // Set of issuer ids, when this planet holds
        peers: null, // Set of trust-line peer ids
        fundedPeers: null, // the peers whose line held a balance when last seen
        fundedLines: 0,
        providers: null, // Set of ids that deposited to or withdrew from this pool
        openOffers: 0,
        minted: 0,
        degree: 0,
        cadence: null, // set by the worker from coherence
      };
      this.planets[id] = p;
    }
    return p;
  }

  planetById(id) {
    return this.planets[id] ?? null;
  }

  _ledger(index, { create = false } = {}) {
    let l = this.ledgers.get(index);
    if (l || !create) return l ?? null;
    l = { index, txnCount: null, received: 0, closeTime: null, closed: false, hashes: new Set(), anonymous: 0 };
    this.ledgers.set(index, l);
    if (this.ledgers.size > this.maxLedgers) {
      const oldest = Math.min(...this.ledgers.keys());
      this.ledgers.delete(oldest);
    }
    return l;
  }

  /** A `ledgerClosed` message. Returns the ledger entry, or null when the message is not one. */
  noteLedger(msg) {
    const index = Number(msg?.ledger_index);
    if (!Number.isInteger(index) || index <= 0) return null;
    this.counts.messages += 1;
    if (this.startedAt == null) this.startedAt = Date.now();
    const l = this._ledger(index, { create: true });
    l.closed = true;
    l.txnCount = Number.isFinite(Number(msg.txn_count)) ? Number(msg.txn_count) : null;
    l.closeTime = Number.isFinite(Number(msg.ledger_time)) ? Number(msg.ledger_time) + RIPPLE_EPOCH_OFFSET : null;
    if (this.latestClosed == null || index > this.latestClosed) this.latestClosed = index;
    if (this.currentLedger == null || index > this.currentLedger) this.currentLedger = index;
    return l;
  }

  /**
   * A `transaction` message. Returns what changed, for the layout and the
   * sky: the record, the planets made by it, every planet it touched, the
   * edges it strengthened, and the roots and lines it carried. Null when
   * the message is not a transaction or was heard before.
   */
  noteTransaction(msg) {
    this.counts.messages += 1;
    const u = unwrapTransactionMessage(msg);
    if (!u) {
      this.counts.notTransactions += 1;
      return null;
    }
    if (this.startedAt == null) this.startedAt = Date.now();
    const given = Number(u.ledgerIndex);
    const ledger = Number.isInteger(given) && given > 0 ? given : this.currentLedger;
    if (ledger == null) return null;
    if (this.currentLedger == null || ledger > this.currentLedger) this.currentLedger = ledger;
    const l = this._ledger(ledger, { create: true });
    const hash = typeof u.hash === 'string' && HASH.test(u.hash) ? u.hash.toUpperCase() : null;
    if (hash) {
      if (l.hashes.has(hash)) {
        this.counts.dupes += 1;
        return null;
      }
      l.hashes.add(hash);
    } else l.anonymous += 1;
    l.received += 1;
    this.counts.transactions += 1;
    const rec = compactRecord(u.tx, u.meta, { hash, ledgerIndex: ledger, result: u.result, amount: extractAmount(u.tx, u.meta), interner: this.addresses, currencies: this.currencies });
    if (!rec.success) this.counts.failed += 1;
    this._keep(rec);

    const newPlanets = [];
    const touched = new Set();
    const touch = (id, { submitter = false } = {}) => {
      if (!id) return null;
      const before = this.planets[id];
      const p = this.planet(this.addresses.string(id), ledger);
      if (!before) newPlanets.push(id);
      if (!touched.has(id)) {
        touched.add(id);
        p.involved += 1;
        p.byCategory[rec.category] += 1;
        if (p.lastCountedLedger !== ledger) {
          p.ledgersSeen += 1;
          p.lastCountedLedger = ledger;
        }
        const age = p.lastLedger == null ? 0 : Math.max(0, ledger - p.lastLedger);
        p.activity = p.activity * ACTIVITY_DECAY ** age + 1;
        if (p.lastLedger == null || ledger > p.lastLedger) p.lastLedger = ledger;
        if (p.firstLedger == null || ledger < p.firstLedger) p.firstLedger = ledger;
      }
      if (submitter) p.submitted += 1;
      return p;
    };
    const sender = touch(rec.account, { submitter: true });
    const dest = touch(rec.destination);
    for (const id of rec.entries) touch(id);
    for (const id of rec.lines) touch(id);
    if (rec.type === TYPE_CODES.Payment && rec.success) {
      if (sender) sender.sentPayments += 1;
      if (dest) dest.receivedPayments += 1;
    }
    if (rec.type === TYPE_CODES.NFTokenMint && rec.success && sender) sender.minted += 1;

    // the roots: balance, flags, key, domain, AMMID, birth and collapse
    const roots = rootsOf(u.meta);
    for (const r of roots) {
      const p = this.planet(r.address, ledger);
      if (!touched.has(p.id)) touch(p.id);
      if (r.balance != null) p.balanceDrops = r.balance;
      p.flags = r.flags;
      p.ownerCount = r.ownerCount;
      p.regularKey = r.regularKey;
      if (r.domain) p.domain = r.domain;
      if (r.ammId) p.ammId = r.ammId;
      if (r.action === 'created') p.created = true;
      if (r.action === 'deleted') p.deleted = true;
    }
    // the lines: who issues to whom, rings for both
    const lines = linesOf(u.meta);
    for (const line of lines) {
      const low = this.planet(line.low, ledger);
      const high = this.planet(line.high, ledger);
      (low.peers ??= new Set()).add(high.id);
      (high.peers ??= new Set()).add(low.id);
      const side = issuerOfLine(line);
      if (side) {
        const issuer = this.planet(side.issuer, ledger);
        const holder = this.planet(side.holder, ledger);
        (issuer.holders ??= new Set()).add(holder.id);
        (holder.issuers ??= new Set()).add(issuer.id);
        this._edge(issuer.id, holder.id, rec.category, ledger, { trust: true });
      }
      // a funded ring is a line whose balance is not zero, as last seen; deleted or emptied, it is no longer funded
      const funded = line.balance !== 0 && line.action !== 'deleted';
      for (const [p, peer] of [[low, high], [high, low]]) {
        p.fundedPeers ??= new Set();
        if (funded) p.fundedPeers.add(peer.id);
        else p.fundedPeers.delete(peer.id);
        p.fundedLines = p.fundedPeers.size;
      }
    }
    // the offers: open ones per owner, from entries created and deleted
    for (const o of offersOf(u.meta)) {
      const p = this.planet(o.owner, ledger);
      if (o.action === 'created') p.openOffers += 1;
      else if (o.action === 'deleted') p.openOffers = Math.max(0, p.openOffers - 1);
    }
    // a pool's providers
    if ((rec.type === TYPE_CODES.AMMDeposit || rec.type === TYPE_CODES.AMMWithdraw || rec.type === TYPE_CODES.AMMCreate) && sender) {
      for (const r of roots) {
        if (r.ammId) {
          const pool = this.planet(r.address, ledger);
          (pool.providers ??= new Set()).add(sender.id);
        }
      }
    }
    // the edges: the submitter with everyone the record named beside it
    const edges = [];
    if (rec.account) {
      const others = new Set([rec.destination, ...rec.entries, ...rec.lines].filter((id) => id && id !== rec.account));
      for (const id of others) edges.push(this._edge(rec.account, id, rec.category, ledger));
    }
    return { record: rec, ledger, newPlanets, touched: [...touched], edges, roots, lines };
  }

  _edge(a, b, category, ledger, { trust = false } = {}) {
    if (!a || !b || a === b) return null;
    const key = edgeKey(a, b);
    let e = this.edges.get(key);
    if (!e) {
      e = { a: Math.min(a, b), b: Math.max(a, b), count: 0, byCategory: [0, 0, 0, 0, 0, 0, 0, 0], trust: false, firstLedger: ledger, lastLedger: ledger };
      this.edges.set(key, e);
      this.planets[a].degree += 1;
      this.planets[b].degree += 1;
    }
    e.count += 1;
    e.byCategory[category] += 1;
    if (trust) e.trust = true;
    e.lastLedger = ledger;
    return e;
  }

  edge(a, b) {
    return this.edges.get(edgeKey(a, b)) ?? null;
  }

  _keep(rec) {
    if (this.records.length < this.maxRecords) this.records.push(rec);
    else {
      this.records[this.recordHead] = rec;
      this.recordHead = (this.recordHead + 1) % this.maxRecords;
    }
    this.recordCount += 1;
  }

  /** The records heard, oldest first. */
  *eachRecord() {
    const n = this.records.length;
    for (let i = 0; i < n; i++) yield this.records[(this.recordHead + i) % n];
  }

  /**
   * What has been observed: closed ledgers, transactions heard for them
   * against their txn_count, planets, and what arrived for ledgers whose
   * close has not. The line on screen is made from this and nothing else.
   */
  coverage(now = Date.now()) {
    const closed = [...this.ledgers.values()].filter((l) => l.closed).sort((x, y) => x.index - y.index);
    let expected = 0;
    let received = 0;
    let known = 0;
    for (const l of closed) {
      if (l.txnCount == null) continue;
      known += 1;
      expected += l.txnCount;
      received += Math.min(l.received, l.txnCount);
    }
    const provisional = [...this.ledgers.values()].filter((l) => !l.closed).reduce((a, l) => a + l.received, 0);
    return {
      startedAt: this.startedAt,
      minutes: this.startedAt == null ? 0 : (now - this.startedAt) / 60000,
      ledgersClosed: closed.length,
      ledgersWithCount: known,
      firstLedger: closed[0]?.index ?? null,
      lastLedger: closed.at(-1)?.index ?? null,
      expected,
      received,
      share: expected ? received / expected : null,
      provisional,
      transactions: this.counts.transactions,
      dupes: this.counts.dupes,
      failed: this.counts.failed,
      planets: this.planetCount,
      edges: this.edges.size,
      records: this.records.length,
    };
  }
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * The coverage line: what the page has seen, said plainly, never a claim
 * about the ledger. "Observed 12 min · 183 ledgers (#107,900,001–#107,900,183) ·
 * 27,412 of 27,420 transactions (99.97%) · 15,207 planets · xrplcluster.com".
 */
export function coverageLine(c, { host = '', synthetic = false, state = 'connected' } = {}) {
  if (synthetic) return `Synthetic sky: ${fmt(c.planets)} planets and ${fmt(c.transactions)} made-up transactions for measuring. Nothing here is the ledger.`;
  if (!c || !c.ledgersClosed) {
    if (state === 'connected') return `Observed nothing yet: waiting for the first ledger to close${host ? ` on ${host}` : ''}. The sky shows only what this page hears.`;
    return `Not connected${host ? ` (${host}: ${state})` : ''}. The sky shows only what this page hears.`;
  }
  const span = c.firstLedger === c.lastLedger ? `#${fmt(c.firstLedger)}` : `#${fmt(c.firstLedger)}–#${fmt(c.lastLedger)}`;
  const minutes = c.minutes < 1 ? `${Math.round(c.minutes * 60)} s` : `${Math.round(c.minutes)} min`;
  const share = c.share == null ? 'txn_count unknown' : `${(c.share * 100).toFixed(c.share >= 0.9995 ? 2 : 1)}%`;
  const pending = c.provisional ? ` · ${fmt(c.provisional)} more for ledgers not yet closed` : '';
  return `Observed ${minutes} · ${fmt(c.ledgersClosed)} ledgers (${span}) · ${fmt(c.received)} of ${fmt(c.expected)} transactions (${share})${pending} · ${fmt(c.planets)} planets from the stream${host ? ` · ${host}` : ''}. This is what the page has heard, not the ledger.`;
}
