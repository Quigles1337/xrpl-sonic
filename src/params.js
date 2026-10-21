// xrpl-sonic — URL state (hash and query) parsing.
//
// Pure: no DOM. The hash carries shareable state (`#account=r...`,
// `#replay=<ledger>` or `#replay=<from>-<to>`, `#cast=...`, `#case=...`); the
// query carries page modes (`?network=testnet`, `?autostart=1`, `?overlay=1`,
// `?embed=1`).

import { isValidAddress } from './mapping.js';

/**
 * Parse a location hash. Unknown keys are ignored; a malformed account is
 * reported in `errors` rather than silently dropped.
 * `cast` and `case` are passed through verbatim for src/cast.js and src/case.js to interpret.
 * @returns {{ account: string|null, replay: string|null, cast: string|null, case: string|null, errors: string[] }}
 */
export function parseHash(hash) {
  const out = { account: null, replay: null, cast: null, case: null, errors: [] };
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
  const cast = params.get('cast');
  if (cast != null && cast.trim() !== '') out.cast = cast.trim();
  const theCase = params.get('case');
  if (theCase != null && theCase.trim() !== '') out.case = theCase.trim();
  return out;
}

/**
 * Parse the query string: page modes and the network.
 * `mode` is 'overlay' (transparent, no controls, for OBS browser sources),
 * 'embed' (compact chrome for an iframe) or 'full'. Overlay wins if both are set.
 * `caseUrl` is a same-origin, relative `.json` path to load as a case (`?case=docs/cases/x.sonic-case.json`);
 * anything absolute, with a scheme, or walking up a directory is ignored.
 * @returns {{ network: 'mainnet'|'testnet'|null, autostart: boolean, mode: 'overlay'|'embed'|'full', caseUrl: string|null }}
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
    caseUrl: safeCasePath(params.get('case')),
  };
}

/** A relative path under the site, ending in .json, with no scheme, host, backslash or `..` segment. */
export function safeCasePath(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 300 || !/\.json$/i.test(v)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('/') || v.startsWith('\\\\') || v.includes('\\') || v.includes('//')) return null;
  if (v.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return v;
}

/** Build a hash string (with the leading `#`, or '' when there is nothing to carry). Key order: account, replay, cast, case. */
export function buildHash({ account, replay, cast, case: theCase } = {}) {
  const params = new URLSearchParams();
  if (account) params.set('account', account);
  if (replay) params.set('replay', replay);
  if (cast) params.set('cast', cast);
  if (theCase) params.set('case', theCase);
  // `~` and `:` are safe in a fragment; keep them readable in cast and case links.
  const s = params.toString().replace(/%7E/gi, '~').replace(/%3A/gi, ':');
  return s ? `#${s}` : '';
}
