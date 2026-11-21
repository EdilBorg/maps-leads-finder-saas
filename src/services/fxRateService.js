'use strict';
function getPool() { return require('../db/pool').getPool(); }
const DEFAULT_QUOTES = ['MZN', 'AOA', 'ZAR'];

function frankfurterBase() {
  return (process.env.FRANKFURTER_API_BASE || 'https://api.frankfurter.dev/v2').replace(/\/$/, '');
}
function refreshIntervalMs() {
  const n = Number(process.env.FX_REFRESH_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 60 * 60 * 1000;
}
function maxAgeHours() {
  const n = Number(process.env.FX_MAX_RATE_AGE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 72;
}
function isFresh(fetchedAt, maxHours) {
  if (!fetchedAt) return false;
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return ageMs >= 0 && ageMs <= maxHours * 3600 * 1000;
}
async function getCachedRate(base, quote) {
  const { rows } = await getPool().query(
    `SELECT base_currency, quote_currency, rate, rate_date, source, fetched_at
     FROM fx_rates WHERE base_currency = $1 AND quote_currency = $2`, [base, quote]
  );
  return rows[0] || null;
}
async function upsertRate(row) {
  await getPool().query(
    `INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, source, fetched_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (base_currency, quote_currency) DO UPDATE SET
       rate = EXCLUDED.rate, rate_date = EXCLUDED.rate_date, source = EXCLUDED.source, fetched_at = NOW()`,
    [row.base, row.quote, row.rate, row.rateDate, row.source || 'frankfurter']
  );
}
let fetchInFlight = null;
async function fetchFrankfurter(quotes = DEFAULT_QUOTES) {
  const url = `${frankfurterBase()}/rates?base=USD&quotes=${quotes.join(',')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`Frankfurter HTTP ${res.status}`);
      err.code = 'FX_HTTP';
      throw err;
    }
    const data = await res.json();
    const rates = data.rates || data.quotes || {};
    const rateDate = data.date || new Date().toISOString().slice(0, 10);
    const out = [];
    for (const q of quotes) {
      const r = Number(rates[q]);
      if (!Number.isFinite(r) || r <= 0) continue;
      out.push({ base: 'USD', quote: q, rate: r, rateDate, source: 'frankfurter' });
    }
    if (!out.length) {
      const err = new Error('Frankfurter response without valid rates');
      err.code = 'FX_INVALID';
      throw err;
    }
    for (const row of out) await upsertRate(row);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
async function refreshRates(quotes = DEFAULT_QUOTES) {
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = fetchFrankfurter(quotes).finally(() => { fetchInFlight = null; });
  return fetchInFlight;
}
async function getUsdRate(quoteCurrency) {
  const quote = String(quoteCurrency || '').toUpperCase();
  if (!quote || quote === 'USD') {
    return {
      rate: 1, rateDate: new Date().toISOString().slice(0, 10),
      source: 'identity', fetchedAt: new Date().toISOString(), base: 'USD', quote: 'USD',
    };
  }
  const maxH = maxAgeHours();
  const cached = await getCachedRate('USD', quote);
  if (cached && isFresh(cached.fetched_at, maxH)) {
    if (!isFresh(cached.fetched_at, refreshIntervalMs() / 3600000)) {
      refreshRates().catch(() => {});
    }
    return {
      rate: Number(cached.rate), rateDate: cached.rate_date, source: cached.source,
      fetchedAt: cached.fetched_at, base: 'USD', quote,
    };
  }
  try {
    await refreshRates();
  } catch (e) {
    if (cached && isFresh(cached.fetched_at, maxH)) {
      return {
        rate: Number(cached.rate), rateDate: cached.rate_date, source: cached.source,
        fetchedAt: cached.fetched_at, base: 'USD', quote,
      };
    }
    const err = new Error('Taxa de câmbio indisponível ou expirada. Tente mais tarde.');
    err.code = 'FX_UNAVAILABLE';
    throw err;
  }
  const again = await getCachedRate('USD', quote);
  if (!again || !isFresh(again.fetched_at, maxH)) {
    const err = new Error('Taxa de câmbio indisponível ou expirada. Tente mais tarde.');
    err.code = 'FX_UNAVAILABLE';
    throw err;
  }
  return {
    rate: Number(again.rate), rateDate: again.rate_date, source: again.source,
    fetchedAt: again.fetched_at, base: 'USD', quote,
  };
}
function convertUsdCentsToLocal(usdCents, rate, { minorFactor = 100 } = {}) {
  const cents = Number(usdCents);
  const r = Number(rate);
  if (!Number.isFinite(cents) || cents < 0 || !Number.isFinite(r) || r <= 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }
  const RATE_SCALE = 100000000n;
  const rateScaled = BigInt(Math.round(r * 1e8));
  const num = BigInt(cents) * rateScaled;
  const denom = 100n * RATE_SCALE;
  const major = Number((num + denom - 1n) / denom);
  if (!Number.isFinite(major) || major <= 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }
  return { majorUnits: major, minorUnits: major * minorFactor, raw: Number(cents) / 100 * r };
}
module.exports = {
  getUsdRate, refreshRates, convertUsdCentsToLocal, frankfurterBase,
  maxAgeHours, refreshIntervalMs, DEFAULT_QUOTES,
};
