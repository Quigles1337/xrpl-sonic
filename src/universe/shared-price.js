// UNIVERSE phase 3A — shared price: limited arbitrage as a probe measure, pure.
//
// At one ledger, each candidate account's revealed market cone is the set of
// positive price vectors under which every one of its funded offers rests
// (the owner receives at least the value it gives). In log prices an offer
// is a difference constraint π(TakerGets) − π(TakerPays) ≤ log q, and a
// group of candidates shares a price when the union of their constraints is
// feasible, which Bellman–Ford decides; when it is not, the negative cycle is
// the certificate. The nerve of the family (a simplex for every group that
// shares a price) is enumerated upward with Helly's bound, its Betti numbers
// over GF(2) are the invariant of G. Chichilnisky, "Intersecting families of
// sets and the topology of cones in economics", Bull. AMS 29 (1993)
// 189–207 (market cones (3)–(5), Corollary 1, Theorem 11), and J. Math.
// Econ. 28 (1997) 445–469; the equilibrium theorem of the latter is
// contested (Monteiro, Page and Wooders, J. Math. Econ. 28 (1997) 481–501)
// and nothing of it is used here: only the nerve, Helly and LP duality.
// docs/universe.md, "Phase 3A".
//
// Fees follow rippled's BookStep.cpp (develop, read 2026-10-24): the offer
// owner gives TakerGets × TransferRate(issuer of TakerGets) (parity for XRP
// or when the issuer is the destination), the taker pays TakerPays ×
// TransferRate(issuer of TakerPays) when the taker redeems that token.
// Trust-line QualityIn/QualityOut live in DirectStep.cpp (rippling), which
// is out of scope here. Amounts are read as Numbers for the arithmetic of
// logs and ratios; the readout prints the offers' own strings.

export const SHARED_PRICE_VERSION = 1;
export const DEFAULTS = Object.freeze({ candidates: 10, makersPerBook: 3, minEdge: 1e-9 });
export const RATE_ONE = 1_000_000_000;

/** The asset of an amount: 'XRP' for drops (a string or {currency:'XRP'}), else 'CODE/issuer'. */
export function assetOf(amount) {
  if (amount == null) return null;
  if (typeof amount === 'string' || typeof amount === 'number') return 'XRP';
  if (amount.currency === 'XRP' && !amount.issuer) return 'XRP';
  if (amount.mpt_issuance_id) return `MPT/${amount.mpt_issuance_id}`;
  return `${amount.currency}/${amount.issuer ?? ''}`;
}

/** The issuer of an asset key, null for XRP. */
export const issuerOf = (asset) => (asset === 'XRP' || !asset ? null : asset.split('/')[1] || null);

/** An amount as a Number in the asset's own unit (drops for XRP; the token's value otherwise). */
export function valueOf(amount) {
  if (amount == null) return NaN;
  if (typeof amount === 'string' || typeof amount === 'number') return Number(amount);
  return Number(amount.value);
}

/** A TransferRate field (billionths, 0 or absent = parity) as a multiplier ≥ 1. */
export function rateOf(transferRate) {
  const n = Number(transferRate);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n / RATE_ONE;
}

/**
 * One offer's funded amounts: taker_gets_funded / taker_pays_funded when the
 * node gave them (partially funded), else TakerGets/TakerPays capped by
 * owner_funds on the TakerGets side (the owner's first offer in a book
 * carries it). Returns null when nothing is funded.
 */
export function fundedOf(offer) {
  const gets = offer.taker_gets_funded ?? offer.TakerGets;
  const pays = offer.taker_pays_funded ?? offer.TakerPays;
  let g = valueOf(gets);
  let p = valueOf(pays);
  if (!(g > 0) || !(p > 0)) return null;
  if (offer.taker_gets_funded == null && offer.owner_funds != null) {
    const funds = Number(offer.owner_funds);
    if (Number.isFinite(funds) && funds < g) {
      p = (p * funds) / g;
      g = funds;
    }
  }
  if (!(g > 0) || !(p > 0)) return null;
  return { gets: { asset: assetOf(gets), amount: g, raw: gets }, pays: { asset: assetOf(pays), amount: p, raw: pays } };
}

