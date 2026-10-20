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

/** Build a hash string (with the leading `#`, or '' when there is nothing to carry). */
export function buildHash({ account, replay } = {}) {
  const params = new URLSearchParams();
  if (account) params.set('account', account);
  if (replay) params.set('replay', replay);
  const s = params.toString();
  return s ? `#${s}` : '';
}
