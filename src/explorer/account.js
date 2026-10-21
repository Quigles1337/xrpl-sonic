// xrpl-sonic explorer — an account as a snapshot.
//
// One render of an account reads one validated ledger and asks for every
// part at it: account_info, account_lines, account_objects and account_nfts
// at that ledger_index, and account_tx with ledger_index_max bound to it,
// a bound that "Load older" carries through pagination. Each part has one of
// four states, and the states reach both the view and the facts object:
//
//   unavailable  the request failed (the node said why; see `error`)
//   empty        the request succeeded and there was nothing
//   partial      the request succeeded and a marker says there is more
//   loaded       the request succeeded and this is all of it
//
// So an empty list is never mistaken for a failed request. The api is any
// object with the ExplorerApi methods; the tests replay recorded responses.
//
// Pure: no DOM, no network of its own.

import { counterparties } from './anatomy.js';

export const PART_STATES = Object.freeze(['unavailable', 'empty', 'partial', 'loaded']);

const errorOf = (err) => ({ code: err?.code ?? 'unknown', message: err?.message ?? String(err) });

function partOf(items, marker, error = null) {
  if (error) return { state: 'unavailable', items: [], marker: null, error };
  if (!items.length) return { state: 'empty', items: [], marker: null, error: null };
  return { state: marker ? 'partial' : 'loaded', items, marker: marker ?? null, error: null };
}

const ledgerOf = (entry) => Number(entry?.tx?.ledger_index ?? entry?.tx_json?.ledger_index ?? entry?.ledger_index);

/** What a list of account_tx entries covers: how many records, over which ledgers. Null for none. */
function coverage(entries, pages) {
  if (!entries.length) return null;
  const ledgers = entries.map(ledgerOf).filter(Number.isFinite);
  return { count: entries.length, pages, newestLedger: ledgers.length ? Math.max(...ledgers) : null, oldestLedger: ledgers.length ? Math.min(...ledgers) : null };
}

/** "40 records, ledgers #107,811,685–#107,811,689" for a coverage, or '' for none. */
export function coverageOf(covers) {
  if (!covers) return '';
  const fmt = (n) => `#${Number(n).toLocaleString('en-US')}`;
  const range = covers.newestLedger == null ? '' : covers.newestLedger === covers.oldestLedger ? `, ledger ${fmt(covers.newestLedger)}` : `, ledgers ${fmt(covers.oldestLedger)}–${fmt(covers.newestLedger)}`;
  return `${covers.count} record${covers.count === 1 ? '' : 's'}${range}`;
}

/**
 * Read an account at one validated ledger.
 * @param {object} api  an ExplorerApi (or a stand-in with the same methods)
 * @param {string} address
 * @param {{ limit?: number, onPart?: (name: string, part: object) => void }} [options]
 *   `onPart(name, part, facts)` fires as each part settles, so a page can fill in while the rest is still loading.
 * @returns {Promise<object>} the facts object: { kind, address, snapshot, parts, counterparties }
 */
export async function loadAccount(api, address, { limit = 40, onPart = () => {} } = {}) {
  const facts = { kind: 'account', address, snapshot: null, parts: { info: null, lines: null, objects: null, nfts: null, tx: null }, counterparties: { parties: [], covers: null } };
  let ledgerIndex = null;
  try {
    const r = await api.validatedLedger();
    const header = r?.ledger ?? r ?? {};
    const index = Number(r?.ledger_index ?? header.ledger_index);
    if (!Number.isFinite(index)) throw Object.assign(new Error('the node returned no ledger index'), { code: 'noLedger' });
    ledgerIndex = index;
    facts.snapshot = { state: 'loaded', ledgerIndex, ledgerHash: r.ledger_hash ?? header.ledger_hash ?? null, closeTime: header.close_time ?? null };
  } catch (err) {
    facts.snapshot = { state: 'unavailable', ledgerIndex: null, ledgerHash: null, closeTime: null, error: errorOf(err) };
  }
  const at = ledgerIndex != null ? { ledgerIndex } : {};
  const settle = (name, part) => {
    facts.parts[name] = part;
    onPart(name, part, facts);
    return part;
  };
  const list = (name, promise, pick) => promise.then((r) => settle(name, partOf(pick(r) ?? [], r?.marker)), (err) => settle(name, partOf([], null, errorOf(err))));
  await Promise.all([
    api.accountInfo(address, at).then(
      (result) => settle('info', { state: 'loaded', result, error: null }),
      (err) => settle('info', { state: 'unavailable', result: null, error: errorOf(err) }),
    ),
    list('lines', api.accountLines(address, { ...at, limit: 200 }), (r) => r.lines),
    list('objects', api.accountObjects(address, { ...at, limit: 200 }), (r) => r.account_objects),
    list('nfts', api.accountNfts(address, { ...at, limit: 100 }), (r) => r.account_nfts),
    api.accountTx(address, { limit, ...(ledgerIndex != null ? { ledgerIndexMax: ledgerIndex } : {}) }).then(
      (r) => {
        const entries = r?.transactions ?? [];
        const base = partOf(entries, r?.marker);
        const part = { state: base.state, entries, marker: base.marker, error: null, ledgerIndexMax: ledgerIndex, limit, pages: 1, covers: coverage(entries, 1) };
        facts.counterparties = { parties: counterparties(entries, address), covers: part.covers };
        settle('tx', part);
      },
      (err) => settle('tx', { state: 'unavailable', entries: [], marker: null, error: errorOf(err), ledgerIndexMax: ledgerIndex, limit, pages: 0, covers: null }),
    ),
  ]);
  return facts;
}

/**
 * Append the next page of account_tx to a facts object, with the same
 * ledger_index_max bound, and recompute the counterparties over everything
 * loaded. Resolves with the new page ({ entries, marker }), or null when
 * there is nothing to load.
 */
export async function loadOlder(api, facts) {
  const part = facts?.parts?.tx;
  if (!part || !part.marker) return null;
  const r = await api.accountTx(facts.address, { limit: part.limit ?? 40, marker: part.marker, ...(part.ledgerIndexMax != null ? { ledgerIndexMax: part.ledgerIndexMax } : {}) });
  const entries = r?.transactions ?? [];
  part.entries.push(...entries);
  part.pages += 1;
  part.marker = r?.marker ?? null;
  part.state = part.marker ? 'partial' : part.entries.length ? 'loaded' : 'empty';
  part.covers = coverage(part.entries, part.pages);
  facts.counterparties = { parties: counterparties(part.entries, facts.address), covers: part.covers };
  return { entries, marker: part.marker };
}