/**
 * The constraint of one offer under the engine's fee rules. `rates` maps an
 * issuer to its TransferRate multiplier (parity when absent); `takerIssues`
 * says whether the loop taker is the issuer of an asset (parity on that
 * leg). Returns null for an unfunded offer.
 * @returns {{ from: string, to: string, weight: number, ownerQ: number, takerQ: number, nominalQ: number, rateIn: number, rateOut: number, offer: object, owner: string, sequence: number|null, funded: object }|null}
 */
export function constraintOf(offer, { rates = new Map(), takerIssues = () => false } = {}) {
  const funded = fundedOf(offer);
  if (!funded) return null;
  const gets = funded.gets;
  const pays = funded.pays;
  const rateOut = gets.asset === 'XRP' ? 1 : (rates.get(issuerOf(gets.asset)) ?? 1); // the owner gives TakerGets × rate
  const rateIn = pays.asset === 'XRP' || takerIssues(issuerOf(pays.asset)) ? 1 : (rates.get(issuerOf(pays.asset)) ?? 1); // the taker pays TakerPays × rate when redeeming
  const nominalQ = pays.amount / gets.amount;
  const ownerQ = pays.amount / (gets.amount * rateOut);
  const takerQ = (pays.amount * rateIn) / gets.amount;
  return { from: pays.asset, to: gets.asset, weight: Math.log(ownerQ), ownerQ, takerQ, nominalQ, rateIn, rateOut, offer, owner: offer.Account ?? offer.owner ?? null, sequence: offer.Sequence ?? offer.seq ?? null, funded, pool: null };
}

/**
 * An AMM pool as a vertex: two constraints at its marginal qualities, which
 * can never loop on their own (their weights sum to −2·log(1−f) > 0).
 * `pool` is amm_info's result: { account, amount, amount2, trading_fee }.
 */
export function poolConstraints(pool) {
  const a = { asset: assetOf(pool.amount), amount: valueOf(pool.amount) };
  const b = { asset: assetOf(pool.amount2), amount: valueOf(pool.amount2) };
  if (!(a.amount > 0) || !(b.amount > 0)) return [];
  const f = Math.max(0, Math.min(0.5, Number(pool.trading_fee ?? 0) / 100000));
  const base = { owner: pool.account ?? null, sequence: null, offer: null, rateIn: 1, rateOut: 1, pool: { account: pool.account ?? null, fee: f } };
  // b for a: the taker pays a, gets b; marginal quality a per b
  const qAB = a.amount / (b.amount * (1 - f));
  const qBA = b.amount / (a.amount * (1 - f));
  return [
    { ...base, from: a.asset, to: b.asset, weight: Math.log(qAB), ownerQ: qAB, takerQ: qAB, nominalQ: a.amount / b.amount, funded: { pays: a, gets: b }, pool: { ...base.pool, in: a, out: b } },
    { ...base, from: b.asset, to: a.asset, weight: Math.log(qBA), ownerQ: qBA, takerQ: qBA, nominalQ: b.amount / a.amount, funded: { pays: b, gets: a }, pool: { ...base.pool, in: b, out: a } },
  ];
}

/**
 * Bellman–Ford over the constraint graph: feasible with one price per asset
 * (XRP at 0), or the negative cycle as a list of constraints in traversal
 * order (the taker's path: each constraint from its TakerPays asset to its
 * TakerGets asset).
 */
