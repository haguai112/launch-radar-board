// Launch Radar model: implied launch value for pre-token protocols.
//
// Method, in one paragraph: protocols whose token already trades are the
// only honest yardstick in the snapshot, so the model measures them first.
// For each category it takes the median market-cap / TVL multiple of the
// token-bearing protocols, shrunk toward the global median when a category
// has few traded names. A pre-token protocol's base value is its TVL times
// its category's shrunk multiple. Three bounded adjustments follow, all
// from the snapshot's own fields: seven-day TVL momentum (clamped, worth
// at most +/-15%), seasoning - whole years the protocol has run with no
// token recorded (up to +16%) - and chain reach (up to +10%). A separate
// launch-odds score blends the category's historical launch propensity
// with size and seasoning; it orders nothing on the board, it only tells
// the reader where farming time is most likely to be rewarded.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  multiple: number;
  launch_odds_pct: number;
  years_live: number | null;
}

export const MODEL_VERSION = 'launch-radar v1: shrunk category multiples';
export const BOARD_SIZE = 240;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot is missing protocols or watchlist');
  }
  return raw;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Whole years between the protocol's first tracked day and the snapshot date. */
export function yearsLive(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const start = Date.parse(`${p.listed_at}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.floor((end - start) / (365.25 * 24 * 3600 * 1000) * 10) / 10;
}

interface CategoryStats {
  multiple: number;
  traded: number;
  preToken: number;
}

/** Median mcap/TVL per category over traded protocols, shrunk to the global median. */
export function categoryMultiples(snapshot: Snapshot): Map<string, CategoryStats> {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  // Winsorise each peer multiple before any median: one traded name with a
  // near-zero TVL denominator would otherwise price a whole category at
  // hundreds of times TVL, and no reader would believe the board.
  const peerMultiple = (p: Protocol): number => clamp(p.mcap_usd! / p.tvl_usd, 0.02, 5);
  const globalMedian = median(traded.map(peerMultiple));
  const byCategory = new Map<string, number[]>();
  const preCount = new Map<string, number>();
  for (const p of traded) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(peerMultiple(p));
    byCategory.set(key, list);
  }
  for (const p of snapshot.protocols) {
    if (p.gecko_id === null && p.symbol === null) {
      const key = p.category ?? 'Uncategorised';
      preCount.set(key, (preCount.get(key) ?? 0) + 1);
    }
  }
  const stats = new Map<string, CategoryStats>();
  for (const [key, values] of byCategory) {
    const n = values.length;
    const shrunk = (n * median(values) + 4 * globalMedian) / (n + 4);
    stats.set(key, { multiple: shrunk, traded: n, preToken: preCount.get(key) ?? 0 });
  }
  for (const [key, count] of preCount) {
    if (!stats.has(key)) stats.set(key, { multiple: globalMedian, traded: 0, preToken: count });
  }
  return stats;
}

const FALLBACK: CategoryStats = { multiple: 0.2, traded: 0, preToken: 0 };

export function scoreProtocol(
  p: Protocol,
  snapshot: Snapshot,
  stats: Map<string, CategoryStats>,
): { value: number; multiple: number; odds: number; years: number | null } {
  const key = p.category ?? 'Uncategorised';
  const stat = stats.get(key) ?? FALLBACK;
  const years = yearsLive(p, snapshot.as_of);
  const momentum = p.change_7d === null ? 0 : clamp(p.change_7d, -30, 30);
  const momentumFactor = 1 + (momentum / 100) * 0.5;
  const seasoningFactor = years === null ? 1 : 1 + Math.min(years, 4) * 0.04;
  const reachFactor = 1 + Math.min(Math.max(p.chains.length - 1, 0), 10) * 0.01;
  const value = Math.max(1, Math.round(p.tvl_usd * stat.multiple * momentumFactor * seasoningFactor * reachFactor));
  // Launch odds: the category's traded share, lifted by size and seasoning, capped.
  const propensity = stat.traded + stat.preToken === 0 ? 0.3 : stat.traded / (stat.traded + stat.preToken);
  const sizeLift = clamp(Math.log10(Math.max(p.tvl_usd, 1)) - 7, 0, 2) * 6; // +0..12 over $10M..$1B
  const seasonLift = years === null ? 0 : Math.min(years, 5) * 2.4; // +0..12
  const odds = Math.round(clamp(propensity * 62 + sizeLift + seasonLift + 6, 5, 92));
  return { value, multiple: stat.multiple, odds, years };
}

function money(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(0)}M`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

function stakeBand(tvl: number): string {
  if (tvl >= 5e8) return '$2,000-$5,000';
  if (tvl >= 1e8) return '$1,000-$3,000';
  if (tvl >= 2.5e7) return '$500-$1,500';
  return '$250-$750';
}

const CORE_ACTION: Record<string, string> = {
  Lending: 'supply a blue-chip collateral asset and take one small, well-collateralised borrow',
  Dexs: 'add a two-sided position in its deepest pair and route your normal swaps through it',
  Yield: 'deposit into its flagship vault and leave the position untouched for a full week',
  'Yield Aggregator': 'deposit into its flagship vault and leave the position untouched for a full week',
  RWA: 'complete onboarding and hold its smallest tokenised treasury or credit position',
  Bridge: 'move a real transfer across its busiest corridor instead of your usual bridge',
  'Cross Chain Bridge': 'move a real transfer across its busiest corridor instead of your usual bridge',
  'Liquid Staking': 'stake a small amount and hold the liquid staking receipt for a full epoch',
  'Risk Curators': 'allocate to one curated vault whose strategy you can explain in one sentence',
  'Onchain Capital Allocator': 'allocate to one flagship vault and track its reported strategy weekly',
  CDP: 'open a small collateralised debt position well inside its liquidation line',
  'Basis Trading': 'fund its basis vault with a starter tranche and read one weekly report',
  Chain: 'fund a wallet on the chain, pay real gas and use two native applications',
  Payments: 'make one real payment or transfer through it, however small',
  Insurance: 'buy or underwrite its smallest live cover policy',
  Restaking: 'restake a small liquid-staking position and keep it through one full epoch',
  CEX: 'trade your normal spot volume on the exchange and hold a modest working balance there',
  'Prediction Market': 'trade small, genuinely held positions in its most liquid markets',
  'Canonical Bridge': 'bridge real funds to the chain it serves and use them there instead of moving them back',
};

export function farmSteps(p: Protocol, tvl: number): string[] {
  const cat = p.category ?? 'protocol';
  const action = CORE_ACTION[p.category ?? ''] ?? 'use its core product with a real, if small, position';
  const chainText = p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'its home chain';
  const stake = stakeBand(tvl);
  const growth =
    p.change_7d === null
      ? 'TVL was flat in the latest snapshot week'
      : `TVL moved ${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in the last seven days`;
  return [
    `Start on ${chainText}: ${action} on ${p.name} with ${stake} of working capital; budget about $10-$40 for gas and fees and 45 minutes for the first setup.`,
    `Repeat the core action weekly for six to eight weeks: ${p.name} is a ${cat} protocol holding ${money(tvl)}, and steady, dated activity reads very differently from one large deposit made in a single day.`,
    `Keep the position live through at least one full month-end and screenshot your balances monthly; ${growth}, so a position opened before a snapshot-style review is the one that counts.`,
    `Do the free work too: join ${p.name}'s governance or community channels, vote on any live proposal and finish any official points or quest programme it runs; allow one hour a month and no spend.`,
    `Stay claim-ready: keep the same wallet active, never buy a 'guaranteed airdrop' service, and if ${p.name} announces a token, claim only from its official site - expect two to four hours of checking in launch week.`,
  ];
}

const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * A wrapped, staked or bridged product of a token that already trades is
 * not a launch candidate, however the snapshot records it: WBTC is Bitcoin
 * on Ethereum, not a protocol awaiting a token. The board applies the same
 * product filter the watchlist rule uses, so its rows are independent
 * protocols that record no token of their own.
 */
export function isLaunchCandidate(p: Protocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const stats = categoryMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter(
    (p) => p.gecko_id === null && p.symbol === null && (watch.has(p.slug) || isLaunchCandidate(p)),
  );
  const scored = preToken.map((p) => {
    const s = scoreProtocol(p, snapshot, stats);
    return { p, ...s };
  });
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug));
  // The watchlist always boards in full; the rest of the board is the top of the scored field.
  const chosen = new Map<string, (typeof scored)[number]>();
  for (const row of scored.slice(0, BOARD_SIZE)) chosen.set(row.p.slug, row);
  for (const row of scored) if (watch.has(row.p.slug)) chosen.set(row.p.slug, row);
  const finalRows = [...chosen.values()].sort(
    (a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug),
  );
  return finalRows.map((row, i) => ({
    slug: row.p.slug,
    name: row.p.name,
    rank: i + 1,
    implied_value_usd: row.value,
    farm_steps: farmSteps(row.p, row.p.tvl_usd),
    category: row.p.category,
    chains: row.p.chains,
    tvl_usd: row.p.tvl_usd,
    change_7d: row.p.change_7d,
    listed_at: row.p.listed_at,
    watchlist: watch.has(row.p.slug),
    multiple: Math.round(row.multiple * 1000) / 1000,
    launch_odds_pct: row.odds,
    years_live: row.years,
  }));
}

