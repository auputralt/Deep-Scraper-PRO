// ==========================================================
// Deep Scraper v2 — popup.js
// HAR export + new report sections + gap analysis
// + tRPC-aware gaps + request classification + auto-capture display
// ==========================================================

(() => {
  'use strict';

  const STORAGE_KEY = 'deepScraperState';

  const els = {
    url: document.getElementById('tabUrl'),
    error: document.getElementById('errorMsg'),
    mainBtn: document.getElementById('btnMain'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    timer: document.getElementById('timer'),
    dom: document.getElementById('statDom'),
    api: document.getElementById('statApi'),
    trpc: document.getElementById('statTrpc'),
    json: document.getElementById('statJson'),
    actions: document.getElementById('statActions'),
    tables: document.getElementById('statTables'),
    rsc: document.getElementById('statRsc'),
    pre: document.getElementById('statPre'),
    cookies: document.getElementById('statCookies'),
    badges: document.getElementById('badges'),
    harBtn: document.getElementById('btnHar'),
    jsonBtn: document.getElementById('btnJson'),
    csvBtn: document.getElementById('btnCsv'),
    mdBtn: document.getElementById('btnMd'),
    txtBtn: document.getElementById('btnTxt'),
    notice: document.getElementById('debuggerNotice'),
    gapsSection: document.getElementById('gapsSection'),
    gapsList: document.getElementById('gapsList'),
  };

  let currentTabId = null;
  let timerInterval = null;

  // ==========================================================
  // Init
  // ==========================================================
  async function init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return;
    currentTabId = tabs[0].id;
    els.url.textContent = tabs[0].url;

    if (els.url.textContent.startsWith('chrome://') || els.url.textContent.startsWith('edge://')) {
      showError('Cannot run on restricted browser pages.');
      els.mainBtn.disabled = true;
      return;
    }

    const data = await chrome.storage.local.get(STORAGE_KEY);
    render(data[STORAGE_KEY]);

    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STORAGE_KEY]) render(changes[STORAGE_KEY].newValue);
    });
  }

  // ==========================================================
  // Events
  // ==========================================================
  els.mainBtn.addEventListener('click', async () => {
    els.error.style.display = 'none';
    const state = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const action = state?.status === 'extracting' ? 'stopExtraction' : 'startExtraction';
    await chrome.runtime.sendMessage({ action, tabId: currentTabId });
  });

  els.harBtn.addEventListener('click', () => exportData('har'));
  els.jsonBtn.addEventListener('click', () => exportData('json'));
  els.csvBtn.addEventListener('click', () => exportData('csv'));
  els.mdBtn.addEventListener('click', () => exportData('markdown'));
  els.txtBtn.addEventListener('click', () => exportData('txt'));

  // ==========================================================
  // Render
  // ==========================================================
  function render(state) {
    if (!state) return;
    const isExtracting = state.status === 'extracting';
    const isComplete = state.status === 'complete';

    els.statusDot.className = `dot ${state.status}`;
    els.statusText.textContent = isExtracting ? 'Analyzing...' : isComplete ? 'Complete' : 'Idle';
    els.mainBtn.className = `btn-main ${isExtracting ? 'stop' : ''}`;
    els.mainBtn.textContent = isExtracting ? 'Stop Analysis' : 'Start Analysis';
    els.notice.style.display = isExtracting ? 'block' : 'none';

    const s = state.stats;
    els.dom.textContent = fmt(s.domRecords);
    els.api.textContent = fmt(s.apiCalls);
    els.trpc.textContent = fmt(s.trpcEndpoints);
    els.json.textContent = fmt(s.jsonParsed);
    els.actions.textContent = fmt(s.userActions);
    els.tables.textContent = fmt(s.tableChanges);
    els.rsc.textContent = fmt(s.rscRequests || 0);
    els.pre.textContent = fmt(s.preCaptured || 0);
    els.cookies.textContent = fmt(s.cookies);

    // Highlight tRPC card if endpoints found
    els.trpc.closest('.stat-card').classList.toggle('highlight', s.trpcEndpoints > 0);
    els.pre.closest('.stat-card').classList.toggle('highlight', (s.preCaptured || 0) > 0);

    const hasData = s.domRecords > 0 || s.apiCalls > 0 || s.jsonParsed > 0 || s.trpcEndpoints > 0;
    els.harBtn.disabled = !isComplete || !hasData;
    els.jsonBtn.disabled = !hasData;
    els.csvBtn.disabled = !hasData;
    els.mdBtn.disabled = !hasData;
    els.txtBtn.disabled = !hasData;

    renderBadges(state);
    renderGaps(state);

    if (isExtracting) {
      if (!timerInterval) {
        timerInterval = setInterval(() => {
          const sec = Math.floor((Date.now() - state.startedAt) / 1000);
          els.timer.textContent = `${pad(Math.floor(sec/60))}:${pad(sec%60)}`;
        }, 1000);
      }
    } else {
      clearInterval(timerInterval);
      timerInterval = null;
      if (isComplete && state.completedAt) {
        const sec = Math.floor((state.completedAt - state.startedAt) / 1000);
        els.timer.textContent = `${pad(Math.floor(sec/60))}:${pad(sec%60)}`;
      } else {
        els.timer.textContent = '00:00';
      }
    }
  }

  function renderBadges(state) {
    const d = state.data || {};
    const badges = [];

    if (d.nextPage?.detected) {
      const rt = d.nextPage.routeType || '';
      badges.push({ text: `Next.js ${rt}`, cls: 'purple' });
    }

    if (d.antiBot?.detected) {
      const st = d.antiBot.challengeStatus;
      const cls = st === 'passed' ? 'active' : st === 'active_challenge' ? 'danger' : st === 'background' ? 'info' : 'warning';
      badges.push({ text: `Turnstile: ${st}`, cls });
    } else {
      badges.push({ text: 'No Turnstile', cls: '' });
    }

    // tRPC badge
    const trpcEndpoints = d.trpcEndpoints || [];
    if (trpcEndpoints.length > 0) {
      const procNames = [...new Set(trpcEndpoints.flatMap(t => (t.procedures || []).map(p => p.name)))];
      const tableProcs = procNames.filter(n => /list|search|query|pagination/i.test(n));
      if (tableProcs.length > 0) {
        badges.push({ text: `tRPC: ${tableProcs.join(', ')}`, cls: 'active' });
      } else {
        badges.push({ text: `${trpcEndpoints.length} tRPC endpoint(s)`, cls: 'active' });
      }
    }

    // RSC badge
    const rscCount = state.stats.rscRequests || 0;
    if (rscCount > 0) {
      badges.push({ text: `${rscCount} RSC request(s)`, cls: 'info' });
    }

    // Pre-captured badge
    const preCaptured = state.stats.preCaptured || 0;
    if (preCaptured > 0) {
      badges.push({ text: `${preCaptured} pre-captured`, cls: 'purple' });
    }

    const apiCount = (d.apiCandidates || []).length;
    const dataEndpoints = (d.apiCandidates || []).filter(c => c.isDataEndpoint).length;
    if (apiCount > 0) {
      badges.push({ text: `${apiCount} API (${dataEndpoints} data)`, cls: 'active' });
    } else if (state.status === 'complete' && trpcEndpoints.length === 0) {
      badges.push({ text: 'No API endpoints', cls: 'warning' });
    }

    if ((d.schemas || []).length > 0) {
      badges.push({ text: `${(d.schemas).length} schemas`, cls: 'active' });
    }

    if ((d.interactions || []).length > 0) {
      const p = (d.interactions || []).filter(i => i.isPagination).length;
      const f = (d.interactions || []).filter(i => i.isFilter).length;
      const dt = (d.interactions || []).filter(i => i.isDetailLink).length;
      let txt = `${d.interactions.length} actions`;
      if (p) txt += ` (${p} pag)`;
      if (f) txt += ` (${f} filt)`;
      if (dt) txt += ` (${dt} det)`;
      badges.push({ text: txt, cls: 'info' });
    }

    if ((d.events || []).length > 0) {
      badges.push({ text: `${d.events.length} events`, cls: '' });
    }

    const fragment = document.createDocumentFragment();
    for (const b of badges) {
      const span = document.createElement('span');
      span.className = `badge ${b.cls}`;
      span.textContent = b.text;
      fragment.appendChild(span);
    }
    els.badges.textContent = '';
    els.badges.appendChild(fragment);
  }

  function renderGaps(state) {
    const gaps = analyzeGaps(state);
    if (gaps.length === 0 || state.status !== 'complete') {
      els.gapsSection.style.display = 'none';
      return;
    }
    els.gapsSection.style.display = 'block';
    const fragment = document.createDocumentFragment();
    for (const g of gaps) {
      const div = document.createElement('div');
      div.className = 'gap-item';
      div.textContent = g;
      fragment.appendChild(div);
    }
    els.gapsList.textContent = '';
    els.gapsList.appendChild(fragment);
  }

  // ==========================================================
  // Gap Analysis — tRPC-aware
  // ==========================================================
  function analyzeGaps(state) {
    const d = state.data || {};
    const gaps = [];
    const events = d.events || [];
    const trpcEndpoints = d.trpcEndpoints || [];
    const apiCandidates = d.apiCandidates || [];
    const preCaptured = state.stats.preCaptured || 0;

    // --- tRPC-specific gaps ---
    if (trpcEndpoints.length > 0) {
      const tableProcs = trpcEndpoints.flatMap(t => (t.procedures || []).filter(p => p.role === 'table_data'));
      if (tableProcs.length > 0) {
        const primary = tableProcs[0];
        const paramNames = primary.params ? Object.keys(primary.params).filter(k => primary.params[k] != null) : [];
        gaps.push(`Detected tRPC endpoint(s): ${tableProcs.map(p => p.name).join(', ')}`);
        if (paramNames.length > 0) {
          gaps.push(`Primary table candidate: ${primary.name} (params: ${paramNames.join(', ')})`);
        }
        if (primary.responseFields && primary.responseFields.length > 0) {
          gaps.push(`Response fields for ${primary.name}: ${primary.responseFields.join(', ')}`);
        }
      }
    }

    if (trpcEndpoints.length > 0) {
      const noBody = trpcEndpoints.filter(t => !t.responseBodyPreview);
      if (noBody.length > 0) {
        gaps.push(`tRPC endpoints detected but ${noBody.length} response body not captured (may need earlier capture or body size limit hit).`);
      }
    }

    // --- RSC gaps ---
    const rscCount = state.stats.rscRequests || 0;
    if (rscCount > 0 && trpcEndpoints.length === 0) {
      gaps.push(`RSC requests detected (${rscCount}) but no tRPC endpoints found — page may use RSC for data delivery instead of tRPC.`);
    }

    // --- Pre-capture awareness ---
    if (preCaptured > 0) {
      gaps.push(`${preCaptured} requests captured before analysis started (auto-capture on navigation).`);
    }

    // --- Response body gaps ---
    const noBodyEvents = (d.api || []).filter(a => a.responseBody === undefined || a.responseBody === null);
    if (noBodyEvents.length > 0 && trpcEndpoints.length === 0) {
      gaps.push(`${noBodyEvents.length} responses captured without body content.`);
    }

    // --- Table data without API correlation ---
    if (state.stats.tableChanges > 0 && trpcEndpoints.length === 0 && state.stats.jsonParsed === 0) {
      gaps.push('Table row count changed, but no tRPC/JSON response correlated. Table may use pre-rendered HTML or SSR data.');
    }

    // --- Schema gaps ---
    const dataEndpoints = apiCandidates.filter(c => c.isDataEndpoint);
    if (dataEndpoints.length > 0 && (d.schemas || []).length === 0) {
      gaps.push('Data endpoints found but no JSON schemas inferred.');
    }

    // --- User interaction gaps ---
    const pagActions = (d.interactions || []).filter(i => i.isPagination);
    const pagEvents = events.filter(e => e.type === 'dom_table_changed');
    if (pagActions.length > 0 && pagEvents.length === 0 && trpcEndpoints.length > 0) {
      gaps.push('Pagination clicks detected but no table changes observed.');
    }

    // --- Detail click gaps ---
    const detailClicks = (d.interactions || []).filter(i => i.isDetailLink);
    if (detailClicks.length > 0) {
      const detailResponses = apiCandidates.filter(c => /detail|view|item/i.test(c.url));
      if (detailResponses.length === 0)
        gaps.push('Detail link clicked but no detail API endpoint captured.');
    }

    // --- Anti-bot gaps ---
    if (d.antiBot?.detected && d.antiBot.challengeStatus === 'pending')
      gaps.push('Turnstile widget loaded but no verified token state recorded.');
    if (d.antiBot?.detected && d.antiBot.challengeStatus === 'unknown')
      gaps.push('Turnstile detected but challenge status could not be determined.');

    // --- Turnstile detected ---
    const cfRequests = (d.network || []).filter(n => n.hasCfHeaders);
    if (cfRequests.length > 0)
      gaps.push(`${cfRequests.length} responses have cf-* headers (rate limiting or bot protection).`);

    // --- No data at all ---
    if (state.stats.apiCalls === 0 && state.stats.jsonParsed === 0 && trpcEndpoints.length === 0 && preCaptured === 0) {
      gaps.push('No fetch/XHR/tRPC requests captured. Start capture earlier on navigation or interact with the page.');
    }

    // --- No user interactions ---
    if (state.stats.userActions === 0 && state.status === 'complete')
      gaps.push('No user interactions recorded. Click filters, pagination, or details for deeper analysis.');

    return gaps;
  }

  // ==========================================================
  // Exports
  // ==========================================================
  async function exportData(type) {
    const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY);
    if (!state) return;

    if (type === 'har') {
      const blob = new Blob([JSON.stringify(generateHAR(state), null, 2)], { type: 'application/json' });
      downloadFile(blob, `deep-scrape-${Date.now()}.har`);
    } else if (type === 'json') {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      downloadFile(blob, `deep-scrape-${Date.now()}.json`);
    } else if (type === 'csv') {
      const blob = new Blob(['﻿' + generateCSV(state)], { type: 'text/csv;charset=utf-8' });
      downloadFile(blob, `deep-scrape-${Date.now()}.csv`);
    } else if (type === 'markdown') {
      const blob = new Blob([generateMarkdown(state)], { type: 'text/markdown;charset=utf-8' });
      downloadFile(blob, `deep-scrape-${Date.now()}.md`);
    } else if (type === 'txt') {
      const blob = new Blob([generateTxt(state)], { type: 'text/plain;charset=utf-8' });
      downloadFile(blob, `deep-scrape-${Date.now()}.txt`);
    }
  }

  // ==========================================================
  // HAR Generator — with request classification
  // ==========================================================
  function generateHAR(state) {
    const d = state.data || {};
    const dom = d.dom || {};
    const ov = dom.overview || {};
    const entries = [];

    for (const event of (d.events || [])) {
      if (event.type === 'response_received' || event.type === 'json_parsed') {
        entries.push({
          startedDateTime: new Date(event.timestamp).toISOString(),
          time: event.duration || 0,
          request: {
            method: event.method || 'GET',
            url: event.url,
            httpVersion: 'HTTP/2',
            headers: Object.entries(event.requestHeaders || {}).map(([n, v]) => ({ name: n, value: v })),
            queryString: extractQS(event.url),
            postData: event.requestBody ? { mimeType: 'application/json', text: event.requestBody } : undefined,
            bodySize: event.requestBody ? event.requestBody.length : 0,
          },
          response: {
            status: event.status || 0,
            statusText: event.statusText || '',
            httpVersion: 'HTTP/2',
            headers: Object.entries(event.responseHeaders || {}).map(([n, v]) => ({ name: n, value: v })),
            content: { size: event.responseBody ? event.responseBody.length : 0, mimeType: event.contentType || '', text: event.responseBody || '' },
            bodySize: event.responseBody ? event.responseBody.length : 0,
          },
          timings: { send: 0, wait: Math.round((event.duration || 0) * 0.7), receive: Math.round((event.duration || 0) * 0.3) },
          _deepScraper: {
            source: event.source, correlationId: event.correlationId,
            responseClass: event.responseClass,
            paginationParams: event.paginationParams, filterParams: event.filterParams,
            schema: event.schema || null,
            classification: classifyRequest(event.url, event.contentType),
            trpcInfo: /\/api\/trpc\//i.test(event.url) ? parseTrpcUrlLocal(event.url) : null
          }
        });
      }
    }

    for (const n of (d.network || [])) {
      entries.push({
        startedDateTime: new Date(n.timestamp ? n.timestamp * 1000 : n.capturedAt || Date.now()).toISOString(),
        time: 0,
        request: { method: 'GET', url: n.url, httpVersion: 'HTTP/2', headers: [], bodySize: 0 },
        response: { status: n.status || 0, statusText: '', httpVersion: 'HTTP/2', headers: [], content: { size: n.body ? n.body.length : 0, mimeType: n.mimeType || '', text: n.body || '' }, bodySize: n.body ? n.body.length : 0 },
        timings: { send: 0, wait: 0, receive: 0 },
        _deepScraper: {
          source: 'cdp', hasCfHeaders: n.hasCfHeaders,
          classification: n.classification || null,
          trpcInfo: n.trpcInfo || null
        }
      });
    }

    return {
      log: {
        version: '1.2',
        creator: { name: 'Deep Scraper Pro', version: '2.0.0' },
        pages: [{
          id: 'page_1', title: ov.title || dom.title || '',
          startedDateTime: new Date(state.startedAt).toISOString(),
          _deepScraper: {
            url: ov.url || dom.url || '',
            framework: d.nextPage?.detected ? 'Next.js' : null,
            frameworkDetails: d.nextPage,
            antiBot: d.antiBot,
            pageType: ov.pageType || 'unknown',
            interactions: d.interactions || [],
            apiCandidates: d.apiCandidates || [],
            schemas: d.schemas || [],
            trpcEndpoints: d.trpcEndpoints || [],
            requestClassifications: d.requestClassifications || [],
            completenessGaps: analyzeGaps(state),
            events: d.events || [],
            preCaptured: state.stats.preCaptured || 0,
            requestTypes: state.stats.requestTypes || {},
          }
        }],
        entries
      }
    };
  }

  function extractQS(url) {
    try { const u = new URL(url); return Array.from(u.searchParams.entries()).map(([n, v]) => ({ name: n, value: v })); } catch { return []; }
  }

  // ==========================================================
  // CSV Generator — with tRPC data
  // ==========================================================
  function generateCSV(state) {
    const rows = [['Category', 'Type', 'Name/URL', 'Content/Value', 'Details', 'Timestamp']];
    const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    const d = state.data;
    const dom = d.dom || {};
    const ov = dom.overview || {};

    if (ov.title) rows.push(['Overview', 'Title', ov.url, ov.title, `Type: ${ov.pageType || 'Web Page'}`, '']);
    dom.headings?.forEach(h => rows.push(['DOM', `H${h.level}`, '', h.text, '', '']));
    dom.links?.forEach(l => rows.push(['DOM', 'Link', l.href, l.text, '', '']));
    dom.images?.forEach(i => rows.push(['DOM', 'Image', i.src, i.alt, `${i.width||'?'}x${i.height||'?'}`, '']));

    (dom.tables || []).forEach((t, i) => {
      if (t.headers?.length) rows.push(['DOM', `Table ${i+1} Header`, '', t.headers.join(' | '), '', '']);
      (t.body || []).forEach(row => rows.push(['DOM', `Table ${i+1}`, '', row.join(' | '), '', '']));
    });

    // tRPC endpoints
    for (const trpc of (d.trpcEndpoints || [])) {
      for (const proc of (trpc.procedures || [])) {
        const params = proc.params ? JSON.stringify(proc.params) : '';
        const fields = proc.responseFields ? proc.responseFields.join(', ') : '';
        rows.push(['tRPC', proc.role || 'unknown', proc.name, fields, `URL: ${trpc.url} | Status: ${trpc.status} | Params: ${params}`, '']);
      }
    }

    // Request classifications
    for (const rc of (d.requestClassifications || []).slice(0, 50)) {
      rows.push(['Classification', rc.type || 'other', rc.url || '', '', `Label: ${rc.label || ''}`, new Date(rc.timestamp).toISOString()]);
    }

    (d.apiCandidates || []).forEach(c => {
      rows.push(['API', c.isDataEndpoint ? 'DATA' : c.isDetailEndpoint ? 'DETAIL' : c.isTrpc ? 'TRPC' : 'OTHER',
        c.url, '', `Status: ${c.status} | ${c.responseSize || 0}B | ${c.duration || 0}ms${c.hasPagination ? ' | PAGINATION' : ''}${c.hasFilter ? ' | FILTER' : ''}`, '']);
    });

    (d.schemas || []).forEach(sc => {
      rows.push(['Schema', sc.method || 'GET', sc.url, JSON.stringify(sc.schema)?.substring(0, 500) || '', '', '']);
    });

    (d.interactions || []).forEach(i => {
      rows.push(['Interaction', i.action, i.url || '', i.text || '', `Element: ${i.element} | ${i.selector || ''}`, new Date(i.timestamp).toISOString()]);
    });

    (d.events || []).forEach(ev => {
      rows.push(['Event', ev.type, ev.url || '', '', `Correlation: ${ev.correlationId || 'none'}`, new Date(ev.timestamp).toISOString()]);
    });

    d.network?.forEach(n => {
      const size = n.body ? n.body.length : 0;
      const cls = n.classification ? n.classification.type : 'unknown';
      rows.push(['Network', cls, n.url || '', truncate(n.body, 300), `Status: ${n.status || ''} | ${size}B${n.hasCfHeaders ? ' | CF-HEADERS' : ''}`, '']);
    });

    d.cookies?.forEach(c => rows.push(['Cookie', '', c.domain, truncate(c.value, 100), `${c.name} | Secure:${c.secure} | HttpOnly:${c.httpOnly}`, '']));

    return rows.map(row => row.map(q).join(',')).join('\n');
  }

  // ==========================================================
  // Markdown Generator (v2 Report + tRPC section)
  // ==========================================================
  function generateMarkdown(state) {
    const d = state.data;
    const dom = d.dom || {};
    const ov = dom.overview || {};
    const tech = dom.tech || {};
    const perf = dom.performance || {};
    const e = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
    const dur = state.completedAt && state.startedAt ? Math.round((state.completedAt - state.startedAt) / 1000) : '?';
    const gaps = analyzeGaps(state);
    const interactions = d.interactions || [];
    const events = d.events || [];
    const candidates = d.apiCandidates || [];
    const schemas = d.schemas || [];
    const tables = dom.tables || [];
    const trpcEndpoints = d.trpcEndpoints || [];
    const requestTypes = state.stats.requestTypes || {};

    let md = '';

    md += `# Deep Scraper Pro v2 — Network-Aware Analysis Report\n\n`;
    md += `> **Generated:** ${new Date(state.completedAt || Date.now()).toLocaleString()}\n`;
    md += `> **Source:** ${e(ov.url || dom.url || 'Unknown')}\n`;
    md += `> **Duration:** ${dur}s | **Events:** ${events.length}`;
    if (state.stats.preCaptured) md += ` | **Pre-captured:** ${state.stats.preCaptured}`;
    md += `\n\n---\n\n`;

    // 1. Page Profile
    md += `## 1. Page Profile\n\n`;
    md += `| Property | Value |\n|----------|-------|\n`;
    md += `| **Title** | ${e(ov.title || dom.title || 'N/A')} |\n`;
    md += `| **URL** | ${e(ov.url || '')} |\n`;
    md += `| **Page Type** | ${ov.pageType || 'Web Page'} |\n`;
    md += `| **Framework** | ${d.nextPage?.detected ? 'Next.js (' + (d.nextPage.routeType || 'unknown') + ')' : 'Not detected'} |\n`;
    md += `| **Anti-Bot** | ${d.antiBot?.detected ? 'Cloudflare Turnstile (' + d.antiBot.challengeStatus + ')' : 'None detected'} |\n`;
    if (d.nextPage?.buildId) md += `| **Build ID** | ${d.nextPage.buildId} |\n`;
    md += `\n`;

    // 2. Request Classification Summary
    md += `## 2. Request Classification\n\n`;
    md += `| Type | Count | Description |\n|------|-------|-------------|\n`;
    md += `| **tRPC** | ${requestTypes.trpc || 0} | tRPC API calls |\n`;
    md += `| **RSC** | ${requestTypes.rsc || 0} | React Server Components navigation/payload |\n`;
    md += `| **Auth** | ${requestTypes.auth || 0} | Authentication/session requests |\n`;
    md += `| **API** | ${requestTypes.api || 0} | Other API requests |\n`;
    md += `| **Asset** | ${requestTypes.asset || 0} | Static assets (_next/static/) |\n`;
    md += `| **Document** | ${requestTypes.document || 0} | HTML page loads |\n`;
    md += `| **Other** | ${requestTypes.other || 0} | Unclassified |\n`;
    md += `\n`;

    // 3. tRPC Analysis
    if (trpcEndpoints.length > 0) {
      md += `## 3. tRPC Endpoint Analysis\n\n`;
      for (let i = 0; i < trpcEndpoints.length; i++) {
        const t = trpcEndpoints[i];
        md += `### ${i+1}. ${t.procedurePath || t.url}\n\n`;
        md += `| Property | Value |\n|----------|-------|\n`;
        md += `| **URL** | \`${e(t.url?.substring(0, 150))}\` |\n`;
        md += `| **Batch** | ${t.isBatch ? 'Yes' : 'No'} |\n`;
        md += `| **Status** | ${t.status || 'N/A'} |\n`;
        md += `| **Response Size** | ${t.responseSize ? (t.responseSize > 1024 ? `${(t.responseSize/1024).toFixed(1)}KB` : `${t.responseSize}B`) : 'N/A'} |\n`;

        if (t.procedures?.length) {
          md += `\n**Procedures:**\n\n`;
          md += `| # | Name | Role | Parameters | Response Fields |\n|---|------|------|------------|----------------|\n`;
          for (let j = 0; j < t.procedures.length; j++) {
            const p = t.procedures[j];
            const params = p.params ? Object.entries(p.params).map(([k, v]) => `${k}=${v === null ? 'null' : v}`).join(', ') : 'N/A';
            const fields = p.responseFields ? p.responseFields.join(', ') : 'N/A';
            md += `| ${j} | \`${p.name}\` | ${p.role} | ${e(params)} | ${e(fields)} |\n`;
          }
        }
        md += `\n`;
      }
    }

    // 4. Anti-Bot
    if (d.antiBot) {
      md += `## 4. Anti-Bot Analysis (Cloudflare Turnstile)\n\n`;
      md += `| Property | Value |\n|----------|-------|\n`;
      md += `| **Detected** | ${d.antiBot.detected ? 'Yes' : 'No'} |\n`;
      md += `| **Widget Loaded** | ${d.antiBot.widgetLoaded ? 'Yes' : 'No'} |\n`;
      md += `| **Challenge Status** | ${d.antiBot.challengeStatus} |\n`;
      if (d.antiBot.observations?.length) {
        md += `\n**Observations:**\n`;
        for (const obs of d.antiBot.observations) md += `- ${e(obs)}\n`;
      }
      md += `\n`;
    }

    // 5. Interaction Map
    if (interactions.length) {
      md += `## 5. Interaction Map (${interactions.length} actions)\n\n`;
      md += `| # | Action | Element | Text | URL |\n|---|--------|---------|------|-----|\n`;
      for (let i = 0; i < interactions.length; i++) {
        const ix = interactions[i];
        let badges = '';
        if (ix.isPagination) badges += ' [PAG]';
        if (ix.isFilter) badges += ' [FILT]';
        if (ix.isDetailLink) badges += ' [DETAIL]';
        md += `| ${i+1} | ${ix.action}${badges} | ${e(ix.element)} | ${e(ix.text?.substring(0, 60))} | ${e(ix.url?.substring(0, 60))} |\n`;
      }
      md += `\n`;
    }

    // 6. Network Timeline
    md += `## 6. Network Timeline\n\n`;
    const netEvents = events.filter(ev => ['request_started', 'response_received', 'json_parsed', 'user_action', 'dom_table_changed', 'route_changed', 'turnstile_detected'].includes(ev.type));
    if (netEvents.length) {
      md += `| Time | Type | URL / Detail | Method | Status | Correlation |\n|------|------|---------------|--------|--------|-------------|\n`;
      for (const ev of netEvents.slice(0, 100)) {
        const t = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '';
        const url = ev.url ? e(ev.url.substring(0, 80)) : '';
        const detail = ev.actionType ? `${ev.action} on <${ev.tag}>` : ev.challengeStatus ? `Turnstile: ${ev.challengeStatus}` : '';
        md += `| ${t} | ${ev.type} | ${url || detail} | ${ev.method || ''} | ${ev.status || ''} | ${ev.correlationId || ''} |\n`;
      }
      if (netEvents.length > 100) md += `\n*...and ${netEvents.length - 100} more events*\n`;
      md += `\n`;
    } else {
      md += `No network events captured.\n\n`;
    }

    // 7. API Candidates
    if (candidates.length) {
      md += `## 7. API Candidates (${candidates.length} endpoints)\n\n`;
      const dataEP = candidates.filter(c => c.isDataEndpoint);
      const trpcEP = candidates.filter(c => c.isTrpc);
      const detailEP = candidates.filter(c => c.isDetailEndpoint);
      const otherEP = candidates.filter(c => !c.isDataEndpoint && !c.isDetailEndpoint && !c.isTrpc);

      if (dataEP.length || trpcEP.length) {
        md += `### Data Endpoints\n\n`;
        md += `| URL | Method | Status | Size | Duration | Pagination | Filter |\n|-----|--------|--------|------|----------|------------|--------|\n`;
        for (const c of [...dataEP, ...trpcEP]) {
          const sz = c.responseSize > 1024 ? `${(c.responseSize/1024).toFixed(1)}KB` : `${c.responseSize}B`;
          const typeLabel = c.isTrpc ? 'tRPC' : '';
          md += `| ${e(c.url.substring(0, 100))} | ${c.method} | ${c.status} | ${sz} | ${c.duration||0}ms | ${c.hasPagination ? '**YES**' : ''} ${c.paginationParams ? Object.entries(c.paginationParams).map(([k,v]) => `${k}=${v}`).join(', ') : ''} | ${c.hasFilter ? '**YES**' : ''} |\n`;
        }
        md += `\n`;
      }
      if (detailEP.length) {
        md += `### Detail Endpoints\n\n`;
        for (const c of detailEP) md += `- \`${c.method} ${e(c.url)}\` — Status: ${c.status}\n`;
        md += `\n`;
      }
      if (otherEP.length) {
        md += `### Other JSON Endpoints\n\n`;
        for (const c of otherEP.slice(0, 20)) md += `- \`${c.method} ${e(c.url)}\` — Status: ${c.status}\n`;
        if (otherEP.length > 20) md += `*...and ${otherEP.length - 20} more*\n`;
        md += `\n`;
      }
    } else if (trpcEndpoints.length === 0) {
      md += `## 7. API Candidates\n\nNo API endpoints identified.\n\n`;
    }

    // 8. Response Schemas
    if (schemas.length) {
      md += `## 8. Response Schemas\n\n`;
      for (const sc of schemas.slice(0, 10)) {
        md += `### ${sc.method || 'GET'} ${e(sc.url.substring(0, 100))}\n\n\`\`\`json\n${JSON.stringify(sc.schema, null, 2).substring(0, 3000)}\n\`\`\`\n\n`;
      }
      if (schemas.length > 10) md += `*...and ${schemas.length - 10} more schemas*\n\n`;
    }

    // 9. Tables
    if (tables.length) {
      md += `## 9. Table Analysis\n\n`;
      for (let i = 0; i < tables.length; i++) {
        const tb = tables[i];
        md += `### Table ${i+1} (${tb.rowCount || '?'} rows)\n\n`;
        if (tb.headers?.length) md += `**Headers:** ${tb.headers.join(' | ')}\n\n`;
        if (tb.body?.length) {
          md += `| ${tb.headers?.join(' | ') || tb.body[0]?.map(() => '---').join(' | ')} |\n`;
          md += `|${tb.headers?.map(() => '---').join('|')}|\n`;
          for (const row of tb.body.slice(0, 10)) md += `| ${row.join(' | ')} |\n`;
          if (tb.body.length > 10) md += `| ... | *${tb.body.length - 10} more rows* |\n`;
          md += `\n`;
        }
      }
    }

    // 10. Tech Stack
    md += `## 10. Technology Stack\n\n`;
    const jsFw = tech.jsFrameworks || [];
    if (jsFw.length) {
      md += `| Framework | Confidence | Evidence |\n|-----------|-----------|----------|\n`;
      for (const fw of jsFw) md += `| ${e(fw.name)} | ${fw.confidence} | ${e(fw.evidence)} |\n`;
      md += `\n`;
    }
    const tp = tech.thirdParty || [];
    if (tp.length) {
      md += `| Service | Category |\n|---------|----------|\n`;
      for (const s of tp) md += `| ${e(s.name)} | ${s.category} |\n`;
      md += `\n`;
    }

    // 11. Performance
    md += `## 11. Performance\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| DOM Nodes | ${perf.totalDOMNodes || 0} |\n| Scripts | ${perf.scriptsCount || 0} |\n| Images | ${perf.imagesCount || 0} |\n| Iframes | ${perf.iframesCount || 0} |\n\n`;

    // 12. Gaps
    if (gaps.length) {
      md += `## 12. Data Completeness\n\n`;
      for (const g of gaps) md += `- ${e(g)}\n`;
      md += `\n`;
    }

    // 13. Reproduction Steps
    md += `## 13. Reproduction Steps\n\n`;
    md += `1. Open ${e(ov.url || dom.url || 'target page')}\n`;
    md += `2. Wait for page to fully load (check for Turnstile)\n`;
    const relActions = interactions.filter(i => i.isPagination || i.isFilter || i.isDetailLink);
    if (relActions.length) {
      relActions.forEach((ix, idx) => {
        md += `${idx + 3}. ${ix.isPagination ? 'Click pagination' : ix.isFilter ? 'Apply filter' : 'Open detail'}: ${e(ix.text?.substring(0, 60))}\n`;
      });
    } else {
      md += `3. Interact with the page (click pagination, filters, detail links)\n`;
    }
    md += `\n`;

    // 14. Risk Notes
    md += `## 14. Risk Notes\n\n`;
    if (d.antiBot?.detected) md += `- **Cloudflare Turnstile active** — automation may be blocked.\n`;
    if ((d.network || []).some(n => n.hasCfHeaders)) md += `- **cf-* response headers detected** — rate limiting may be active.\n`;
    if (d.nextPage?.detected && d.nextPage?.routeType === 'SSR') md += `- **Next.js SSR** — data may be server-rendered.\n`;
    if (trpcEndpoints.length === 0 && tables.length > 0) md += `- **No tRPC/API data found but tables exist** — data may be pre-rendered HTML or loaded before capture started.\n`;
    if (state.stats.userActions === 0) md += `- **No user interactions** — API endpoints for pagination/filtering undiscovered.\n`;
    md += `\n---\n\n`;
    md += `*Deep Scraper Pro v2.0.0 | ${new Date().toLocaleString()}*\n`;
    md += `*${state.stats.domRecords} DOM | ${state.stats.apiCalls} API | ${state.stats.trpcEndpoints} tRPC | ${state.stats.jsonParsed} JSON | ${state.stats.userActions} actions*\n`;

    return md;
  }

  // ==========================================================
  // TXT Generator (v2 + tRPC)
  // ==========================================================
  function generateTxt(state) {
    const d = state.data;
    const dom = d.dom || {};
    const ov = dom.overview || {};
    const tech = dom.tech || {};
    const perf = dom.performance || {};
    const e = (s) => String(s || '').replace(/\n/g, ' ').replace(/\r/g, '');
    const dur = state.completedAt && state.startedAt ? Math.round((state.completedAt - state.startedAt) / 1000) : '?';
    const gaps = analyzeGaps(state);
    const interactions = d.interactions || [];
    const candidates = d.apiCandidates || [];
    const schemas = d.schemas || [];
    const tables = dom.tables || [];
    const trpcEndpoints = d.trpcEndpoints || [];
    const requestTypes = state.stats.requestTypes || {};

    let t = '';
    t += `${'='.repeat(60)}\n  DEEP SCRAPER PRO v2 — NETWORK-AWARE ANALYSIS\n${'='.repeat(60)}\n`;
    t += `  Generated : ${new Date(state.completedAt || Date.now()).toLocaleString()}\n`;
    t += `  Source    : ${e(ov.url || dom.url || 'Unknown')}\n`;
    t += `  Duration  : ${dur}s | Events: ${(d.events||[]).length}`;
    if (state.stats.preCaptured) t += ` | Pre-captured: ${state.stats.preCaptured}`;
    t += `\n${'='.repeat(60)}\n\n`;

    t += `PAGE PROFILE\n${'-'.repeat(40)}\n`;
    t += `  Title        : ${e(ov.title || 'N/A')}\n  Page Type    : ${ov.pageType || 'Web Page'}\n`;
    t += `  Framework    : ${d.nextPage?.detected ? 'Next.js (' + (d.nextPage.routeType || '?') + ')' : 'Not detected'}\n`;
    t += `  Anti-Bot     : ${d.antiBot?.detected ? 'Turnstile (' + d.antiBot.challengeStatus + ')' : 'None'}\n\n`;

    t += `REQUEST CLASSIFICATION\n${'-'.repeat(40)}\n`;
    for (const [type, count] of Object.entries(requestTypes)) {
      if (count > 0) t += `  ${type.toUpperCase().padEnd(12)} : ${count}\n`;
    }
    t += `\n`;

    if (trpcEndpoints.length > 0) {
      t += `tRPC ENDPOINT ANALYSIS\n${'-'.repeat(40)}\n`;
      for (let i = 0; i < trpcEndpoints.length; i++) {
        const trpc = trpcEndpoints[i];
        t += `  ${i+1}. ${trpc.procedurePath}\n`;
        t += `     URL: ${trpc.url}\n`;
        t += `     Batch: ${trpc.isBatch ? 'Yes' : 'No'} | Status: ${trpc.status || 'N/A'}\n`;
        if (trpc.procedures?.length) {
          for (const proc of trpc.procedures) {
            t += `     -> ${proc.name} (${proc.role})\n`;
            if (proc.params) {
              const entries = Object.entries(proc.params);
              const nonNull = entries.filter(([,v]) => v != null);
              if (nonNull.length) t += `        Params: ${nonNull.map(([k,v]) => `${k}=${v}`).join(', ')}\n`;
            }
            if (proc.responseFields?.length) {
              t += `        Response fields: ${proc.responseFields.join(', ')}\n`;
            }
          }
        }
        t += `\n`;
      }
    }

    if (d.antiBot) {
      t += `ANTI-BOT (CLOUDFLARE TURNSTILE)\n${'-'.repeat(40)}\n`;
      t += `  Detected: ${d.antiBot.detected} | Widget: ${d.antiBot.widgetLoaded} | Status: ${d.antiBot.challengeStatus}\n`;
      if (d.antiBot.observations?.length) for (const obs of d.antiBot.observations) t += `  - ${obs}\n`;
      t += `\n`;
    }

    if (interactions.length) {
      t += `INTERACTION MAP (${interactions.length})\n${'-'.repeat(40)}\n`;
      for (let i = 0; i < interactions.length; i++) {
        const ix = interactions[i];
        let flags = [];
        if (ix.isPagination) flags.push('PAG'); if (ix.isFilter) flags.push('FILT'); if (ix.isDetailLink) flags.push('DETAIL');
        t += `  ${i+1}. [${ix.action}${flags.length ? ' ' + flags.join(',') : ''}] <${ix.element}> ${e(ix.text?.substring(0, 60))}\n`;
      }
      t += `\n`;
    }

    if (candidates.length) {
      t += `API CANDIDATES (${candidates.length})\n${'-'.repeat(40)}\n`;
      const dep = candidates.filter(c => c.isDataEndpoint || c.isTrpc);
      if (dep.length) {
        t += `  DATA/tRPC ENDPOINTS:\n`;
        for (const c of dep) {
          t += `    ${c.method} ${c.url}\n      Status: ${c.status} | ${c.responseSize || 0}B | ${c.duration || 0}ms\n`;
          if (c.paginationParams) t += `      Pagination: ${JSON.stringify(c.paginationParams)}\n`;
          if (c.filterParams) t += `      Filters: ${JSON.stringify(c.filterParams)}\n\n`;
        }
      }
      const dtep = candidates.filter(c => c.isDetailEndpoint);
      if (dtep.length) { t += `  DETAIL ENDPOINTS:\n`; for (const c of dtep) t += `    ${c.method} ${c.url} (${c.status})\n`; t += `\n`; }
    }

    if (schemas.length) {
      t += `RESPONSE SCHEMAS (${schemas.length})\n${'-'.repeat(40)}\n`;
      for (const sc of schemas.slice(0, 5)) { t += `  ${sc.method || 'GET'} ${sc.url}\n  ${JSON.stringify(sc.schema, null, 2).substring(0, 1000)}\n\n`; }
    }

    if (tables.length) {
      t += `TABLES\n${'-'.repeat(40)}\n`;
      for (let i = 0; i < tables.length; i++) {
        const tb = tables[i];
        t += `  Table ${i+1}: ${tb.rowCount || '?'} rows\n`;
        if (tb.headers?.length) t += `    Headers: ${tb.headers.join(' | ')}\n`;
        if (tb.body?.length) { for (const row of tb.body.slice(0, 5)) t += `    | ${row.join(' | ')} |\n`; t += `\n`; }
      }
    }

    t += `TECH STACK\n${'-'.repeat(40)}\n`;
    for (const fw of (tech.jsFrameworks || [])) t += `  [${fw.confidence}] ${fw.name} — ${e(fw.evidence)}\n`;
    for (const s of (tech.thirdParty || [])) t += `  [${s.category}] ${s.name}\n`;
    t += `\nPERFORMANCE\n${'-'.repeat(40)}\n  DOM: ${perf.totalDOMNodes||0} | Scripts: ${perf.scriptsCount||0} | Images: ${perf.imagesCount||0} | Iframes: ${perf.iframesCount||0}\n\n`;

    if (gaps.length) { t += `DATA COMPLETENESS\n${'-'.repeat(40)}\n`; for (const g of gaps) t += `  - ${g}\n`; t += `\n`; }

    t += `REPRODUCTION STEPS\n${'-'.repeat(40)}\n  1. Open ${e(ov.url || 'target page')}\n`;
    const ra = interactions.filter(i => i.isPagination || i.isFilter || i.isDetailLink);
    if (ra.length) { t += `  2. Wait for page load\n`; ra.forEach((ix, idx) => { t += `  ${idx+3}. ${ix.isPagination ? 'Pagination' : ix.isFilter ? 'Filter' : 'Detail'}: ${e(ix.text?.substring(0, 60))}\n`; }); }
    else { t += `  2. Interact with page for deeper analysis\n`; }
    t += `\nRISKS\n${'-'.repeat(40)}\n`;
    if (d.antiBot?.detected) t += `  - Cloudflare Turnstile active\n`;
    if (trpcEndpoints.length === 0 && tables.length > 0) t += `  - No tRPC/API data found, table may be SSR or loaded before capture\n`;
    if (state.stats.userActions === 0) t += `  - No user interactions recorded\n`;
    t += `\n${'='.repeat(60)}\n  Deep Scraper Pro v2.0.0 | ${new Date().toLocaleString()}\n  ${state.stats.domRecords} DOM | ${state.stats.apiCalls} API | ${state.stats.trpcEndpoints} tRPC | ${state.stats.jsonParsed} JSON | ${state.stats.userActions} actions\n${'='.repeat(60)}\n`;

    return t;
  }

  // ==========================================================
  // Helpers
  // ==========================================================
  function fmt(n) { return n > 999 ? (n/1000).toFixed(1) + 'k' : n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function truncate(str, max) { if (!str) return ''; return String(str).length > max ? String(str).substring(0, max) + '...' : String(str); }
  function showError(msg) { els.error.textContent = msg; els.error.style.display = 'block'; }
  function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 10000));
  }

  // Lightweight local versions for HAR generation (avoid importing from background)
  function parseTrpcUrlLocal(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^\/api\/trpc\/(.+)$/);
      if (!m) return null;
      return { isTrpc: true, procedurePath: m[1], procedureNames: m[1].split(','), isBatch: u.searchParams.get('batch') === '1' };
    } catch { return null; }
  }

  function classifyRequest(url, mimeType) {
    try {
      const u = new URL(url);
      if (u.searchParams.has('_rsc')) return { type: 'rsc', label: 'RSC Navigation/Payload' };
      if (u.pathname.startsWith('/api/trpc/')) return { type: 'trpc', label: 'tRPC API' };
      if (/\/api\/auth\//.test(u.pathname)) return { type: 'auth', label: 'Auth/Session' };
      if (u.pathname.startsWith('/_next/static/')) return { type: 'asset', label: 'Static Asset' };
      if (u.pathname.startsWith('/api/')) return { type: 'api', label: 'API Request' };
      if (/text\/html/i.test(mimeType)) return { type: 'document', label: 'Document/Page' };
      return { type: 'other', label: 'Other' };
    } catch { return { type: 'other', label: 'Other' }; }
  }

  init();
})();
