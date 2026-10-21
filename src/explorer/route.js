// xrpl-sonic explorer — routes and the omnibox.
//
// One box takes anything: an r-address, a transaction hash, a ledger index,
// a currency code, a word like "latest". `classify` says what the text looks
// like as it is typed; `parseRoute` and `formatRoute` map the hash fragment
// (#account/r…, #tx/HASH, #ledger/N, #search/…) to and from route objects.
//
// Pure: no DOM.

import { isValidAddress } from '../mapping.js';

export const ROUTES = Object.freeze(['home', 'account', 'tx', 'ledger', 'search', 'help']);

const HASH = /^[0-9A-F]{64}$/i;
const LEDGER = /^#?(\d{1,12})$/;
const CURRENCY = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$|^[0-9A-F]{40}$/i;
const X_ADDRESS = /^[XT][1-9A-HJ-NP-Za-km-z]{30,50}$/;
const DEST_TAG = /^(r[1-9A-HJ-NP-Za-km-z]{24,34}):(\d{1,10})$/;

/**
 * What a piece of text looks like, with a confidence word and a hint for the
 * box. `kind` is 'account' | 'tx' | 'ledger' | 'currency' | 'latest' | 'xaddress' | 'empty' | 'unknown'.
 */
export function classify(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { kind: 'empty', value: '', hint: 'Paste an address, a transaction hash, a ledger index or a currency code. Try "latest".' };
  const lower = raw.toLowerCase();
  if (['latest', 'now', 'live', 'ledger'].includes(lower)) return { kind: 'latest', value: 'latest', hint: 'The latest validated ledger.' };
  const tag = DEST_TAG.exec(raw);
  if (tag && isValidAddress(tag[1])) return { kind: 'account', value: tag[1], tag: Number(tag[2]), hint: `An account with destination tag ${tag[2]}.` };
  if (isValidAddress(raw)) return { kind: 'account', value: raw, hint: 'An account (classic r-address).' };
  if (HASH.test(raw)) return { kind: 'tx', value: raw.toUpperCase(), hint: 'A transaction hash (64 hex characters).' };
  const ledger = LEDGER.exec(raw.replace(/,/g, ''));
  if (ledger) return { kind: 'ledger', value: Number(ledger[1]), hint: `Ledger #${Number(ledger[1]).toLocaleString('en-US')}.` };
  if (X_ADDRESS.test(raw)) return { kind: 'xaddress', value: raw, hint: 'An X-address. This explorer reads classic r-addresses; convert it first (the issuing wallet or xrpaddress.info can).' };
  if (/^[0-9A-F]{40}$/i.test(raw)) return { kind: 'currency', value: raw.toUpperCase(), hint: 'A 160-bit currency code. Pair it with an issuer address to open a trust line: CODE.rISSUER…' };
  if (/^r[1-9A-HJ-NP-Za-km-z]*$/.test(raw) && raw.length < 25) return { kind: 'unknown', value: raw, hint: `Looks like the start of an address (${raw.length} of 25–35 characters).` };
  if (/^[0-9A-F]+$/i.test(raw) && raw.length >= 4 && raw.length < 64 && raw.length !== 40) return { kind: 'unknown', value: raw, hint: `Looks like the start of a transaction hash (${raw.length} of 64 hex characters).` };
  if (CURRENCY.test(raw)) return { kind: 'currency', value: raw.length === 3 ? raw.toUpperCase() : raw.toUpperCase(), hint: 'A currency code. Pair it with an issuer address to open a trust line: CODE.rISSUER…' };
  const pair = /^([A-Za-z0-9]{3}|[0-9A-F]{40})\.(r[1-9A-HJ-NP-Za-km-z]{24,34})$/i.exec(raw);
  if (pair && isValidAddress(pair[2])) return { kind: 'account', value: pair[2], currency: pair[1].length === 3 ? pair[1].toUpperCase() : pair[1].toUpperCase(), hint: `The issuer of ${pair[1].toUpperCase()}.` };
  return { kind: 'unknown', value: raw, hint: 'Not recognised. Addresses start with r, hashes are 64 hex characters, ledger indices are numbers.' };
}

/** Route object from a hash fragment. Unknown or malformed fragments go home. */
export function parseRoute(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#\/?/, '').trim() : '';
  if (!raw) return { name: 'home' };
  const [head, ...rest] = raw.split('/');
  const arg = decodeURIComponent(rest.join('/') ?? '');
  switch (head) {
    case 'account': {
      const c = classify(arg);
      return c.kind === 'account' ? { name: 'account', address: c.value, tag: c.tag ?? null } : { name: 'home', error: `Not an account: ${arg.slice(0, 24)}` };
    }
    case 'tx':
      return HASH.test(arg) ? { name: 'tx', hash: arg.toUpperCase() } : { name: 'home', error: `Not a transaction hash: ${arg.slice(0, 24)}` };
    case 'ledger': {
      if (arg === 'latest' || arg === '') return { name: 'ledger', index: 'latest' };
      const m = LEDGER.exec(arg.replace(/,/g, ''));
      return m ? { name: 'ledger', index: Number(m[1]) } : { name: 'home', error: `Not a ledger index: ${arg.slice(0, 24)}` };
    }
    case 'search':
      return { name: 'search', query: arg };
    case 'help':
      return { name: 'help' };
    case '':
    case 'home':
      return { name: 'home' };
    default:
      return { name: 'home', error: `Unknown route: ${head.slice(0, 24)}` };
  }
}

/** Hash fragment for a route object (with the leading #). */
export function formatRoute(route) {
  switch (route?.name) {
    case 'account':
      return `#account/${route.address}${route.tag != null ? `:${route.tag}` : ''}`;
    case 'tx':
      return `#tx/${route.hash}`;
    case 'ledger':
      return `#ledger/${route.index}`;
    case 'search':
      return `#search/${encodeURIComponent(route.query ?? '')}`;
    case 'help':
      return '#help';
    default:
      return '#';
  }
}

/** The route a classified omnibox entry leads to, or null when it cannot be followed. */
export function routeFor(classified) {
  switch (classified?.kind) {
    case 'account':
      return { name: 'account', address: classified.value, tag: classified.tag ?? null };
    case 'tx':
      return { name: 'tx', hash: classified.value };
    case 'ledger':
      return { name: 'ledger', index: classified.value };
    case 'latest':
      return { name: 'ledger', index: 'latest' };
    default:
      return null;
  }
}

/** Title for a route, for the document title and the trail. */
export function routeTitle(route) {
  switch (route?.name) {
    case 'account':
      return `${route.address.slice(0, 6)}…${route.address.slice(-4)}`;
    case 'tx':
      return `tx ${route.hash.slice(0, 8)}…`;
    case 'ledger':
      return route.index === 'latest' ? 'latest ledger' : `ledger #${Number(route.index).toLocaleString('en-US')}`;
    case 'search':
      return `search: ${route.query}`;
    case 'help':
      return 'help';
    default:
      return 'home';
  }
}
