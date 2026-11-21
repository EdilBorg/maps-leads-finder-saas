'use strict';
/**
 * FX rates via Frankfurter v2 (https://api.frankfurter.dev/v2).
 * Response shape (confirmed): JSON array of
 *   { "date": "YYYY-MM-DD", "base": "USD", "quote": "MZN", "rate": 63.792 }
 * Not the v1 object shape { rates: { MZN: ... }, date }.
 */
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

/**
 * Parse Frankfurter v2 response into normalised rate rows.
 * Accepts the real v2 array form; also tolerates legacy v1 object form for resilience.
 */
function parseFrankfurterResponse(data, requestedQuotes) {
  const wanted = new Set((requestedQuotes || []).map((q) => String(q).toUpperCase()));
  const out = [];
  const seen = new Set();

  if (Array.isArray(data)) {
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const base = String(row.base || '').toUpperCase();
      const quote = String(row.quote || '').toUpperCase();
      const rate = Number(row.rate);
      const rateDate = row.date ? String(row.date).slice(0, 10) : null;
      if (base !== 'USD') continue;
      if (!quote || (wanted.size && !wanted.has(quote))) continue;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      if (!rateDate) continue;
      if (seen.has(quote)) continue;
      seen.add(quote);
      out.push({ base: 'USD', quote, rate, rateDate, source: 'frankfurter' });
    }
    return out;
  }

  // Legacy v1-style object (not expected from frankfurter.dev/v2, but kept as fallback)
  if (data && typeof data === 'object') {
    const rates = data.rates || data.quotes || {};
    const rateDate = data.date ? String(data.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    for (const q of wanted.size ? wanted : Object.keys(rates)) {
      const quote = String(q).toUpperCase();
      const rate = Number(rates[quote] != null ? rates[quote] : rates[q]);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      if (seen.has(quote)) continue;
      seen.add(quote);
      out.push({ base: 'USD', quote, rate, rateDate, source: 'frankfurter' });
    }
  }
  return out;
}

let fetchInFlight = null;
async function fetchFrankfurter(quotes = DEFAULT_QUOTES) {
  const list = (quotes && quotes.length) ? quotes.map((q) => String(q).toUpperCase()) : DEFAULT_QUOTES.slice();
  const url = `${frankfurterBase()}/rates?base=USD&quotes=${list.join(',')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`Frankfurter HTTP ${res.status}`);
      err.code = 'FX_HTTP';
      err.status = res.status;
      throw err;
    }
    let data;
    try {
      data = await res.json();
    } catch (_) {
      const err = new Error('Frankfurter response is not valid JSON');
      err.code = 'FX_INVALID';
      throw err;
    }
    const out = parseFrankfurterResponse(data, list);
    if (!out.length) {
      const err = new Error('Frankfurter response without valid rates');
      err.code = 'FX_INVALID';
      throw err;
    }
    // Partial success is allowed for cache update, but caller of getUsdRate
    // still validates the specific quote it needs.
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
    // Background refresh when older than refresh interval but still within max age
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
    err.cause = e;
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

/**
 * ISO 4217 minor units for currencies currently used by PayZeno methods.
 * Unknown currencies are rejected — never assume 2 decimals.
 */
const CURRENCY_MINOR_DIGITS = Object.freeze({
  USD: 2,
  MZN: 2,
  AOA: 2,
  ZAR: 2,
});

function minorDigitsFor(currency) {
  const code = String(currency || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_DIGITS, code)) {
    return CURRENCY_MINOR_DIGITS[code];
  }
  const err = new Error(`Moeda não suportada para conversão: ${code || '(vazia)'}`);
  err.code = 'CURRENCY_UNSUPPORTED';
  throw err;
}

/**
 * Convert USD cents to local minor units.
 * Policy: ceil to next local minor unit (never under-charge).
 * Rejects non-integer usdCents (no silent truncation).
 */
function convertUsdCentsToLocal(usdCents, rate, { currency = null, minorFactor = null } = {}) {
  const centsNum = Number(usdCents);
  const r = Number(rate);
  if (!Number.isFinite(centsNum) || centsNum < 0 || !Number.isFinite(r) || r <= 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }
  // Reject fractional cents — callers must pass integer minor units of USD.
  if (!Number.isInteger(centsNum)) {
    const err = new Error('usdCents deve ser um inteiro (unidades mínimas de USD)');
    err.code = 'FX_INVALID';
    throw err;
  }
  if (centsNum > Number.MAX_SAFE_INTEGER) {
    const err = new Error('usdCents excede o limite seguro de precisão numérica');
    err.code = 'FX_OVERFLOW';
    throw err;
  }

  let digits;
  if (minorFactor != null) {
    const mf = Number(minorFactor);
    if (!Number.isFinite(mf) || mf <= 0) {
      const err = new Error('Conversão cambial inválida');
      err.code = 'FX_INVALID';
      throw err;
    }
    digits = Math.round(Math.log10(mf));
    if (digits < 0 || 10 ** digits !== mf) {
      const err = new Error('Conversão cambial inválida');
      err.code = 'FX_INVALID';
      throw err;
    }
  } else {
    digits = minorDigitsFor(currency);
  }

  const factor = 10 ** digits;
  // localMinor = ceil( usdCents * rate * factor / 100 )
  const RATE_SCALE = 100000000n; // 1e8
  const rateScaled = BigInt(Math.round(r * 1e8));
  const num = BigInt(centsNum) * rateScaled * BigInt(factor);
  const denom = 100n * RATE_SCALE;
  const localMinorBig = (num + denom - 1n) / denom; // ceil

  if (localMinorBig < 0n) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }
  if (localMinorBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    const err = new Error('Valor convertido excede o limite seguro de precisão numérica.');
    err.code = 'FX_OVERFLOW';
    throw err;
  }
  const localMinor = Number(localMinorBig);
  if (!Number.isFinite(localMinor) || localMinor < 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }
  if (centsNum > 0 && localMinor <= 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }

  return {
    majorUnits: localMinor / factor,
    minorUnits: localMinor,
    minorDigits: digits,
    raw: (centsNum / 100) * r,
  };
}

module.exports = {
  getUsdRate,
  refreshRates,
  convertUsdCentsToLocal,
  frankfurterBase,
  maxAgeHours,
  refreshIntervalMs,
  DEFAULT_QUOTES,
  CURRENCY_MINOR_DIGITS,
  minorDigitsFor,
  parseFrankfurterResponse,
  fetchFrankfurter,
};
