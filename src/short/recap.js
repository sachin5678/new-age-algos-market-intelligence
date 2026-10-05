/**
 * Market recap script builder — "biggest risers & fallers of the day",
 * with technical charts on the scenes and the channel's own news where an
 * event matches a mover.
 *
 * Narration is TEMPLATE-BASED per language (en / hinglish / hindi) — no AI
 * call needed, so recap shorts are deterministic and always free. On-screen
 * copy stays English (symbols, prices, percentages, headlines).
 *
 * Scene shapes (rendered by scenes.js):
 *   recap  — "MARKET RECAP" hook + index pulse (NIFTY 50 / BANK / SENSEX)
 *   mover  — rank chip, symbol, % move, close, inline candle chart, news strip
 *   cta    — brand outro
 */

import { clip, sentence, DEFAULT_HASHTAGS } from './script.js';
import { CTA_SPEECH, normalizeLang } from './lang.js';
import { newsForMover } from './marketData.js';

const DAY_MS = 86_400_000;

/** Indian-format number for on-screen text. */
export function fmtNum(value, dec = 2) {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: 0,
  });
}

/** "+5.1%" / "−3.3%" (screen). */
export function fmtPct(pct) {
  if (!Number.isFinite(Number(pct))) return '—';
  const p = Number(pct);
  const sign = p >= 0 ? '+' : '−';
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}

function spokenPrice(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '';
  return p >= 1000 ? Math.round(p).toLocaleString('en-IN') : p.toFixed(2);
}

function spokenPct(pct, lang) {
  const abs = Math.abs(Number(pct)).toFixed(1);
  if (lang === 'hindi') return `${abs} परसेंट`;
  if (lang === 'hinglish') return `${abs} percent`;
  return `${abs} percent`;
}

function indexSentence(pulseRow, lang) {
  if (!pulseRow) return '';
  const v = fmtNum(pulseRow.value, 0);
  const down = pulseRow.pct < 0;
  if (lang === 'hindi') {
    return `निफ्टी 50 ${v} पर बंद हुआ, ${spokenPct(pulseRow.pct, lang)} ${down ? 'नीचे' : 'ऊपर'}.`;
  }
  if (lang === 'hinglish') {
    return `Nifty 50 bandh hua ${v} par, ${spokenPct(pulseRow.pct, lang)} ${down ? 'neeche' : 'upar'}.`;
  }
  return `Nifty 50 closed at ${v}, ${spokenPct(pulseRow.pct, lang)} ${down ? 'down' : 'up'}.`;
}

function hookSpeech({ pulseRow, lang }) {
  const head =
    lang === 'hindi'
      ? 'आज का मार्केट रीकैप।'
      : lang === 'hinglish'
        ? 'Aaj ka market recap.'
        : "Here is today's market recap.";
  const idx = indexSentence(pulseRow, lang);
  return `${head} ${idx}`.trim();
}

function moverSpeech({ mover, lang }) {
  const name = mover.name ?? mover.symbol;
  const price = spokenPrice(mover.price);
  const pct = spokenPct(mover.pct, lang);
  const dirWord = mover.dir === 'up'
    ? lang === 'hindi'
      ? 'चढ़ा'
      : lang === 'hinglish'
        ? 'chadha'
        : 'rose'
    : lang === 'hindi'
      ? 'गिरा'
      : lang === 'hinglish'
        ? 'gira'
        : 'fell';

  if (lang === 'hindi') {
    return `${name} आज ${pct} ${dirWord}, ${price} रुपये पर बंद हुआ।`;
  }
  if (lang === 'hinglish') {
    return sentence(`${name} aaj ${pct} ${dirWord}, ${price} rupees par bandh hua`);
  }
  return sentence(`${name} ${dirWord} ${pct} to close at ${price} rupees`);
}

/**
 * Build the recap short.
 *
 * @param {object} args
 * @param {Array}  args.gainers  top gainers [{symbol,name,pct,price,candles}]
 * @param {Array}  args.losers   top losers (same shape)
 * @param {Array}  args.pulse    [{name,value,pct}] index rows
 * @param {Array}  args.events   store events for news matching
 * @param {'en'|'hinglish'|'hindi'} args.lang
 * @returns short object (same shape as buildShort)
 */
