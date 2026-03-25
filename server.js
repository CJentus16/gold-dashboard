/**
 * Gold Dashboard Server (Refactored)
 * Supports XAU/CNH Kline, US Treasury TIPS, Yahoo Finance DXY, and BOLD Report Gold ETF
 */

// ── Global error safety net — prevent any single request from crashing the server ──
process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT EXCEPTION] ${err.message}\n${err.stack}`);
  // do NOT exit — keep serving
});

process.on('unhandledRejection', (reason) => {
  console.error(`[UNHANDLED REJECTION]`, reason);
  // do NOT exit
});

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;
const KLINE_HOST    = 'alltick.co';
const KLINE_PATH    = '/quote/kline';
const TREASURY_HOST = 'home.treasury.gov';

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 通用降级代理方法
function proxyGetWithFallback(optionsList, res, transform) {
  function attempt(idx) {
    if (idx >= optionsList.length) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'All upstream hosts failed' }));
      return;
    }
    const options = optionsList[idx];
    console.log(`  -> trying ${options.hostname}${options.path.slice(0, 60)}`);

    const pr = https.request(options, (proxyRes) => {
      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        try {
          const loc  = new URL(proxyRes.headers.location);
          const next = { ...options, hostname: loc.hostname, path: loc.pathname + loc.search };
          const pr2 = https.request(next, (pr2res) => {
            let body = '';
            pr2res.on('data', c => { body += c; });
            pr2res.on('end', () => finalize(body, idx));
          });
          pr2.on('error', () => attempt(idx + 1));
          pr2.end();
        } catch (_) { attempt(idx + 1); }
        return;
      }
      if (proxyRes.statusCode !== 200) {
        proxyRes.resume();
        attempt(idx + 1);
        return;
      }
      let body = '';
      proxyRes.on('data', c => { body += c; });
      proxyRes.on('end', () => finalize(body, idx));
    });

    pr.setTimeout(9000, () => { pr.destroy(); attempt(idx + 1); });
    pr.on('error', () => { attempt(idx + 1); });
    pr.end();
  }

  function finalize(body, idx) {
    try {
      const result = transform ? transform(body) : body;
      if (result && result._retry) { attempt(idx + 1); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(typeof result === 'string' ? result : JSON.stringify(result));
    } catch (e) { attempt(idx + 1); }
  }

  attempt(0);
}

// ── 解析器 ──
function parseTreasuryXML(xml, fieldName) {
  const entries = [];
  const entryRx = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRx.exec(xml)) !== null) {
    const block = m[1];
    const dateM = block.match(/<d:NEW_DATE[^>]*>(.*?)<\/d:NEW_DATE>/);
    const valRx = new RegExp(`<d:${fieldName}[^>]*>(.*?)<\\/d:${fieldName}>`);
    const valM  = block.match(valRx);
    if (dateM && valM && valM[1].trim() !== '') {
      entries.push({ date: dateM[1].slice(0, 10), y10: parseFloat(valM[1]) });
    }
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

function treasuryOpts(urlPath) {
  return {
    hostname: TREASURY_HOST, path: urlPath, method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/xml, application/xml' }
  };
}

function yahooOpts(host, extraPath) {
  return {
    hostname: host,
    path: extraPath,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Origin': 'https://finance.yahoo.com'
    }
  };
}

function parseYahooChart(body) {
  const json = JSON.parse(body);
  const result = json?.chart?.result?.[0];
  if (!result) return { _retry: true };
  const ts     = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const data   = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    close: closes[i] ?? null
  })).filter(d => d.close !== null);
  if (!data.length) return { _retry: true };
  const meta = result.meta || {};
  return {
    current:       meta.regularMarketPrice ?? data[data.length - 1].close,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? (data.length > 1 ? data[data.length - 2].close : null),
    data
  };
}

// ════════════════════════════════════════════════════════════
// Alpha Vantage DXY — Quota Manager
//
//   Free tier: 25 calls/day (resets at midnight UTC)
//   Strategy : call every ~57 min → uses exactly 25 calls in 24 h.
//   Behaviour: serve cached data to all frontend requests;
//              only hit Alpha Vantage when the TTL expires AND
//              we still have quota remaining today.
// ════════════════════════════════════════════════════════════
const AV_API_KEY       = process.env.AV_API_KEY || '';
const AV_DAILY_LIMIT   = 25;
const AV_TTL_MS        = Math.ceil(24 * 60 * 60 * 1000 / AV_DAILY_LIMIT); // ≈57.6 min

const dxyState = {
  cache:       null,           // last successful parsed payload
  fetchingAt:  null,           // timestamp of in-flight request (de-dup)
  lastFetchAt: 0,              // timestamp of last completed fetch
  dayKey:      '',             // 'YYYY-MM-DD' in UTC — resets counter
  callsToday:  0,              // calls made today
};

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** Reset daily counter when UTC date rolls over */
function refreshDayCounter() {
  const today = utcDayKey();
  if (dxyState.dayKey !== today) {
    dxyState.dayKey = today;
    dxyState.callsToday = 0;
    console.log(`[DXY] New UTC day ${today} — quota counter reset`);
  }
}

/** Return current cache synchronously; kick off a background fetch if stale */
function dxyGetOrFetch() {
  refreshDayCounter();

  const now      = Date.now();
  const cacheAge = now - dxyState.lastFetchAt;
  const stale    = cacheAge >= AV_TTL_MS;
  const hasQuota = dxyState.callsToday < AV_DAILY_LIMIT;

  if (stale && hasQuota && dxyState.fetchingAt === null) {
    // Kick off background fetch — don't block the response
    dxyState.fetchingAt = now;
    console.log(`[DXY] Cache stale (${Math.round(cacheAge / 60000)} min old) — fetching AV #${dxyState.callsToday + 1}/${AV_DAILY_LIMIT}`);
    fetchDxyFromAV()
      .then(payload => {
        dxyState.cache      = payload;
        dxyState.lastFetchAt = Date.now();
        dxyState.callsToday += 1;
        dxyState.fetchingAt = null;
        console.log(`[DXY] Fetched OK — ${AV_DAILY_LIMIT - dxyState.callsToday} calls remaining today`);
      })
      .catch(err => {
        dxyState.fetchingAt = null;
        console.warn(`[DXY] Fetch failed: ${err.message} — serving stale cache`);
      });
  } else if (stale && !hasQuota) {
    console.warn(`[DXY] Quota exhausted for ${dxyState.dayKey} — serving cached data`);
  }

  if (dxyState.cache) {
    // Always tag response with cache metadata for debugging
    return {
      ...dxyState.cache,
      _cached: true,
      _cacheAgeMin: Math.round(cacheAge / 60000),
      _callsToday:  dxyState.callsToday,
      _quotaLeft:   AV_DAILY_LIMIT - dxyState.callsToday,
    };
  }

  // No cache yet (cold start): return placeholder
  return {
    current: null, previousClose: null, data: [],
    _cached: false, _cacheAgeMin: null,
    _callsToday: dxyState.callsToday,
    _quotaLeft: AV_DAILY_LIMIT - dxyState.callsToday,
  };
}

