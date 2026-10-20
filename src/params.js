// xrpl-sonic — URL state (hash and query) parsing.
//
// Pure: no DOM. The hash carries shareable state (`#account=r...`,
// `#replay=<ledger>` or `#replay=<from>-<to>`); the query carries page modes
// (`?network=testnet`, `?autostart=1`, `?overlay=1`, `?embed=1`).

import { isValidAddress } from './mapping.js';

/**
 * Parse a location hash. Unknown keys are ignored; a malformed account is
 * reported in `errors` rather than silently dropped.
 * @returns {{ account: string|null, replay: string|null, errors: string[] }}
 */
export function parseHash(hash) {
  const out = { account: null, replay: null, errors: [] };
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (!raw) return out;
  const params = new URLSearchParams(raw);
  const account = params.get('account');
  if (account != null && account !== '') {
    const trimmed = account.trim();
    if (isValidAddress(trimmed)) out.account = trimmed;
    else out.errors.push(`Ignoring invalid account in URL: ${trimmed.slice(0, 12)}…`);
  }
  const replay = params.get('replay');
  if (replay != null && replay.trim() !== '') out.replay = replay.trim();
  return out;
}

/**
 * Parse the query string: page modes and the network.
 * `mode` is 'overlay' (transparent, no controls, for OBS browser sources),
 * 'embed' (compact chrome for an iframe) or 'full'. Overlay wins if both are set.
 * @returns {{ network: 'mainnet'|'testnet'|null, autostart: boolean, mode: 'overlay'|'embed'|'full' }}
 */
export function parseQuery(search) {
  const raw = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  const params = new URLSearchParams(raw);
  const flag = (name) => {
    const v = params.get(name);
    return v != null && v !== '' && v !== '0' && v !== 'false';
  };
  const network = params.get('network');
  return {
    network: network === 'mainnet' || network === 'testnet' ? network : null,
    autostart: flag('autostart'),
    mode: flag('overlay') ? 'overlay' : flag('embed') ? 'embed' : 'full',
  };
}

/** Build a hash string (with the leading `#`, or '' when there is nothing to carry). */
export function buildHash({ account, replay } = {}) {
  const params = new URLSearchParams();
  if (account) params.set('account', account);
  if (replay) params.set('replay', replay);
  const s = params.toString();
  return s ? `#${s}` : '';
}
