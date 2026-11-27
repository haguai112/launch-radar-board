// Launch Radar model: implied launch value for pre-token protocols.
//
// Method, in one paragraph: protocols whose token already trades are the
// only honest yardstick in the snapshot, so the model measures them first.
// The level of each price is the median market-cap / TVL multiple of the
// traded protocols in the same category, shrunk toward the global median
// when a category has few traded names. A log-log regression of market cap
// on TVL - fitted globally, and per category where at least five names
// trade, shrunk toward the global fit - then tilts that level for size:
// the fit says how much thinner or richer a multiple typically runs at
// this protocol's TVL than at the category's typical traded size, and the
// board applies that tilt damped and bounded (a factor of 0.77 to 1.26).
// The regression is deliberately not allowed to set the level itself: on
// this snapshot it explains only about a fifth of the variance in market
// caps, so using it as the price would let its weakest property - blind
// compression of very large TVLs - run the board. Three bounded
// adjustments follow, all from the snapshot's own fields: seven-day TVL
// momentum (clamped, worth at most +/-15%), seasoning - whole years the
// protocol has run with no token recorded (up to +16%) - and chain reach
// (up to +10%). A separate launch-odds score blends the category's
// historical launch propensity with size and seasoning; it orders nothing
// on the board, it only tells the reader where farming time is most
// likely to be rewarded.

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
  peers: number;
  launch_odds_pct: number;
  years_live: number | null;
}

export const MODEL_VERSION = 'launch-radar v2: category median multiples with a shrunk log-log regression size tilt';
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

interface CategoryModel {
  /** Shrunk median mcap/TVL multiple of the category's traded protocols. */
  multiple: number;
  /** Log-log fit ln(mcap) = intercept + slope * ln(TVL), shrunk to the global fit. */
  intercept: number;
  slope: number;
  /** Median TVL of the category's fittable traded peers: the size the fit is anchored at. */
  refTvl: number;
  traded: number;
  preToken: number;
}

interface Fit {
  intercept: number;
  slope: number;
}

/** Ordinary least squares of ln(mcap) on ln(TVL); slope bounded to a sane band. */
function fitLogLog(points: { tvl: number; mcap: number }[]): Fit {
  const xs = points.map((pt) => Math.log(pt.tvl));
  const ys = points.map((pt) => Math.log(pt.mcap));
  const n = points.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = sxx === 0 ? 1 : clamp(sxy / sxx, 0.3, 1.3);
  return { intercept: my - slope * mx, slope };
}

/**
 * Peer models per category: a shrunk median multiple and a shrunk log-log
 * regression, both fitted on the traded protocols only.
 */
export function categoryModels(snapshot: Snapshot): Map<string, CategoryModel> {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  // Winsorise each peer multiple before any median: one traded name with a
  // near-zero TVL denominator would otherwise price a whole category at
  // hundreds of times TVL, and no reader would believe the board.
  const peerMultiple = (p: Protocol): number => clamp(p.mcap_usd! / p.tvl_usd, 0.02, 5);
  const globalMedian = median(traded.map(peerMultiple));
  // The regression reads logs, so a peer recorded with a zero market cap
  // (listed, but no cap reported) would poison every fit with NaNs; such
  // peers still count for the medians, never for the regression.
  const fittable = traded.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const globalFit = fitLogLog(fittable.map((p) => ({ tvl: p.tvl_usd, mcap: p.mcap_usd! })));
  const multiplesByCat = new Map<string, number[]>();
  const pointsByCat = new Map<string, { tvl: number; mcap: number }[]>();
  const preCount = new Map<string, number>();
  for (const p of traded) {
    const key = p.category ?? 'Uncategorised';
    const list = multiplesByCat.get(key) ?? [];
    list.push(peerMultiple(p));
    multiplesByCat.set(key, list);
    if (p.mcap_usd !== null && p.mcap_usd > 0) {
      const pts = pointsByCat.get(key) ?? [];
      pts.push({ tvl: p.tvl_usd, mcap: p.mcap_usd! });
      pointsByCat.set(key, pts);
    }
  }
  for (const p of snapshot.protocols) {
    if (p.gecko_id === null && p.symbol === null) {
      const key = p.category ?? 'Uncategorised';
      preCount.set(key, (preCount.get(key) ?? 0) + 1);
    }
  }
  const globalRefTvl = median(fittable.map((p) => p.tvl_usd));
  const models = new Map<string, CategoryModel>();
  for (const [key, values] of multiplesByCat) {
    const n = values.length;
    const shrunk = (n * median(values) + 4 * globalMedian) / (n + 4);
    // A category earns its own regression at five traded names; below that
    // it borrows the global fit whole. Above it, the fit is shrunk toward
    // the global one with weight n / (n + 8).
    let fit: Fit = globalFit;
    const ownPoints = pointsByCat.get(key) ?? [];
    if (n >= 5 && ownPoints.length >= 3) {
      const own = fitLogLog(ownPoints);
      const w = n / (n + 8);
      fit = {
        intercept: w * own.intercept + (1 - w) * globalFit.intercept,
        slope: w * own.slope + (1 - w) * globalFit.slope,
      };
    }
    models.set(key, {
      multiple: shrunk,
      intercept: fit.intercept,
      slope: fit.slope,
      refTvl: ownPoints.length > 0 ? median(ownPoints.map((pt) => pt.tvl)) : globalRefTvl,
      traded: n,
      preToken: preCount.get(key) ?? 0,
    });
  }
  for (const [key, count] of preCount) {
    if (!models.has(key)) {
      models.set(key, {
        multiple: globalMedian,
        intercept: globalFit.intercept,
        slope: globalFit.slope,
        refTvl: globalRefTvl,
        traded: 0,
        preToken: count,
      });
    }
  }
  return models;
}

