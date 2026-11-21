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
/**
 * ISO 4217 minor units for currencies currently used by PayZeno methods.
 * Extend this map only when a new method/currency is officially added.
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
 * Convert a USD amount expressed in USD cents into local minor units.
 *
 * Policy:
 * - Never under-charge: result is rounded UP to the next local minor unit.
 * - Uses scaled integer arithmetic to avoid binary floating-point drift.
 * - majorUnits is derived from minorUnits / 10^digits (may be fractional for display).
 *
 * @param {number} usdCents  Amount in USD minor units (cents).
 * @param {number} rate      Units of quote currency per 1 USD.
 * @param {{ currency?: string, minorFactor?: number }} [opts]
 * @returns {{ majorUnits: number, minorUnits: number, minorDigits: number, raw: number }}
 */
function convertUsdCentsToLocal(usdCents, rate, { currency = null, minorFactor = null } = {}) {
  const cents = Number(usdCents);
  const r = Number(rate);
  if (!Number.isFinite(cents) || cents < 0 || !Number.isFinite(r) || r <= 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
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
    // minorFactor 1 → 0 digits, 100 → 2, 1000 → 3
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
  // localMinor = ceil( (usdCents / 100) * rate * factor )
  // = ceil( usdCents * rate * factor / 100 )
  const RATE_SCALE = 100000000n; // 1e8
  const rateScaled = BigInt(Math.round(r * 1e8));
  const num = BigInt(Math.trunc(cents)) * rateScaled * BigInt(factor);
  const denom = 100n * RATE_SCALE;
  const localMinorBig = (num + denom - 1n) / denom; // ceil division
  if (localMinorBig < 0n) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }
  // Reject values that cannot be represented safely as a JS number (gateway + DB expect finite numbers).
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
  // Guard: zero-value plans are not expected for paid checkout.
  if (cents > 0 && localMinor <= 0) {
    const err = new Error('Conversão cambial inválida');
    err.code = 'FX_INVALID';
    throw err;
  }

  return {
    majorUnits: localMinor / factor,
    minorUnits: localMinor,
    minorDigits: digits,
    raw: (cents / 100) * r,
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
};