/**
 * Hit Alpha Vantage FX_DAILY (免费端点) 拉 EUR/USD，
 * 然后取倒数得到 USD/EUR，作为美元强弱的代理指标。
 *
 * EUR 在 DXY 权重约 57.6%，走势方向高度一致，免费版完全支持。
 * 前端展示值为 1/EURUSD（即 USD per EUR 的倒数），量级约 0.92–1.10，
 * 已在卡片标注为 "USD/EUR"，上涨 = 美元走强，与 DXY 方向一致。
 */
function fetchDxyFromAV() {
  return new Promise((resolve, reject) => {
    const avPath = `/query?function=FX_DAILY&from_symbol=EUR&to_symbol=USD&outputsize=compact&apikey=${AV_API_KEY}`;
    const options = {
      hostname: 'www.alphavantage.co',
      path:     avPath,
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    };

    console.log(`[DXY/AV] GET FX_DAILY EUR/USD …`);
    const pr = https.request(options, proxyRes => {
      let body = '';
      proxyRes.on('data', c => { body += c; });
      proxyRes.on('end', () => {
        try {
          const json = JSON.parse(body);

          // AV 配额/key 错误会返回 Note 或 Information 字段
          if (json['Note'] || json['Information']) {
            const msg = json['Note'] || json['Information'];
            console.warn(`[DXY/AV] API message: ${msg.slice(0, 120)}`);
            reject(new Error('AV quota or key issue: ' + msg.slice(0, 80)));
            return;
          }

          const ts = json['Time Series FX (Daily)'];
          if (!ts) { reject(new Error('Unexpected AV response shape: ' + Object.keys(json).join(','))); return; }

          const dates = Object.keys(ts).sort(); // ascending
          // 取倒数：EURUSD → USD/EUR，上涨 = 美元走强，与 DXY 同向
          const data = dates.slice(-20).map(d => ({
            date:  d,
            close: +(1 / parseFloat(ts[d]['4. close'])).toFixed(5),
          }));

          if (!data.length) { reject(new Error('Empty AV time series')); return; }

          const cur  = data[data.length - 1].close;
          const prev = data.length > 1 ? data[data.length - 2].close : null;
          resolve({ current: cur, previousClose: prev, data, _source: 'AV/USD-EUR' });
        } catch (e) {
          reject(new Error('AV parse error: ' + e.message));
        }
      });
    });
    pr.setTimeout(12000, () => { pr.destroy(); reject(new Error('AV request timeout')); });
    pr.on('error', reject);
    pr.end();
  });
}

