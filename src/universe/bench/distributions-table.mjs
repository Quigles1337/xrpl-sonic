#!/usr/bin/env node
// UNIVERSE phase 1 — the distributions table for docs/universe.md, from the result file.
//
//   node src/universe/bench/distributions-table.mjs [results/distributions-mainnet.json]

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'src/universe/bench/results/distributions-mainnet.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const fmt = (n, digits = 0) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits }));
const hist = (h) => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${fmt(v)}`).join(' · ');
const q = (o, digits = 0) => (o ? Object.entries(o).map(([k, v]) => `${k} ${fmt(v, digits)}`).join(' · ') : '—');
const t = d.thresholds;
const out = [];
out.push(`From \`bench/distributions.mjs\` against ${d.network} (${(d.endpoint ?? '').replace(/^wss:\/\//, '')}), ${fmt(d.elapsedMinutes, 1)} minutes from ${d.startedAt}: ${fmt(d.planets)} planets, ${fmt(d.coverage.transactions)} transactions heard of ${fmt(d.coverage.expected)} (${d.coverage.share == null ? '—' : (d.coverage.share * 100).toFixed(2) + '%'}), ${fmt(d.recordsKept)} records kept. Each row is a threshold, what it cuts, and where the hour's values fell.`);
out.push('');
out.push('| Threshold | Rule | The hour’s distribution |');
out.push('| --- | --- | --- |');
out.push(`| Star: holders ≥ ${t.starHolders} | An issuer named by its holders’ trust lines in the records heard | ${fmt(d.holdersPerIssuer.issuers)} issuers seen, ${fmt(d.holdersPerIssuer.atOrAboveStar)} at or above the bar; holders per issuer: ${hist(d.holdersPerIssuer.histogram)}; quantiles ${q(d.holdersPerIssuer.quantiles)} |`);
out.push(`| Hub: counterparties > ${t.hubDegree} | A planet with more counterparties never glues a cluster | ${fmt(d.degree.hubs)} hubs of ${fmt(d.planets)} planets; counterparties per planet: ${hist(d.degree.histogram)}; quantiles ${q(d.degree.quantiles)}; the five busiest: ${(d.degree.top ?? []).map((x) => `${fmt(x.degree)} (${x.kind}, ${fmt(x.submitted)} submitted)`).join(', ')} |`);
out.push(`| Cluster edge: ≥ ${t.clusterEdge} namings; nebula: ≥ ${t.nebulaSize} planets | Two planets named together twice or more are one cluster; a cluster of five is a nebula | ${fmt(d.clusters.groupsOfTwoOrMore)} clusters of two or more, ${fmt(d.clusters.nebulae)} nebulae holding ${fmt(d.clusters.planetsInNebulae)} planets, the largest ${fmt(d.clusters.largest)}; sizes: ${hist(d.clusters.histogram)}; ${fmt(d.clusters.unions)} unions, ${fmt(d.clusters.hubSkips)} edges refused for a hub |`);
out.push(`| Pulsar: self-correlation ≥ ${t.pulsarLeast} at a period ≥ ${t.pulsarMinPeriod} | A cadence from coherence over the live window, among the top ${t.coherenceTop} submitters | ${fmt(d.cadences.accountsJudged)} accounts judged over ${fmt(d.cadences.runs)} runs (${fmt(d.cadences.meanMs)} ms each), ${fmt(d.cadences.withCadence)} with a cadence at the last run; periods: ${hist(d.cadences.histogram)}; ${fmt(d.cadences.pairsInStepEver)} distinct pairs ever in step |`);
out.push(`| Planet size: log10 of the XRP balance | From the last AccountRoot seen; unknown drawn hollow | balance seen for ${fmt(d.balances.known)} planets, not for ${fmt(d.balances.unknown)}; XRP: ${hist(d.balances.histogramXrp)}; quantiles ${q(d.balances.xrpQuantiles, 2)} |`);
out.push(`| Open offers (a count in the text) | Offer entries created minus deleted in the records heard | ${fmt(d.openOffers.planetsWithOpen)} planets with open offers: ${hist(d.openOffers.histogram)} |`);
out.push(`| The kinds | By precedence: collapsed, binary, black hole candidate, star, pulsar, planet | ${Object.entries(d.kinds).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}; ${fmt(d.pools)} AMM pools, ${fmt(d.blackholeCandidates)} black hole candidates, ${fmt(d.born)} born, ${fmt(d.collapsed)} collapsed, ${fmt(d.domains)} with an on-ledger Domain, ${fmt(d.minted)} that minted an NFT |`);
out.push(`| Batch | A flash in the glyph’s colour | ${fmt(d.batch.outer)} Batch transactions (${d.batch.shareOfTransactions == null ? '—' : (d.batch.shareOfTransactions * 100).toFixed(1) + '%'} of those heard), ${fmt(d.batch.inner)} inner transactions flagged tfInnerBatchTxn |`);
process.stdout.write(out.join('\n'));
