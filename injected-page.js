// ==========================================================
// Deep Scraper v2 — injected-page.js (Main World)
// Enhanced fetch/XHR hooks with headers, timing, correlation
// ==========================================================

(() => {
  'use strict';
  if (window._dsInjected) return;
  window._dsInjected = true;

  const PREFIX = '__DEEP_SCRAPER__';
  const BODY_LIMIT = 100000;
  const HEADER_SENSITIVE = /cookie|authorization|set-cookie/i;

  const relay = (tag, payload) => {
    try { window.postMessage({ type: PREFIX + tag, payload }, '*'); } catch {}
  };

  const truncate = (str, max = BODY_LIMIT) =>
    typeof str === 'string' && str.length > max ? str.substring(0, max) + '…[truncated]' : str;

  const redactHeaders = (headers) => {
    if (!headers) return headers;
    const clean = {};
    for (const [k, v] of Object.entries(headers)) {
      if (HEADER_SENSITIVE.test(k)) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = v;
      }
    }
    return clean;
  };

  const extractHeaders = (init, req) => {
    const h = {};
    if (req instanceof Request && req.headers) {
      req.headers.forEach((v, k) => { if (!HEADER_SENSITIVE.test(k)) h[k] = v; });
    }
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { if (!HEADER_SENSITIVE.test(k)) h[k] = v; });
      } else if (typeof init.headers === 'object') {
        for (const [k, v] of Object.entries(init.headers)) {
          h[k] = HEADER_SENSITIVE.test(k) ? '[REDACTED]' : v;
        }
      }
    }
    return h;
  };

  const classifyResponse = (ct) => {
    if (!ct) return 'other';
    if (/json/i.test(ct)) return 'json';
    if (/html/i.test(ct)) return 'html';
    if (/javascript|ecmascript/i.test(ct)) return 'script';
    if (/xml/i.test(ct)) return 'xml';
    if (/text\//i.test(ct)) return 'text';
    if (/image/i.test(ct)) return 'image';
    if (/captcha|challenge/i.test(ct)) return 'captcha';
    return 'other';
  };

  const extractPaginationParams = (url) => {
    try {
      const u = new URL(url, location.origin);
      const params = {};
      for (const key of ['page', 'limit', 'offset', 'cursor', 'start', 'rows', 'pageSize', 'per_page', 'skip', 'take']) {
        if (u.searchParams.has(key)) params[key] = u.searchParams.get(key);
      }
      return Object.keys(params).length ? params : null;
    } catch { return null; }
  };

  const extractFilterParams = (url) => {
    try {
      const u = new URL(url, location.origin);
      const params = {};
      for (const key of ['search', 'q', 'keyword', 'query', 'filter', 'lpse', 'year', 'status', 'kategori', 'jenis', 'provinsi', 'satker']) {
        if (u.searchParams.has(key)) params[key] = u.searchParams.get(key);
      }
      return Object.keys(params).length ? params : null;
    } catch { return null; }
  };

  const inferSchema = (data, depth = 0) => {
    if (depth > 3 || data == null) return { type: data === null ? 'null' : typeof data };
    if (Array.isArray(data)) {
      if (data.length === 0) return { type: 'array', itemSample: null };
      const inferred = inferSchema(data[0], depth + 1);
      return { type: 'array', length: data.length, itemSchema: inferred };
    }
    if (typeof data === 'object') {
      const fields = {};
      for (const [k, v] of Object.entries(data)) {
        fields[k] = inferSchema(v, depth + 1);
      }
      return { type: 'object', fields, fieldCount: Object.keys(fields).length };
    }
    return { type: typeof data, sample: String(data).substring(0, 100) };
  };

  let correlationId = null;
  window.__DEEP_SCRAPER_SET_CORRELATION__ = (id) => { correlationId = id; };
  window.__DEEP_SCRAPER_GET_CORRELATION__ = () => correlationId;

  // ==========================================================
  // Enhanced Fetch Interceptor
  // ==========================================================
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const init = args[1] || {};
    const url = typeof req === 'string' ? req : (req?.url || '');
    const method = (init.method || req?.method || 'GET').toUpperCase();
    const requestHeaders = extractHeaders(init, req);
    let requestBody = null;

    if (init.body) {
      if (init.body instanceof FormData) {
        const entries = {};
        for (const [k, v] of init.body.entries()) {
          entries[k] = v instanceof File ? `[File: ${v.name}]` : String(v).substring(0, 2000);
        }
        requestBody = JSON.stringify(entries);
      } else if (init.body instanceof URLSearchParams) {
        requestBody = init.body.toString();
      } else if (typeof init.body === 'string') {
        requestBody = init.body;
      } else {
        requestBody = String(init.body);
      }
    } else if (req instanceof Request && req.body) {
      try { requestBody = await req.text(); } catch {}
    }

    const startTime = performance.now();
    relay('REQUEST_STARTED', {
      source: 'fetch', url, method, correlationId,
      requestHeaders: redactHeaders(requestHeaders),
      requestBody: truncate(requestBody, 10000),
      paginationParams: extractPaginationParams(url),
      filterParams: extractFilterParams(url),
      timestamp: Date.now()
    });

    try {
      const response = await originalFetch.apply(this, args);
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);

      const responseHeaders = {};
      response.headers.forEach((v, k) => { responseHeaders[k] = v; });

      const ct = response.headers.get('content-type') || '';
      const responseClass = classifyResponse(ct);

      const clone = response.clone();
      clone.text().then(bodyText => {
        let parsedJson = null;
        let schema = null;
        if (responseClass === 'json') {
          try {
            parsedJson = JSON.parse(bodyText);
            schema = inferSchema(parsedJson);
          } catch {}
        }

        relay('RESPONSE_RECEIVED', {
          source: 'fetch', url, method,
          status: response.status, statusText: response.statusText,
          contentType: ct, responseClass,
          responseHeaders: redactHeaders(responseHeaders),
          requestBody: truncate(requestBody, 10000),
          responseBody: truncate(bodyText, 50000),
          parsedJson: parsedJson ? truncate(JSON.stringify(parsedJson), 80000) : null,
          schema,
          duration, correlationId,
          paginationParams: extractPaginationParams(url),
          filterParams: extractFilterParams(url),
          timestamp: Date.now()
        });
      }).catch(() => {});

      return response;
    } catch (err) {
      relay('REQUEST_ERROR', {
        source: 'fetch', url, method,
        error: err.message, correlationId,
        duration: Math.round(performance.now() - startTime),
        timestamp: Date.now()
      });
      throw err;
    }
  };

  // ==========================================================
  // Enhanced XHR Interceptor
  // ==========================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ds = {
      method: (method || 'GET').toUpperCase(),
      url: String(url || ''),
      requestHeaders: {},
      correlationId
    };
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._ds && !HEADER_SENSITIVE.test(name)) {
      this._ds.requestHeaders[name] = value;
    } else if (this._ds && HEADER_SENSITIVE.test(name)) {
      this._ds.requestHeaders[name] = '[REDACTED]';
    }
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const ds = this._ds || { method: 'GET', url: '', requestHeaders: {}, correlationId };
    const startTime = performance.now();

    let requestBody = null;
    if (body) {
      if (body instanceof FormData) {
        const entries = {};
        for (const [k, v] of body.entries()) {
          entries[k] = v instanceof File ? `[File: ${v.name}]` : String(v).substring(0, 2000);
        }
        requestBody = JSON.stringify(entries);
      } else if (body instanceof URLSearchParams) {
        requestBody = body.toString();
      } else {
        requestBody = String(body);
      }
    }

    relay('REQUEST_STARTED', {
      source: 'xhr', url: ds.url, method: ds.method,
      correlationId: ds.correlationId,
      requestHeaders: ds.requestHeaders,
      requestBody: truncate(requestBody, 10000),
      paginationParams: extractPaginationParams(ds.url),
      filterParams: extractFilterParams(ds.url),
      timestamp: Date.now()
    });

    this.addEventListener('readystatechange', function () {
      if (this.readyState === 4) {
        const endTime = performance.now();
        const duration = Math.round(endTime - startTime);

        const responseHeaders = {};
        try {
          this.getAllResponseHeaders().trim().split(/\r?\n/).forEach(line => {
            const idx = line.indexOf(':');
            if (idx > 0) responseHeaders[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
          });
        } catch {}

        const ct = this.getResponseHeader('content-type') || '';
        const responseClass = classifyResponse(ct);

        let parsedJson = null;
        let schema = null;
        if (responseClass === 'json') {
          try {
            parsedJson = JSON.parse(this.responseText);
            schema = inferSchema(parsedJson);
          } catch {}
        }

        relay('RESPONSE_RECEIVED', {
          source: 'xhr', url: ds.url, method: ds.method,
          status: this.status, statusText: this.statusText,
          contentType: ct, responseClass,
          responseHeaders: redactHeaders(responseHeaders),
          requestBody: truncate(requestBody, 10000),
          responseBody: truncate(this.responseText || '', 50000),
          parsedJson: parsedJson ? truncate(JSON.stringify(parsedJson), 80000) : null,
          schema,
          duration, correlationId: ds.correlationId,
          paginationParams: extractPaginationParams(ds.url),
          filterParams: extractFilterParams(ds.url),
          timestamp: Date.now()
        });
      }
    });

    this.addEventListener('error', function () {
      relay('REQUEST_ERROR', {
        source: 'xhr', url: ds.url, method: ds.method,
        error: 'Network error', correlationId: ds.correlationId,
        duration: Math.round(performance.now() - startTime),
        timestamp: Date.now()
      });
    });

    return origSend.call(this, body);
  };

})();