export function feasible(constraints, { epsilon = 1e-12 } = {}) {
  const assets = [...new Set(constraints.flatMap((c) => [c.from, c.to]))];
  const index = new Map(assets.map((a, i) => [a, i]));
  const n = assets.length;
  if (!n) return { feasible: true, prices: new Map(), assets };
  // a virtual source reaches every asset at 0: π ≤ 0 everywhere to start (shift-invariant)
  const dist = new Float64Array(n).fill(0);
  const pred = new Int32Array(n).fill(-1);
  const predEdge = new Int32Array(n).fill(-1);
  let last = -1;
  for (let pass = 0; pass < n; pass++) {
    last = -1;
    for (let e = 0; e < constraints.length; e++) {
      const c = constraints[e];
      const u = index.get(c.from);
      const v = index.get(c.to);
      if (dist[u] + c.weight < dist[v] - epsilon) {
        dist[v] = dist[u] + c.weight;
        pred[v] = u;
        predEdge[v] = e;
        last = v;
      }
    }
    if (last < 0) break;
  }
  if (last < 0) {
    const xrp = index.get('XRP');
    const shift = xrp == null ? 0 : dist[xrp];
    return { feasible: true, prices: new Map(assets.map((a, i) => [a, dist[i] - shift])), assets };
  }
  // walk back n steps to land inside the cycle, then collect it
  let v = last;
  for (let i = 0; i < n; i++) v = pred[v];
  const cycle = [];
  let u = v;
  do {
    cycle.push(predEdge[u]);
    u = pred[u];
  } while (u !== v && cycle.length <= n);
  cycle.reverse();
  return { feasible: false, cycle: cycle.map((e) => constraints[e]), assets };
}

/** The gain of a cycle after the taker's fees: 1/∏ takerQ − 1 (positive when the loop pays), and the nominal edge 1/∏ nominalQ − 1. */
export function edgeOf(cycle) {
  let taker = 1;
  let nominal = 1;
  let owner = 1;
  for (const c of cycle) {
    taker *= c.takerQ;
    nominal *= c.nominalQ;
    owner *= c.ownerQ;
  }
  return { afterFees: 1 / taker - 1, nominal: 1 / nominal - 1, ownerSide: 1 / owner - 1 };
}

/**
 * The room of a loop: the most of the start asset that fits through it
 * given funded sizes. Along the taker's path, holding x of the start asset,
 * leg i pays x/∏_{j<i} q_j and receives x/∏_{j≤i} q_j, each bounded by the
 * leg's funded TakerPays and TakerGets; through a pool, the input at which
 * the pool's average quality after its own price impact closes the loop's
 * gain (bisection).
 */
export function roomOf(cycle) {
  let room = Infinity;
  let acc = 1; // ∏ q_j for j < i
  const gain = edgeOf(cycle).afterFees;
  for (const c of cycle) {
    if (c.pool) {
      // average quality of a constant-product swap of δ in: (R_in + δ(1−f)) / (R_out (1−f)); the loop's other legs multiply to rest = ∏(others' takerQ)
      const rest = cycle.filter((d) => d !== c).reduce((p, d) => p * d.takerQ, 1);
      if (gain > 0 && rest > 0) {
        const Rin = c.pool.in.amount;
        const Rout = c.pool.out.amount;
        const f = c.pool.fee;
        const avgQ = (delta) => (Rin + delta * (1 - f)) / (Rout * (1 - f));
        // find δ where avgQ(δ) · rest = 1
        let lo = 0;
        let hi = Rin;
        if (avgQ(hi) * rest < 1) hi = Rin * 1e6;
        for (let k = 0; k < 100; k++) {
          const mid = (lo + hi) / 2;
          if (avgQ(mid) * rest < 1) lo = mid;
          else hi = mid;
        }
        room = Math.min(room, lo * acc); // δ is in the leg's input asset; back to the start: × ∏ q_j (j < i)
      }
    } else {
      room = Math.min(room, c.funded.pays.amount * acc, c.funded.gets.amount * acc * c.takerQ);
    }
    acc *= c.takerQ;
  }
  return Number.isFinite(room) ? room : 0;
}

/** The constraints of a group of candidates, with the pools' always present. */
const union = (members, candidates, poolConstraintsList) => [...members.flatMap((i) => candidates[i].constraints), ...poolConstraintsList];