/** One-line explanation of the model, shown on the dashboard and in the data file. */
export const MODEL_NOTE =
  'Implied value = TVL x the shrunk median market-cap/TVL multiple of traded peers in the same category ' +
  '(peer multiples winsorised to 0.02-5x so one outlier cannot price a category), adjusted for 7-day TVL ' +
  'momentum (at most +/-15%), years live with no token recorded (up to +16%) and chain reach (up to +10%). ' +
  'Launch odds blend the category launch propensity with size and seasoning.';

/** Serialise the dashboard's data as a script the static page reads with no network. */
export function dataScript(snapshot: Snapshot, rows: BoardRow[]): string {
  const payload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model_note: MODEL_NOTE,
    watchlist_size: snapshot.watchlist.length,
    protocol_count: snapshot.protocols.length,
    rows,
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}

/** Return a short reason the board would fail the gate, or null when it passes. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100-4000`;
  const slugs = new Set(rows.map((r) => r.slug));
  if (slugs.size !== rows.length) return 'board holds a slug twice';
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return `watchlist slug ${slug} is missing`;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.rank !== i + 1) return `row ${row.slug} carries rank ${row.rank}`;
    if (i > 0 && rows[i - 1]!.implied_value_usd < row.implied_value_usd) return 'values rise as rank ascends';
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `a farm step of ${row.slug} is ${len} characters`;
    }
  }
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  return null;
}
