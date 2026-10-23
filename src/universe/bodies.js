// UNIVERSE — the body rules, the names and the labels.
//
// Every body is earned by data: a planet is a planet because an account
// appeared in a validated transaction's record, a star because trust lines
// in the record name it as the issuer to enough holders, a black hole
// because its AccountRoot carries the bits and the key that make one.
// `bodyOf` reads a planet (src/universe/universe.js) and returns the body
// with its tier (docs/facts.md: observed, calculated, rule, hypothesis),
// the rule id, the evidence it read, and the drawing parameters (size, hue,
// glow). `nameOf` is the name rule of docs/universe.md (the on-ledger
// Domain, else the Watch cast's label, else the short address); `labelOf`
// prints the rule's threshold on every body's label; `describeBody` is the
// text equivalent a screen reader gets. The vocabulary table in
// docs/universe.md names every rule here, and the thresholds are the
// numbers in THRESHOLDS, printed wherever a body is named by them.
//
// Pure: no DOM, no network.

import { hashString, shortAddress } from '../mapping.js';
import { decodeDomain } from '../explorer/anatomy.js';
import { CATEGORY_BY_CODE, TYPE_CODES } from './records.js';
import { DEFAULTS as CLUSTER_DEFAULTS } from './cluster.js';

/** AccountRoot flag bits the rules read (lsf*). */
export const LSF = Object.freeze({ disableMaster: 0x00100000, globalFreeze: 0x00400000, defaultRipple: 0x00800000, depositAuth: 0x01000000, amm: 0x02000000 });

/** The regular keys no one can sign with: setting one of these with the master key disabled is how an account is blackholed. */
export const BLACKHOLE_KEYS = Object.freeze(['rrrrrrrrrrrrrrrrrrrrrhoLvTp', 'rrrrrrrrrrrrrrrrrrrrBZbvji', 'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', 'rrrrrrrrrrrrrrrrrrrn5RM1rHd']);

export const KINDS = Object.freeze(['planet', 'star', 'binary', 'blackhole', 'pulsar', 'collapsed']);
export const KIND_CODES = Object.freeze(Object.fromEntries(KINDS.map((k, i) => [k, i])));

/** How many distinct holders a planet's trust lines must name it issuer to before it is drawn as a star. */
export const STAR_HOLDERS = 3;

/**
 * The thresholds that make bodies, as the owner decided them (docs/universe.md, decision 5), printed on every label:
 * a star issues to at least `starHolders` holders; a pulsar's cadence is a self-correlation of at least `pulsarLeast`
 * at a period of at least `pulsarPeriod` ledgers; a cluster edge is at least `clusterEdge` namings, a hub (more than
 * `hubDegree` counterparties) never glues a cluster, and a nebula is a cluster of at least `nebulaSize`.
 */
export const THRESHOLDS = Object.freeze({ starHolders: STAR_HOLDERS, pulsarLeast: 0.3, pulsarPeriod: 2, clusterEdge: CLUSTER_DEFAULTS.minEdge, hubDegree: CLUSTER_DEFAULTS.hubDegree, nebulaSize: CLUSTER_DEFAULTS.minSize });

/** Size in sprite units from an XRP balance: 1 XRP is just above the floor, a million XRP about four times it. Unknown is small and drawn hollow. */
export function sizeFromBalance(drops) {
  if (!Number.isFinite(drops) || drops < 0) return { size: 0.9, known: false };
  const xrp = drops / 1e6;
  return { size: 1 + 0.45 * Math.log10(1 + xrp), known: true };
}

/** The sigil hue (src/explorer/sigil.js uses the same hash), so a planet matches its mark in the explorer. A copy until R8 lands. */
export function hueOf(address) {
  return hashString(String(address ?? '')) % 360;
}

/** Activity as glow in [0, 1]: the planet's decayed touch count at `ledger` (src/universe/universe.js keeps `activity` and `lastLedger`). */
export function glowOf(planet, ledger, { halfLife = 6 } = {}) {
  if (!planet || planet.lastLedger == null || !(planet.activity > 0)) return 0;
  const age = Math.max(0, (ledger ?? planet.lastLedger) - planet.lastLedger);
  const now = planet.activity * 0.5 ** (age / halfLife);
  return Math.min(1, Math.log2(1 + now) / 5);
}

/**
 * The body a planet is, by precedence: collapsed (its AccountRoot was
 * deleted), binary star (an AMM pseudo-account, by AMMID), black hole
 * (candidate: master key disabled and the regular key unusable or absent;
 * a SignerList would reopen it and the stream cannot see one), star (issuer
 * to STAR_HOLDERS holders in the record), pulsar (a cadence from coherence),
 * else planet. Each kind keeps its tier, rule and evidence.
 */