const FALLBACK: CategoryModel = { multiple: 0.2, intercept: 0, slope: 1, refTvl: 1e8, traded: 0, preToken: 0 };

export function scoreProtocol(
  p: Protocol,
  snapshot: Snapshot,
  models: Map<string, CategoryModel>,
): { value: number; multiple: number; peers: number; odds: number; years: number | null } {
  const key = p.category ?? 'Uncategorised';
  const model = models.get(key) ?? FALLBACK;
  const years = yearsLive(p, snapshot.as_of);
  // The category median multiple sets the level. The regression then
  // tilts it for size: the multiple the fit implies at this TVL, divided
  // by the multiple it implies at the category's typical traded size,
  // bounded to 0.6-1.6 and square-root damped before it is applied.
  const fitMultipleAt = (tvl: number): number =>
    Math.exp(model.intercept + (model.slope - 1) * Math.log(Math.max(tvl, 1)));
  const tilt = clamp(fitMultipleAt(p.tvl_usd) / Math.max(fitMultipleAt(model.refTvl), 1e-9), 0.6, 1.6);
  const base = p.tvl_usd * model.multiple * Math.sqrt(tilt);
  const momentum = p.change_7d === null ? 0 : clamp(p.change_7d, -30, 30);
  const momentumFactor = 1 + (momentum / 100) * 0.5;
  const seasoningFactor = years === null ? 1 : 1 + Math.min(years, 4) * 0.04;
  const reachFactor = 1 + Math.min(Math.max(p.chains.length - 1, 0), 10) * 0.01;
  const value = Math.max(1, Math.round(base * momentumFactor * seasoningFactor * reachFactor));
  // Launch odds: the category's traded share, lifted by size and seasoning, capped.
  const propensity = model.traded + model.preToken === 0 ? 0.3 : model.traded / (model.traded + model.preToken);
  const sizeLift = clamp(Math.log10(Math.max(p.tvl_usd, 1)) - 7, 0, 2) * 6; // +0..12 over $10M..$1B
  const seasonLift = years === null ? 0 : Math.min(years, 5) * 2.4; // +0..12
  const odds = Math.round(clamp(propensity * 62 + sizeLift + seasonLift + 6, 5, 92));
  return { value, multiple: p.tvl_usd > 0 ? base / p.tvl_usd : 0, peers: model.traded, odds, years };
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

export function farmSteps(p: Protocol, tvl: number, peers: number, multiple: number): string[] {
  const cat = p.category ?? 'protocol';
  const action = CORE_ACTION[p.category ?? ''] ?? 'use its core product with a real, if small, position';
  const chainText = p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'its home chain';
  const stake = stakeBand(tvl);
  const growth =
    p.change_7d === null
      ? 'TVL was flat in the latest snapshot week'
      : `TVL moved ${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in the last seven days`;
  const peerText =
    peers > 0
      ? `The board prices ${p.name} off ${peers} traded ${cat} peer${peers === 1 ? '' : 's'} at a fitted ${multiple.toFixed(2)}x of TVL`
      : `No ${cat} peer trades yet, so the board prices ${p.name} off the global peer fit`;
  return [
    `Start on ${chainText}: ${action} on ${p.name} with ${stake} of working capital; budget about $10-$40 for gas and fees and 45 minutes for the first setup.`,
    `Repeat the core action weekly for six to eight weeks: ${p.name} is a ${cat} protocol holding ${money(tvl)}, and steady, dated activity reads very differently from one large deposit made in a single day.`,
    `Keep the position live through at least one full month-end and screenshot your balances monthly; ${growth}, so a position opened before a snapshot-style review is the one that counts.`,
    `${peerText}: if a closer peer launches first at a very different multiple, re-check this position's size before adding more - the model's anchor moves with the peer set.`,
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
  const models = categoryModels(snapshot);
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter(
    (p) => p.gecko_id === null && p.symbol === null && (watch.has(p.slug) || isLaunchCandidate(p)),
  );
  const scored = preToken.map((p) => {
    const s = scoreProtocol(p, snapshot, models);
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
    farm_steps: farmSteps(row.p, row.p.tvl_usd, row.peers, row.multiple),
    category: row.p.category,
    chains: row.p.chains,
    tvl_usd: row.p.tvl_usd,
    change_7d: row.p.change_7d,
    listed_at: row.p.listed_at,
    watchlist: watch.has(row.p.slug),
    multiple: Math.round(row.multiple * 1000) / 1000,
    peers: row.peers,
    launch_odds_pct: row.odds,
    years_live: row.years,
  }));
}

/** One-line explanation of the model, shown on the dashboard and in the data file. */
export const MODEL_NOTE =
  'Implied value = TVL x the shrunk median market-cap/TVL multiple of traded peers in the same category ' +
  '(peer multiples winsorised to 0.02-5x so one outlier cannot price a category), tilted for size by a ' +
  'log-log regression of market cap on TVL fitted to the traded protocols (per category where at least ' +
  'five peers trade, shrunk toward the global fit; the tilt is bounded and damped, a factor of 0.77-1.26, ' +
  'because the fit explains only about a fifth of cap variance and is not trusted to set levels). The ' +
  'result is adjusted for 7-day TVL momentum (at most +/-15%), years live with no token recorded (up to ' +
  '+16%) and chain reach (up to +10%). Launch odds blend the category launch propensity with size and ' +
  'seasoning. Each row carries the number of traded peers its price was fitted from.';

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