/**
 * The nerve of the candidates' cones. `candidates`: [{ id, constraints }];
 * a candidate whose own constraints are infeasible has an empty cone and is
 * no vertex (reported in `empty`). Groups are enumerated upward by size, a
 * group tested only when every subgroup of one less passed; with n assets
 * in play no minimal failing group exceeds n+1 (Helly, Corollary 1), and a
 * larger group is a face if and only if all its (n+1)-subgroups are.
 * @returns {{ vertices: number[], faces: Set<string>, loops: { members: number[], cycle: object[], edge: object, room: number }[], empty: number[], tested: number, assets: number, bound: number }}
 */
export function nerveOf(candidates, pools = [], { minEdge = DEFAULTS.minEdge } = {}) {
  const poolC = pools.flatMap(poolConstraints);
  const assets = new Set([...candidates.flatMap((c) => c.constraints.flatMap((k) => [k.from, k.to])), ...poolC.flatMap((k) => [k.from, k.to]), 'XRP']);
  const n = assets.size;
  const bound = n + 1;
  const vertices = [];
  const empty = []; // candidates whose own offers cross: an empty cone
  const noOffers = []; // candidates with no funded offer at all: nothing to say
  let tested = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (!candidates[i].constraints.length) {
      noOffers.push(i);
      continue;
    }
    tested += 1;
    const f = feasible(union([i], candidates, poolC));
    if (f.feasible) vertices.push(i);
    else empty.push(i);
  }
  const key = (g) => g.join(',');
  const faces = new Set(vertices.map((v) => key([v])));
  const loops = [];
  const closed = [];
  const combos = (arr, size) => {
    const out = [];
    const rec = (start, acc) => {
      if (acc.length === size) {
        out.push([...acc]);
        return;
      }
      for (let i = start; i < arr.length; i++) {
        acc.push(arr[i]);
        rec(i + 1, acc);
        acc.pop();
      }
    };
    rec(0, []);
    return out;
  };
  const subgroupsAllFaces = (g, size) => combos(g, size).every((s) => faces.has(key(s)));
  for (let size = 2; size <= vertices.length; size++) {
    for (const g of combos(vertices, size)) {
      if (!subgroupsAllFaces(g, size - 1)) continue;
      if (size > bound) {
        // Helly: a face when all its (n+1)-subgroups are, which they are (every (size−1)-subgroup is a face by construction)
        faces.add(key(g));
        continue;
      }
      tested += 1;
      const f = feasible(union(g, candidates, poolC));
      if (f.feasible) faces.add(key(g));
      else {
        const edge = edgeOf(f.cycle);
        const entry = { members: g, cycle: f.cycle, edge, room: roomOf(f.cycle) };
        if (edge.afterFees > minEdge) loops.push(entry);
        else closed.push(entry); // the owners' cones do not meet, but the taker's fees close the loop: not reported as a loop
      }
    }
  }
  return { vertices, faces, loops, closed, empty, noOffers, tested, assets: n, bound, candidates: candidates.length };
}

/** The rank of a set of GF(2) vectors (BigInt bitmasks). */
function rankGF2(rows) {
  const basis = [];
  let rank = 0;
  for (let v of rows) {
    for (const b of basis) {
      const hb = b.toString(2).length;
      const hv = v.toString(2).length;
      if (hv === hb) v ^= b;
    }
    // reduce fully: repeat until no basis element shares the leading bit
    let changed = true;
    while (v !== 0n && changed) {
      changed = false;
      const hv = v.toString(2).length;
      for (const b of basis) {
        if (b.toString(2).length === hv) {
          v ^= b;
          changed = true;
          break;
        }
      }
    }
    if (v !== 0n) {
      basis.push(v);
      rank += 1;
    }
  }
  return rank;
}

/**
 * Betti numbers over GF(2) of the complex whose simplices are `faces` (a Set
 * of sorted vertex lists as 'a,b,c'): β_k = dim C_k − rank ∂_k − rank ∂_{k+1}.
 * Returns [β0, β1, …] up to the top dimension present.
 */