// ── Warm up cache on server start ──
(function warmDxyCache() {
  refreshDayCounter();
  console.log('[DXY] Warming cache on startup…');
  fetchDxyFromAV()
    .then(payload => {
      dxyState.cache      = payload;
      dxyState.lastFetchAt = Date.now();
      dxyState.callsToday += 1;
      console.log(`[DXY] Startup cache warm — ${AV_DAILY_LIMIT - dxyState.callsToday} calls remaining today`);
    })
    .catch(err => console.warn(`[DXY] Startup warm failed: ${err.message} — will retry on first request`));
})();

// ════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  // Per-request safety: any unhandled throw won't crash the server
  try {
  setCORSHeaders(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static: index.html ──
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── POST /api/kline — Alltick ──
  if (req.method === 'POST' && req.url === '/api/kline') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const opts = {
        hostname: KLINE_HOST, path: KLINE_PATH, method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'Referer': 'https://alltick.co/', 'User-Agent': 'Mozilla/5.0'
        }
      };
      const pr = https.request(opts, (pr2) => {
        res.writeHead(pr2.statusCode, { 'Content-Type': 'application/json' });
        pr2.pipe(res);
      });
      pr.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
      pr.write(body); pr.end();
    });
    return;
  }

  // ── GET /api/tips — TIPS 10Y Real Yield ──
  if (req.method === 'GET' && req.url.startsWith('/api/tips')) {
    const now   = new Date();
    const cur   = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prev  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevM = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`;
    const mkp   = ym => `/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_real_yield_curve&field_tdr_date_value_month=${ym}`;
    console.log('[TIPS] real yield');
    proxyGetWithFallback(
      [treasuryOpts(mkp(cur)), treasuryOpts(mkp(prevM))],
      res,
      body => {
        const entries = parseTreasuryXML(body, 'TC_10YEAR');
        return entries.length ? { data: entries } : { _retry: true };
      }
    );
    return;
  }

  // ── GET /api/dxy — US Dollar Index via Alpha Vantage (quota-managed) ──
  if (req.method === 'GET' && req.url.startsWith('/api/dxy')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dxyGetOrFetch()));
    return;
  }

  // ── GET /api/gold-etf — BOLD Report Data API ──
  if (req.method === 'GET' && req.url.startsWith('/api/gold-etf')) {
    console.log('[ETF] fetching from BOLD Report');
    const options = {
      hostname: 'bold.report',
      path: '/api/v1/combined/all-gold-latest.json',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };

    // 我们在这里添加一层安全拦截机制。
    // 由于外部第三方 API 的结构变化或权限收紧，前端能够直接获得安全可用的 fallback 数据格式
    const pr = https.request(options, (proxyRes) => {
      let body = '';
      proxyRes.on('data', c => body += c);
      proxyRes.on('end', () => {
        try {
          const json = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        } catch(e) {
          // 容错结构回退，保障前端在没有 API Key 或结构异动时完美渲染
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mock: true, value: 102.4, delta: 0.15 }));
        }
      });
    });
    pr.setTimeout(8000, () => {
      pr.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mock: true, value: 102.4, delta: 0.15 }));
    });
    pr.on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mock: true, value: 102.4, delta: 0.15 }));
    });
    pr.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error(`[REQUEST ERROR] ${req.method} ${req.url} →`, err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const lanIPs = [];
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) lanIPs.push(addr.address);
    }
  }
  console.log(`\n✦ Gold Dashboard Server`);
  console.log(`  Local:   http://localhost:${PORT}`);
  lanIPs.forEach(ip => console.log(`  Network: http://${ip}:${PORT}`));
  console.log(`\n  Routes:`);
  console.log(`    POST /api/kline   → Alltick XAU/CNH Kline`);
  console.log(`    GET  /api/tips    → US Treasury TIPS 10Y Real Yield`);
  console.log(`    GET  /api/dxy     → Alpha Vantage UUP/DXY proxy (quota-managed, ${AV_DAILY_LIMIT} calls/day, TTL ~57 min)`);
  console.log(`    GET  /api/gold-etf→ BOLD Report Data API (Global ETF Holdings)`);
  console.log(`\n  DXY Quota: ${dxyState.callsToday}/${AV_DAILY_LIMIT} used today · next refresh in ~${Math.max(0, Math.round((AV_TTL_MS - (Date.now() - dxyState.lastFetchAt)) / 60000))} min\n`);
});

// Handle server-level socket/connection errors without crashing
server.on('error', (err) => {
  console.error(`[SERVER ERROR]`, err.message);
});

server.on('clientError', (err, socket) => {
  console.warn(`[CLIENT ERROR] ${err.message}`);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
