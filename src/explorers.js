// xrpl-sonic — explorer link builders.
//
// Pure: no DOM. Every log entry links to the transaction, account or ledger on
// the explorer the user picked, on the network the page is listening to.

export const EXPLORERS = Object.freeze({
  xrpscan: Object.freeze({
    label: 'XRPScan',
    base: Object.freeze({ mainnet: 'https://xrpscan.com', testnet: 'https://testnet.xrpscan.com' }),
    paths: Object.freeze({ tx: '/tx/', account: '/account/', ledger: '/ledger/' }),
  }),
  bithomp: Object.freeze({
    label: 'Bithomp',
    base: Object.freeze({ mainnet: 'https://bithomp.com', testnet: 'https://test.bithomp.com' }),
    paths: Object.freeze({ tx: '/explorer/', account: '/explorer/', ledger: '/ledger/' }),
  }),
  xrplorg: Object.freeze({
    label: 'xrpl.org',
    base: Object.freeze({ mainnet: 'https://livenet.xrpl.org', testnet: 'https://testnet.xrpl.org' }),
    paths: Object.freeze({ tx: '/transactions/', account: '/accounts/', ledger: '/ledgers/' }),
  }),
});

export const EXPLORER_NAMES = Object.freeze(Object.keys(EXPLORERS));

/** Where the pages live; links that leave the page are built on it. */
export const SITE_URL = 'https://quigles1337.github.io/xrpl-sonic/';
export const DEFAULT_EXPLORER = 'xrpscan';

const TX_HASH = /^[0-9A-Fa-f]{64}$/;
const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

/**
 * URL of a transaction, account or ledger on an explorer, or null when the
 * identifier is malformed (so a bad hash can never become a link).
 * @param {'tx'|'account'|'ledger'} kind
 */
export function explorerUrl(explorer, network, kind, id) {
  const ex = EXPLORERS[explorer] ?? EXPLORERS[DEFAULT_EXPLORER];
  const base = ex.base[network] ?? ex.base.mainnet;
  const path = ex.paths[kind];
  if (!path) return null;
  if (kind === 'tx' && !TX_HASH.test(String(id ?? ''))) return null;
  if (kind === 'account' && !ADDRESS.test(String(id ?? ''))) return null;
  if (kind === 'ledger' && !(Number.isInteger(Number(id)) && Number(id) > 0)) return null;
  return `${base}${path}${id}`;
}

/**
 * A link from the explorer to the listening page: the network goes in front
 * of the hash (`?network=testnet#replay=…`), so a testnet record replays on
 * testnet. Mainnet needs no query.
 */
export function listenerUrl(network, fragment = '') {
  const q = network && network !== 'mainnet' ? `?network=${network}` : '';
  return `./${q}${fragment ?? ''}`;
}