export function bettiOf(faces) {
  const byDim = new Map();
  for (const k of faces) {
    const verts = k.split(',').map(Number);
    const d = verts.length - 1;
    (byDim.get(d) ?? byDim.set(d, []).get(d)).push(verts);
  }
  const top = Math.max(-1, ...byDim.keys());
  if (top < 0) return [];
  const indexOf = new Map();
  for (const [d, list] of byDim) {
    list.sort((a, b) => a.join(',').localeCompare(b.join(',')));
    list.forEach((s, i) => indexOf.set(`${d}:${s.join(',')}`, i));
  }
  const rank = new Array(top + 2).fill(0); // rank[d] = rank of ∂_d : C_d → C_{d−1}
  for (let d = 1; d <= top; d++) {
    const rows = [];
    for (const s of byDim.get(d) ?? []) {
      let mask = 0n;
      for (let i = 0; i < s.length; i++) {
        const face = s.filter((_, j) => j !== i);
        const idx = indexOf.get(`${d - 1}:${face.join(',')}`);
        if (idx != null) mask |= 1n << BigInt(idx);
      }
      rows.push(mask);
    }
    rank[d] = rankGF2(rows);
  }
  const betti = [];
  for (let d = 0; d <= top; d++) betti.push((byDim.get(d)?.length ?? 0) - rank[d] - rank[d + 1]);
  return betti;
}

// --- words ---------------------------------------------------------------------------------------