export function bodyOf(planet, { ledger = null, minHolders = STAR_HOLDERS } = {}) {
  const { size, known } = sizeFromBalance(planet?.balanceDrops);
  const base = { size, sizeKnown: known, hue: hueOf(planet?.address), glow: glowOf(planet, ledger), frozen: Boolean(planet?.flags != null && planet.flags & LSF.globalFreeze), rings: planet?.peers?.size ?? 0, fundedRings: planet?.fundedLines ?? 0 };
  if (!planet) return { ...base, kind: 'planet', tier: 'observed', rule: 'planet.seen', evidence: [] };
  if (planet.deleted) return { ...base, kind: 'collapsed', tier: 'observed', rule: 'planet.collapse', evidence: [{ field: 'AffectedNodes.DeletedNode.AccountRoot', value: planet.address }] };
  if (planet.ammId) return { ...base, kind: 'binary', tier: 'observed', rule: 'binary.ammid', evidence: [{ field: 'AccountRoot.AMMID', value: planet.ammId }], providers: planet.providers?.size ?? 0 };
  if (planet.flags != null && planet.flags & LSF.disableMaster) {
    const key = planet.regularKey;
    const unusable = key == null || BLACKHOLE_KEYS.includes(key);
    if (unusable) {
      return {
        ...base,
        kind: 'blackhole',
        tier: 'hypothesis',
        rule: 'blackhole.candidate',
        evidence: [
          { field: 'AccountRoot.Flags', value: `0x${planet.flags.toString(16)} (lsfDisableMaster)` },
          { field: 'AccountRoot.RegularKey', value: key ?? 'absent' },
        ],
        regularKey: key ?? null,
        note: 'a SignerList would make the account usable again; the stream does not carry one, so the explorer must confirm with account_objects',
      };
    }
  }
  if ((planet.holders?.size ?? 0) >= minHolders) {
    return { ...base, kind: 'star', tier: 'rule', rule: 'star.issuer', evidence: [{ field: 'RippleState sides', value: `${planet.holders.size} holders` }], holders: planet.holders.size };
  }
  if (planet.cadence && planet.cadence.period >= THRESHOLDS.pulsarPeriod && planet.cadence.r >= THRESHOLDS.pulsarLeast) {
    return { ...base, kind: 'pulsar', tier: 'observation', rule: 'pulsar.cadence', evidence: [{ field: 'self-correlation', value: `r ${planet.cadence.r.toFixed(2)} at lag ${planet.cadence.period}` }], period: planet.cadence.period, r: planet.cadence.r };
  }
  return { ...base, kind: 'planet', tier: 'observed', rule: 'planet.seen', evidence: [{ field: 'record', value: `${planet.involved} transactions` }] };
}

/** What a transaction is in the sky, from its compact record: a comet (payment), dust, a long-period comet (escrow), a flash at the planet (everything else). */
export function cometOf(rec) {
  if (!rec) return null;
  if (rec.type === TYPE_CODES.Payment) {
    const dust = rec.xrp && rec.log != null && rec.log < 0;
    return { kind: dust ? 'dust' : 'comet', from: rec.account, to: rec.destination, tail: 1 + (rec.paths || 0), log: rec.log, category: rec.category, success: rec.success };
  }
  if (rec.type === TYPE_CODES.EscrowCreate) return { kind: 'long-period', from: rec.account, to: rec.destination || rec.account, returns: rec.finishAfter, log: rec.log, category: rec.category, success: rec.success };
  if (rec.type === TYPE_CODES.EscrowFinish || rec.type === TYPE_CODES.EscrowCancel) return { kind: 'return', from: rec.account, to: rec.destination || rec.account, category: rec.category, success: rec.success };
  return { kind: 'flash', at: rec.account, category: rec.category, success: rec.success, log: rec.log };
}

// ---------------------------------------------------------------------------
// Names, labels, the text equivalent
// ---------------------------------------------------------------------------

/** The cast member for an address, from a normalised cast (src/cast.js normalizeCast: { address, label, colour, … }), or null. */
export function castMemberOf(address, cast) {
  if (!address || !Array.isArray(cast)) return null;
  return cast.find((m) => m?.address === address) ?? null;
}

/**
 * The name rule (docs/universe.md, decision 1): the on-ledger Domain when the
 * account root carried one, else the Watch cast's label for the address,
 * else the short address. `domain` is the hex field as recorded.
 * @returns {{ name: string, source: 'domain'|'cast'|'address', member: object|null }}
 */
