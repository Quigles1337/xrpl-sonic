// UNIVERSE spike — a synthetic stream for measuring.
//
// Frame time at 1k, 5k and 20k planets cannot wait for the live stream to
// reach 20k planets, so a seeded generator makes stream-shaped messages
// (ledgerClosed and transaction, with AccountRoot nodes in the metadata)
// over a preferential-attachment graph: most planets have a few
// counterparties, a few have hundreds, as the real stream does. The page
// marks a synthetic sky as such on the coverage line and never mixes it
// with the live one. Deterministic for a seed.
//
// Pure: no DOM, no network.

const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/** mulberry32, the seeded generator the coherence tests use (src/coherence.js seededRandom); copied so this module stands alone. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A made-up but well-formed r-address (base58 alphabet, 25–34 characters after the r). */
export function fakeAddress(rand) {
  const n = 25 + Math.floor(rand() * 9);
  let s = 'r';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

const hex64 = (rand) => {
  let s = '';
  for (let i = 0; i < 64; i++) s += '0123456789ABCDEF'[Math.floor(rand() * 16)];
  return s;
};

export class SyntheticStream {
  /**
   * @param {{ planets: number, seed?: number, perLedger?: number, startLedger?: number }} options
   *   `planets` are made over the first ledgers (a tenth per ledger) and then kept busy at `perLedger` transactions per ledger.
   */
  constructor({ planets = 1000, seed = 1337, perLedger = 150, startLedger = 90000000 } = {}) {
    this.rand = seeded(seed);
    this.target = planets;
    this.perLedger = perLedger;
    this.ledger = startLedger;
    this.accounts = [];
    this.urn = []; // ids repeated by degree, for preferential attachment
    this.balances = [];
    this.time = 800000000;
  }

  _newAccount() {
    const id = this.accounts.length;
    this.accounts.push(fakeAddress(this.rand));
    // balances over five decades, log-uniform
    this.balances.push(Math.round(10 ** (6 + this.rand() * 6)));
    this.urn.push(id);
    return id;
  }

  _pick() {
    return this.urn[Math.floor(this.rand() * this.urn.length)];
  }

  _payment(from, to, index) {
    const amount = String(Math.round(10 ** (3 + this.rand() * 8)));
    const fee = 12;
    this.balances[from] = Math.max(10000000, this.balances[from] - Number(amount) - fee);
    this.balances[to] += Number(amount);
    this.urn.push(from, to);
    return {
      type: 'transaction',
      engine_result: 'tesSUCCESS',
      ledger_index: this.ledger,
      hash: hex64(this.rand),
      validated: true,
      transaction: { TransactionType: 'Payment', Account: this.accounts[from], Destination: this.accounts[to], Amount: amount, Fee: String(fee), Sequence: 1 + index, Flags: 0 },
      meta: {
        TransactionIndex: index,
        TransactionResult: 'tesSUCCESS',
        delivered_amount: amount,
        AffectedNodes: [
          { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: this.accounts[from], Balance: String(this.balances[from]), Flags: 0, OwnerCount: 0, Sequence: 2 + index } } },
          { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: this.accounts[to], Balance: String(this.balances[to]), Flags: 0, OwnerCount: 0, Sequence: 1 } } },
        ],
      },
    };
  }

  /** The next ledger's messages: its transactions first, then its ledgerClosed (the stream often does the same). */
  nextLedger() {
    const out = [];
    const births = this.accounts.length < this.target ? Math.min(this.target - this.accounts.length, Math.max(1, Math.ceil(this.target / 10))) : 0;
    let index = 0;
    for (let i = 0; i < births; i++) {
      const to = this._newAccount();
      let from = this.accounts.length > 1 ? this._pick() : to;
      if (from === to && this.accounts.length > 1) from = to - 1; // a newborn is always paid by someone
      if (from !== to) out.push(this._payment(from, to, index++));
    }
    // the first account was born with nobody to pay it; it gets its first record as soon as a second exists
    if (this.accounts.length >= 2 && !this.seededFirst) {
      this.seededFirst = true;
      out.push(this._payment(1, 0, index++));
    }
    const n = births ? Math.min(this.perLedger, 30) : this.perLedger;
    for (let i = 0; i < n && this.accounts.length > 1; i++) {
      const from = this._pick();
      let to = this._pick();
      if (to === from) to = (to + 1) % this.accounts.length;
      out.push(this._payment(from, to, index++));
    }
    this.time += 4;
    out.push({ type: 'ledgerClosed', ledger_index: this.ledger, ledger_hash: hex64(this.rand), ledger_time: this.time, txn_count: index, fee_base: 10, reserve_base: 1000000, reserve_inc: 200000, validated_ledgers: `${this.ledger - 1000}-${this.ledger}` });
    this.ledger += 1;
    return out;
  }
}