const pct = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}%`;
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a ?? '?');
const assetWord = (asset) => (asset === 'XRP' ? 'XRP' : `${asset.split('/')[0]}.${short(asset.split('/')[1])}`);
const amt = (a) => (a.asset === 'XRP' ? `${(a.amount / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP` : `${a.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${assetWord(a.asset)}`);

/** One leg of a loop in words: "A gives 100 USD.rI for 95 EUR.rJ · q 0.9500 · rate 1.0050 → 0.9548". */
export function describeLeg(c, nameOf = short) {
  if (c.pool) return `pool ${nameOf(c.pool.account)} quotes ${assetWord(c.pool.out.asset)} for ${assetWord(c.pool.in.asset)} at the margin · q ${c.takerQ.toFixed(6)} · fee ${(c.pool.fee * 100).toFixed(3)}%`;
  const rate = c.rateIn !== 1 || c.rateOut !== 1 ? ` · rate in ${c.rateIn.toFixed(4)} out ${c.rateOut.toFixed(4)} → taker q ${c.takerQ.toFixed(6)}` : '';
  return `${nameOf(c.owner)} gives ${amt(c.funded.gets)} for ${amt(c.funded.pays)} · q ${c.nominalQ.toFixed(6)}${rate}`;
}

/** "loop across g accounts · +x.xx% after fees · room y · ledger L", then the legs. */
export function describeLoop(loop, ledger, nameOf = short) {
  const start = loop.cycle[0]?.funded?.pays;
  const room = start ? amt({ asset: start.asset, amount: loop.room }) : '—';
  return [`loop across ${loop.members.length} account${loop.members.length === 1 ? '' : 's'} · ${pct(loop.edge.afterFees)} after fees (nominal ${pct(loop.edge.nominal)}) · room ${room} · ledger #${Number(ledger).toLocaleString('en-US')}`, ...loop.cycle.map((c) => `  ${describeLeg(c, nameOf)}`)];
}

/** The nerve's summary line, and the one sentence this measure allows about it. */
export function describeNerve(nerve, betti, ledger) {
  const b = betti
    .map((x, i) => [x, i])
    .filter(([x, i]) => i < 3 || x !== 0) // the first three always, higher ones only when nonzero
    .map(([x, i]) => `β${'₀₁₂₃₄₅₆₇₈₉'[i] ?? i} ${x}`)
    .join(' · ');
  return `nerve: ${b || 'no vertex'} (${nerve.vertices.length} of ${nerve.candidates} candidates with a nonempty cone, ${nerve.assets} assets, ${nerve.tested} groups tested, ledger #${Number(ledger).toLocaleString('en-US')}) · with every pair sharing a price, β₁ counts the independent loops; nothing further is read into the numbers`;
}

/**
 * The whole measure at a ledger: candidates [{ id, address, constraints }],
 * pools, the counts of what was excluded, and the words.
 */
export function sharedPriceAt({ ledger, focus, candidates, pools = [], excluded = {}, selection = '', nameOf = short, replay = false }) {
  const t0 = globalThis.performance?.now?.() ?? Date.now();
  const nerve = nerveOf(candidates, pools);
  const betti = bettiOf(nerve.faces);
  const all = nerve.vertices.length ? nerve.faces.has(nerve.vertices.join(',')) : false;
  const lines = [];
  lines.push(selection);
  if (!candidates.length || !candidates.find((c) => c.id === focus)?.constraints.length) lines.push('the probed account has no funded offers at this ledger: nothing lit');
  else if (all) lines.push(`one price fits: the ${nerve.vertices.length} candidates share a price at ledger #${Number(ledger).toLocaleString('en-US')}`);
  for (const loop of nerve.loops) lines.push(...describeLoop(loop, ledger, nameOf));
  if (nerve.closed.length) lines.push(`${nerve.closed.length} loop${nerve.closed.length === 1 ? '' : 's'} the fees close (the owners' cones do not meet, the taker's fees take the edge): not reported as loops`);
  if (nerve.empty.length) lines.push(`${nerve.empty.length} candidate${nerve.empty.length === 1 ? '' : 's'} whose own offers cross (empty cone): not a vertex`);
  if (nerve.noOffers.length) lines.push(`${nerve.noOffers.length} candidate${nerve.noOffers.length === 1 ? '' : 's'} with no funded offer at this ledger: not a vertex`);
  lines.push(describeNerve(nerve, betti, ledger));
  const ex = Object.entries(excluded).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  if (ex.length) lines.push(`excluded and counted: ${ex.join(', ')}`);
  lines.push(`rippling through trust lines is out of scope this pass; trust-line QualityIn/QualityOut are not applied (the engine applies them in direct steps)${replay ? ' · a replay: offers taken at face (funding is not in the record), offers created before the window unseen' : ''}`);
  const ms = (globalThis.performance?.now?.() ?? Date.now()) - t0;
  lines.push(`measured in ${ms.toFixed(0)} ms`);
  return { version: SHARED_PRICE_VERSION, ledger, nerve, betti, all, lines, ms, lit: nerve.loops.flatMap((l) => l.members.map((i) => candidates[i].id)) };
}

// --- the loop-take rule ---------------------------------------------------------------------------

/** The offers a transaction consumed, from its metadata: Offer nodes of other owners whose TakerGets fell or that were deleted with a trade. */
export function consumedOffers(tx, meta) {
  const out = [];
  for (const n of meta?.AffectedNodes ?? []) {
    const node = n.ModifiedNode ?? n.DeletedNode;
    if (!node || node.LedgerEntryType !== 'Offer') continue;
    const fin = node.FinalFields ?? {};
    const prev = node.PreviousFields ?? {};
    if (fin.Account === tx?.Account) continue;
    if (n.DeletedNode && prev.TakerGets == null && prev.TakerPays == null) continue; // a cleanup or cancel, not a trade
    const before = prev.TakerGets != null ? valueOf(prev.TakerGets) : null;
    const after = valueOf(fin.TakerGets);
    if (n.ModifiedNode && !(before > after)) continue;
    const paysBefore = prev.TakerPays != null ? valueOf(prev.TakerPays) : null;
    const paysAfter = valueOf(fin.TakerPays);
    // the traded part is the previous amount less the final one, for a deleted offer too: an offer removed unfunded after a partial trade keeps its remainder in FinalFields
    out.push({ owner: fin.Account, sequence: fin.Sequence, gave: before != null && Number.isFinite(after) ? before - after : null, asset: assetOf(fin.TakerGets), got: paysBefore != null && Number.isFinite(paysAfter) ? paysBefore - paysAfter : null, paysAsset: assetOf(fin.TakerPays) });
  }
  return out;
}

const isCrossCurrency = (tx) => {
  if (tx?.TransactionType !== 'Payment') return false;
  if (Array.isArray(tx.Paths) && tx.Paths.length) return true;
  const a = assetOf(tx.Amount ?? tx.DeliverMax);
  const s = tx.SendMax != null ? assetOf(tx.SendMax) : null;
  return s != null && a != null && s !== a;
};

/**
 * The loop-take rule (docs/universe.md, Part A): (1) a Payment whose Account
 * equals its Destination that consumed offers AND sends what it delivers (the
 * SendMax asset, or XRP when there is none, equals the Amount's: a circular
 * payment; a self-payment that converts one asset into another is a
 * conversion, returned with `circular: false` and not a loop); (2) a same-ledger pair: an
 * OfferCreate by X and a cross-currency Payment by Y (≠ X) that consumed an
 * offer X created in that same ledger, matched by owner and sequence (the
 * pattern of Fig. 1 of Jack the Rippler, arXiv:2106.16158).
 * @param {{ tx: object, meta: object, hash: string|null, ledgerIndex: number }[]} txs  one ledger's transactions in order
 */
export function loopTakes(txs) {
  const out = [];
  const created = new Map(); // owner:sequence → hash of the OfferCreate in this ledger
  for (const t of txs) {
    if (t.tx?.TransactionType === 'OfferCreate' && t.meta?.TransactionResult === 'tesSUCCESS') {
      for (const n of t.meta.AffectedNodes ?? []) {
        if (n.CreatedNode?.LedgerEntryType === 'Offer') created.set(`${n.CreatedNode.NewFields?.Account}:${n.CreatedNode.NewFields?.Sequence}`, t.hash);
      }
    }
  }
  for (const t of txs) {
    const tx = t.tx;
    if (tx?.TransactionType !== 'Payment' || t.meta?.TransactionResult !== 'tesSUCCESS') continue;
    const offers = consumedOffers(tx, t.meta);
    if (!offers.length) continue;
    if (tx.Account === tx.Destination) {
      const sends = tx.SendMax != null ? assetOf(tx.SendMax) : 'XRP';
      const delivers = assetOf(tx.Amount ?? tx.DeliverMax);
      const circular = sends != null && sends === delivers;
      out.push({ kind: 'self-payment', circular, sends, delivers, taker: tx.Account, hash: t.hash, ledgerIndex: t.ledgerIndex, offers, rule: circular ? 'Account equals Destination; the asset sent is the asset delivered; offers consumed' : 'Account equals Destination; offers consumed; a conversion (the asset sent differs from the asset delivered): not a loop' });
      continue;
    }
    if (isCrossCurrency(tx)) {
      const paired = offers.filter((o) => created.has(`${o.owner}:${o.sequence}`) && o.owner !== tx.Account);
      if (paired.length) out.push({ kind: 'pair', taker: tx.Account, maker: paired[0].owner, hash: t.hash, makerHash: created.get(`${paired[0].owner}:${paired[0].sequence}`), ledgerIndex: t.ledgerIndex, offers, rule: 'a cross-currency Payment consuming an offer created in the same ledger by another account' });
    }
  }
  return out;
}

// --- offers from a recording's metadata --------------------------------------------------------

/**
 * The book state of a replay, from Offer nodes in the metadata: created
 * offers added, modified ones updated to their final fields, deleted ones
 * removed; an offer first seen modified was created before the window and
 * is kept at its final state, flagged. Funding is not in the record: offers
 * are taken at face.
 */
export class BookState {
  constructor() {
    this.offers = new Map(); // owner:sequence → { Account, Sequence, TakerGets, TakerPays, since, unseenCreation }
    this.ledger = null;
    this.unseenCreations = 0;
  }

  apply(tx, meta, ledgerIndex) {
    if (!meta || meta.TransactionResult !== 'tesSUCCESS') return;
    this.ledger = ledgerIndex ?? this.ledger;
    for (const n of meta.AffectedNodes ?? []) {
      if (n.CreatedNode?.LedgerEntryType === 'Offer') {
        const f = n.CreatedNode.NewFields ?? {};
        this.offers.set(`${f.Account}:${f.Sequence}`, { Account: f.Account, Sequence: f.Sequence, TakerGets: f.TakerGets, TakerPays: f.TakerPays, since: ledgerIndex, unseenCreation: false });
      } else if (n.ModifiedNode?.LedgerEntryType === 'Offer') {
        const f = n.ModifiedNode.FinalFields ?? {};
        const key = `${f.Account}:${f.Sequence}`;
        const had = this.offers.get(key);
        if (!had) this.unseenCreations += 1;
        this.offers.set(key, { Account: f.Account, Sequence: f.Sequence, TakerGets: f.TakerGets, TakerPays: f.TakerPays, since: had?.since ?? null, unseenCreation: !had });
      } else if (n.DeletedNode?.LedgerEntryType === 'Offer') {
        const f = n.DeletedNode.FinalFields ?? {};
        this.offers.delete(`${f.Account}:${f.Sequence}`);
      }
    }
  }

  /** The open offers of an account. */
  ofAccount(address) {
    return [...this.offers.values()].filter((o) => o.Account === address);
  }

  /** The open offers on a book (both directions): TakerGets asset and TakerPays asset in either order. */
  onBook(assetA, assetB) {
    return [...this.offers.values()].filter((o) => {
      const g = assetOf(o.TakerGets);
      const p = assetOf(o.TakerPays);
      return (g === assetA && p === assetB) || (g === assetB && p === assetA);
    });
  }

  snapshot() {
    const s = new BookState();
    s.offers = new Map([...this.offers].map(([k, v]) => [k, { ...v }]));
    s.ledger = this.ledger;
    s.unseenCreations = this.unseenCreations;
    return s;
  }
}

/**
 * The candidates from a book state or book_offers results: the focused
 * account and, per book its funded offers touch, the busiest makers by
 * funded TakerGets, capped. Returns the candidate list with constraints, the
 * books, the selection sentence and the exclusion counts.
 */
export function candidatesOf({ focus, focusOffers, bookOffers, books: booksGiven = null, rates = new Map(), takerIssues = () => false, makersPerBook = DEFAULTS.makersPerBook, cap = DEFAULTS.candidates, frozen = new Set(), unauthorized = new Set() }) {
  const excluded = { unfunded: 0, 'on frozen lines': 0, 'on unauthorized lines': 0, 'beyond the cap': 0 };
  const build = (address, offers) => {
    const constraints = [];
    for (const o of offers) {
      const key = `${o.Account}:${o.Sequence}`;
      if (frozen.has(key)) {
        excluded['on frozen lines'] += 1;
        continue;
      }
      if (unauthorized.has(key)) {
        excluded['on unauthorized lines'] += 1;
        continue;
      }
      const c = constraintOf(o, { rates, takerIssues });
      if (!c) {
        excluded.unfunded += 1;
        continue;
      }
      constraints.push(c);
    }
    return { id: address, address, constraints };
  };
  const focusC = build(focus, focusOffers);
  const books = booksGiven ? [...new Set(booksGiven)] : [...new Set(focusC.constraints.map((c) => [c.from, c.to].sort().join('|')))];
  const makers = new Map(); // address → offers
  for (const book of books) {
    const offers = (bookOffers.get(book) ?? []).filter((o) => o.Account !== focus);
    const byOwner = new Map();
    for (const o of offers) (byOwner.get(o.Account) ?? byOwner.set(o.Account, []).get(o.Account)).push(o);
    const ranked = [...byOwner.entries()]
      .map(([a, list]) => [a, list, list.reduce((s, o) => s + (fundedOf(o)?.gets.amount ?? 0), 0)])
      .filter(([, , size]) => size > 0)
      .sort((x, y) => y[2] - x[2])
      .slice(0, makersPerBook);
    for (const [a, list] of ranked) (makers.get(a) ?? makers.set(a, []).get(a)).push(...list);
  }
  const candidates = [focusC];
  for (const [a, list] of makers) {
    if (candidates.length >= cap) {
      excluded['beyond the cap'] += 1;
      continue;
    }
    candidates.push(build(a, list));
  }
  const selection = `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}: the probed account and the ${makersPerBook} largest makers by funded size on each of its ${books.length} book${books.length === 1 ? '' : 's'} (cap ${cap})`;
  return { candidates, books, selection, excluded };
}