export function nameOf({ address, domain = null } = {}, cast = []) {
  const member = castMemberOf(address, cast);
  const decoded = domain ? decodeDomain(domain) : '';
  if (decoded) return { name: decoded, source: 'domain', member };
  if (member?.label) return { name: member.label, source: 'cast', member };
  return { name: shortAddress(address ?? ''), source: 'address', member };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtXrp = (drops) => `${(drops / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} XRP`;
const shortKey = (key) => (key ? `${key.slice(0, 4)}…${key.slice(-6)}` : 'absent');

/**
 * The body's label with its rule's threshold printed (decision 5), from the
 * numbers the page has for a planet: `{ kind, holders, providers, period, r,
 * regularKey }` as `bodyOf` returns them. A plain planet has no rule to
 * print and gets no suffix.
 */
export function labelOf(body) {
  const t = THRESHOLDS;
  switch (body?.kind) {
    case 'star':
      return `star · ${plural(body.holders ?? 0, 'holder')} ≥ ${t.starHolders}`;
    case 'binary':
      return `binary · AMM pool${body.providers ? ` · ${plural(body.providers, 'provider')}` : ''}`;
    case 'blackhole':
      return `black hole? · master key disabled · key ${shortKey(body.regularKey)} unusable · a SignerList would reopen it`;
    case 'pulsar':
      return `pulsar · cadence ${plural(body.period ?? 0, 'ledger')} · r ${(body.r ?? 0).toFixed(2)} ≥ ${t.pulsarLeast.toFixed(2)}`;
    case 'collapsed':
      return 'collapsed · account deleted';
    default:
      return '';
  }
}

/** A nebula's label with its three thresholds. */
export function nebulaLabel(size) {
  const t = THRESHOLDS;
  return `nebula · ${plural(size, 'planet')} ≥ ${t.nebulaSize} · edges ≥ ${t.clusterEdge} namings · hubs > ${t.hubDegree} counterparties left out`;
}

/** The text equivalent of a body, for a screen reader or a caption. Only what the record established; the tier is said when it is not observed; the thresholds are printed. */
export function describeBody(planet, body, { ledger = null, cast = [] } = {}) {
  if (!planet) return 'nothing here';
  const b = body ?? bodyOf(planet, { ledger });
  const named = nameOf(planet, cast);
  const name = named.source === 'address' ? named.name : `${named.name} (${shortAddress(planet.address)})`;
  const parts = [];
  const kindWord = { planet: 'a planet', star: `a star · ${plural(b.holders ?? 0, 'holder')} in orbit (star ≥ ${THRESHOLDS.starHolders})`, binary: `a binary star · an AMM pool${b.providers ? ` with ${plural(b.providers, 'provider')}` : ''}`, blackhole: `a black hole candidate · master key disabled, regular key ${shortKey(b.regularKey)} unusable; a SignerList would reopen it`, pulsar: `a pulsar · cadence of ${plural(b.period ?? 0, 'ledger')}, r ${(b.r ?? 0).toFixed(2)} ≥ ${THRESHOLDS.pulsarLeast.toFixed(2)}`, collapsed: 'collapsed · its account was deleted' }[b.kind];
  parts.push(`${name}: ${kindWord}`);
  if (named.source === 'cast') parts.push('in the cast');
  else if (named.source === 'domain') parts.push('named by its on-ledger Domain');
  parts.push(b.sizeKnown ? `balance ${fmtXrp(planet.balanceDrops)}` : 'balance not yet seen');
  parts.push(`${plural(planet.involved ?? 0, 'transaction')} in ${plural(planet.ledgersSeen ?? 0, 'ledger')}${planet.submitted ? `, ${planet.submitted} submitted` : ''}`);
  if (b.rings) parts.push(`${plural(b.rings, 'trust line')} seen${b.fundedRings ? `, ${b.fundedRings} funded` : ''}`);
  if (planet.openOffers) parts.push(`${plural(planet.openOffers, 'open offer')} placed in this window`);
  if (planet.minted) parts.push(`${plural(planet.minted, 'NFT')} minted here`);
  if (b.frozen) parts.push('global freeze set');
  if (planet.created) parts.push('born in this window');
  if (planet.lastLedger != null) parts.push(`last seen in ledger #${Number(planet.lastLedger).toLocaleString('en-US')}`);
  if (b.tier !== 'observed') parts.push(`(${b.tier}: ${b.rule})`);
  return parts.join(' · ');
}

/** The dominant category of a planet's record, as the field guide names it. */
export function dominantOf(planet) {
  let best = CATEGORY_BY_CODE.length - 1;
  let n = -1;
  (planet?.byCategory ?? []).forEach((v, i) => {
    if (v > n) {
      n = v;
      best = i;
    }
  });
  return CATEGORY_BY_CODE[best] ?? 'other';
}

// ---------------------------------------------------------------------------
// Flight: when a comet starts and lands
// ---------------------------------------------------------------------------

/**
 * When the i-th of k celestial objects of a ledger starts and how long it
 * flies, staggered across the ledger interval as the plate spreads a burst
 * (85% of the interval), so the picture and the sound use the same clock:
 * a comet lands at start + life, a flash happens at start.
 */
export function flightOf(c, i, k, intervalMs, now) {
  const start = now + (i / Math.max(1, k)) * intervalMs * 0.85;
  const life = c.kind === 'flash' ? 700 : c.kind === 'dust' ? intervalMs * 0.5 : c.kind === 'long-period' ? intervalMs * 1.6 : intervalMs * 0.9;
  return { start, life, arrival: c.kind === 'flash' ? start : start + life };
}