export function buildRecapShort({
  gainers = [],
  losers = [],
  pulse = [],
  events = [],
  date = new Date(),
  lang = 'en',
  handle = '@newageAlgos',
  sample = false,
} = {}) {
  const L = normalizeLang(lang);
  const movers = [
    ...gainers.map((g, i) => ({ ...g, dir: 'up', rank: `TOP GAINER ${i + 1}` })),
    ...losers.map((l, i) => ({ ...l, dir: 'down', rank: `TOP LOSER ${i + 1}` })),
  ];
  if (!movers.length && !pulse.length) {
    throw new Error('recap needs at least one mover or index row');
  }

  const nifty = pulse.find((p) => /NIFTY 50/i.test(p.name)) ?? pulse[0] ?? null;
  const top = movers.slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0] ?? null;

  const hookText = nifty
    ? `Nifty ${nifty.pct >= 0 ? 'gains' : 'falls'} ${Math.abs(nifty.pct).toFixed(1)}%` +
      (top ? ` — ${top.name} ${top.pct >= 0 ? 'jumps' : 'drops'} ${Math.abs(top.pct).toFixed(1)}%` : '')
    : 'Biggest movers of the day';

  const scenes = [
    {
      kind: 'recap',
      text: clip(hookText, 110),
      speech: hookSpeech({ pulseRow: nifty, lang: L }),
      pulse,
    },
    ...movers.map((m) => ({
      kind: 'mover',
      symbol: m.symbol,
      name: m.name ?? m.symbol,
      pct: m.pct,
      price: m.price,
      dir: m.dir,
      rank: m.rank,
      candles: Array.isArray(m.candles) ? m.candles : [],
      news: m.news ?? newsForMover(m, events),
      text: `${m.symbol} ${fmtPct(m.pct)}`,
      speech: moverSpeech({ mover: m, lang: L }),
    })),
    {
      kind: 'cta',
      text: `FOLLOW ${handle}`,
      speech: CTA_SPEECH[L],
    },
  ];

  const narration = scenes.map((s) => s.speech).join(' ');

  const dayLabel = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const niftyPart = nifty
    ? `NIFTY 50 ${fmtNum(nifty.value, 0)} (${fmtPct(nifty.pct)})`
    : '';
  const title = clip(
    `Market Recap ${dayLabel}: ${niftyPart || 'top movers'} #Shorts`,
    100
  );

  const pulseLines = pulse.map((p) => `${p.name} ${fmtNum(p.value, 0)} (${fmtPct(p.pct)})`);
  const description = [
    `Market recap for ${dayLabel} — all levels via Yahoo Finance.`,
    ...pulseLines,
    gainers.length
      ? `Top gainers: ${gainers.map((g) => `${g.symbol} ${fmtPct(g.pct)} @ ₹${fmtNum(g.price)}`).join(', ')}`
      : '',
    losers.length
      ? `Top losers: ${losers.map((l) => `${l.symbol} ${fmtPct(l.pct)} @ ₹${fmtNum(l.price)}`).join(', ')}`
      : '',
    '',
    DEFAULT_HASHTAGS.join(' '),
    'Source: Yahoo Finance',
  ]
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n');

  return {
    title,
    description,
    hashtags: [...DEFAULT_HASHTAGS],
    impact: nifty ? (nifty.pct >= 0 ? 'positive' : 'negative') : 'neutral',
    category: 'MARKET RECAP',
    importance: 'HIGH',
    handle,
    source: 'Yahoo Finance',
    sample,
    lang: L,
    dayLabel,
    scenes,
    narration,
  };
}

/** Deterministic demo data for --demo --type recap (labelled SAMPLE). */
export function demoRecap(date = new Date()) {
  const wave = (seed, drift) => {
    let p = 100 + drift;
    const out = [];
    for (let i = 0; i < 22; i += 1) {
      const o = p;
      const c = o + Math.sin((i + seed) * 0.9) * 2 + drift;
      const h = Math.max(o, c) + 1.1;
      const l = Math.min(o, c) - 1.1;
      out.push({ o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2) });
      p = c;
    }
    return out;
  };
  const mk = (symbol, name, pct, price, seed) => {
    const raw = wave(seed, pct > 0 ? 0.8 : -0.8);
    // scale the synthetic series so its last close equals the stated price
    const k = price / raw.at(-1).c;
    return {
      symbol,
      name,
      pct,
      price,
      candles: raw.map(({ o, h, l, c }) => ({
        o: +(o * k).toFixed(2),
        h: +(h * k).toFixed(2),
        l: +(l * k).toFixed(2),
        c: +(c * k).toFixed(2),
      })),
    };
  };
  return {
    gainers: [mk('ITC', 'ITC', 5.08, 462.35, 1), mk('BAJFINANCE', 'Bajaj Finance', 2.29, 985.4, 3)],
    losers: [mk('HCLTECH', 'HCL Tech', -3.31, 1462.1, 5), mk('HDFCBANK', 'HDFC Bank', -2.27, 1988.6, 7)],
    pulse: [
      { name: 'NIFTY 50', value: 24812.35, pct: -0.42 },
      { name: 'NIFTY BANK', value: 55120.8, pct: -0.61 },
      { name: 'SENSEX', value: 81245.12, pct: -0.35 },
    ],
    events: [
      {
        title: 'HCL Tech slips 3% as IT spending outlook cools ahead of Q2',
        description: 'Shares fell in line with weak global tech cues.',
        source: 'Moneycontrol',
        detected_at: new Date(date.getTime() - 3 * DAY_MS).toISOString(),
      },
    ],
    date,
    sample: true,
  };
}
