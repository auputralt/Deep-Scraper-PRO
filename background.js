// ==========================================================
// Deep Scraper v2 — background.js (Manifest V3 Service Worker)
// Event timeline + HAR structure + session replay + correlation
// + auto-capture on navigation + tRPC parser + request classifier
// ==========================================================

const STORAGE_KEY = 'deepScraperState';
const CDP_VERSION = '1.3';
const MONITOR_DURATION = 30000;
const TARGET_DOMAINS = ['indotender.com'];
const PRE_CAPTURE_LIMIT = 500;

const sessions = new Map();
const autoStopTimers = new Map();
const preCaptureBuffers = new Map();

// ==========================================================
// State Management
// ==========================================================
const freshState = (tabId = null) => ({
  status: 'idle',
  tabId,
  version: '2.0.0',
  stats: {
    domRecords: 0, apiCalls: 0, wsFrames: 0, cookies: 0,
    userActions: 0, tableChanges: 0, jsonParsed: 0,
    turnstileDetected: false,
    trpcEndpoints: 0,
    rscRequests: 0,
    preCaptured: 0,
    requestTypes: { rsc: 0, trpc: 0, auth: 0, api: 0, asset: 0, document: 0, other: 0 }
  },
  data: {
    dom: null, api: [], network: [], ws: [], cookies: [],
    events: [],
    apiCandidates: [],
    schemas: [],
    interactions: [],
    antiBot: null,
    nextPage: null,
    trpcEndpoints: [],
    requestClassifications: [],
  },
  startedAt: Date.now(),
  completedAt: null
});

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || freshState();
}

async function updateState(updaterFn) {
  const state = await getState();
  const newState = updaterFn(state);
  if (newState === undefined) throw new Error('updateState updater must return state');
  await chrome.storage.local.set({ [STORAGE_KEY]: newState });
  return newState;
}

function countDomRecords(dom) {
  if (!dom) return 0;
  const keys = ['headings', 'links', 'images', 'tables', 'metaTags', 'jsonLd', 'cssColors', 'forms', 'dynamicElements'];
  let count = keys.reduce((sum, key) => sum + (Array.isArray(dom[key]) ? dom[key].length : 0), 0);
  if (Array.isArray(dom.tech?.jsFrameworks)) count += dom.tech.jsFrameworks.length;
  if (Array.isArray(dom.tech?.thirdParty)) count += dom.tech.thirdParty.length;
  if (Array.isArray(dom.tech?.stylesheets)) count += dom.tech.stylesheets.length;
  if (Array.isArray(dom.tech?.scripts)) count += dom.tech.scripts.length;
  if (Array.isArray(dom.css?.colors)) count += dom.css.colors.length;
  if (Array.isArray(dom.css?.fonts)) count += dom.css.fonts.length;
  return count;
}

// ==========================================================
// Request Classification
// ==========================================================
function classifyRequest(url, mimeType = '') {
  try {
    const u = new URL(url);
    const path = u.pathname;

    if (u.searchParams.has('_rsc'))
      return { type: 'rsc', label: 'RSC Navigation/Payload', subtype: 'rsc_navigation_or_payload' };

    if (path.startsWith('/api/trpc/'))
      return { type: 'trpc', label: 'tRPC API', subtype: 'trpc_batch_api' };

    if (/\/api\/auth\//.test(path))
      return { type: 'auth', label: 'Auth/Session', subtype: 'auth' };

    if (path.startsWith('/_next/static/') || path.startsWith('/_next/'))
      return { type: 'asset', label: 'Static Asset', subtype: 'asset' };

    if (path.startsWith('/api/'))
      return { type: 'api', label: 'API Request', subtype: 'api' };

    if (/text\/html/i.test(mimeType) || path.endsWith('/') || /\.(html|xhtml)$/i.test(path))
      return { type: 'document', label: 'Document/Page', subtype: 'document' };

    return { type: 'other', label: 'Other', subtype: 'other' };
  } catch {
    return { type: 'other', label: 'Other', subtype: 'other' };
  }
}

// ==========================================================
// tRPC URL Parser
// ==========================================================
function parseTrpcUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const trpcMatch = path.match(/^\/api\/trpc\/(.+)$/);
    if (!trpcMatch) return null;

    const procedurePath = trpcMatch[1];
    const procedureNames = procedurePath.split(',').map(s => s.trim());
    const isBatch = u.searchParams.get('batch') === '1';

    const rawInput = u.searchParams.get('input');
    let parsedInput = null;
    if (rawInput) {
      try {
        parsedInput = JSON.parse(decodeURIComponent(rawInput));
      } catch {
        try { parsedInput = JSON.parse(rawInput); } catch {}
      }
    }

    const procedures = [];
    if (isBatch && parsedInput && typeof parsedInput === 'object') {
      for (let i = 0; i < procedureNames.length; i++) {
        const name = procedureNames[i];
        const procInput = parsedInput[String(i)];
        let params = null;
        let role = 'unknown';

        if (procInput) {
          const data = procInput.json !== undefined ? procInput.json : procInput;
          params = data;
        }

        if (/directory|keys|options|meta|filter/i.test(name)) role = 'filter_metadata';
        else if (/list|search|query|pagination|getall/i.test(name)) role = 'table_data';
        else if (/detail|view|getbyid|find/i.test(name)) role = 'detail_data';
        else if (/count|total/i.test(name)) role = 'count';

        procedures.push({ name, role, params });
      }
    } else if (!isBatch && parsedInput) {
      const data = parsedInput.json !== undefined ? parsedInput.json : parsedInput;
      let role = 'unknown';
      if (/directory|keys|options|meta/i.test(procedurePath)) role = 'filter_metadata';
      else if (/list|search|query|pagination/i.test(procedurePath)) role = 'table_data';
      else if (/detail|view|getbyid/i.test(procedurePath)) role = 'detail_data';
      procedures.push({ name: procedurePath, role, params: data });
    } else {
      for (const name of procedureNames) {
        let role = 'unknown';
        if (/directory|keys|options|meta/i.test(name)) role = 'filter_metadata';
        else if (/list|search|query|pagination/i.test(name)) role = 'table_data';
        procedures.push({ name, role, params: null });
      }
    }

    return { isTrpc: true, isBatch, procedurePath, procedureNames, procedures, input: parsedInput };
  } catch {
    return null;
  }
}

function inferTrpcRole(name) {
  if (/directory|keys|options|meta|filter/i.test(name)) return 'filter_metadata';
  if (/list|search|query|pagination|getall/i.test(name)) return 'table_data';
  if (/detail|view|getbyid|find/i.test(name)) return 'detail_data';
  if (/count|total/i.test(name)) return 'count';
  return 'unknown';
}

function extractTopLevelFields(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    const item = data[0];
    if (typeof item === 'object' && item !== null) return Object.keys(item);
    return [];
  }
  return Object.keys(data);
}

// ==========================================================
// API Candidate Detection
// ==========================================================
function classifyApiCandidate(entry) {
  const url = entry.url || '';
  const ct = entry.contentType || entry.responseClass || '';
  const isJson = ct.includes('json') || entry.responseClass === 'json';
  const isHtml = ct.includes('html');
  const hasPagination = entry.paginationParams && Object.keys(entry.paginationParams).length > 0;
  const hasFilter = entry.filterParams && Object.keys(entry.filterParams).length > 0;
  const hasBody = entry.responseBody && entry.responseBody.length > 10;
  const isApi = isJson && hasBody;
  const isDataEndpoint = isApi && (hasPagination || hasFilter || /api|data|search|query|tender|list|trpc/i.test(url));
  const isDetailEndpoint = isApi && /detail|view|item|\/\d+$/i.test(url);
  const isTrpc = /\/api\/trpc\//i.test(url);

  return {
    url, method: entry.method || 'GET',
    status: entry.status,
    isJson, isHtml, isDataEndpoint, isDetailEndpoint, isTrpc,
    hasPagination, hasFilter,
    paginationParams: entry.paginationParams,
    filterParams: entry.filterParams,
    schema: entry.schema || null,
    trpcInfo: entry.trpcInfo || null,
    responseSize: entry.responseBody ? entry.responseBody.length : 0,
    duration: entry.duration,
    correlationId: entry.correlationId
  };
}

// ==========================================================
// Message Router
// ==========================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    console.error('[DeepScraper] Error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'startExtraction': return startExtraction(msg.tabId);
    case 'stopExtraction': return stopExtraction(msg.tabId);
    case 'ping': return { pong: true };

    case 'domData':
      await updateState(s => {
        s.data.dom = msg.data;
        s.stats.domRecords = countDomRecords(msg.data);
        return s;
      });
      return { ok: true };

    case 'domDataUpdate':
      await updateState(s => {
        if (s.data.dom && msg.data.dynamicElements) {
          s.data.dom.dynamicElements = msg.data.dynamicElements;
          s.stats.domRecords = countDomRecords(s.data.dom);
        }
        return s;
      });
      return { ok: true };

    case 'apiData':
      await updateState(s => {
        s.data.api.push(msg.data);
        s.stats.apiCalls = s.data.api.length;
        return s;
      });
      return { ok: true };

    case 'event':
      await handleEvent(msg.data);
      return { ok: true };

    default: return { error: 'Unknown action' };
  }
}

// ==========================================================
// Event Handler — Routes all events to timeline + state
// ==========================================================
async function handleEvent(event) {
  const state = await getState();
  if (state.status !== 'extracting' && event.type !== 'export_ready') return;

  await updateState(s => {
    s.data.events.push(event);

    switch (event.type) {
      case 'user_action':
        s.stats.userActions = s.data.events.filter(e => e.type === 'user_action').length;
        s.data.interactions.push({
          id: event.id,
          action: event.actionType || event.type,
          element: event.tag,
          text: event.text?.substring(0, 100),
          selector: event.selector,
          url: event.url,
          isPagination: event.isPagination,
          isFilter: event.isFilter,
          isDetailLink: event.isDetailLink,
          timestamp: event.timestamp
        });
        break;

      case 'json_parsed':
        s.stats.jsonParsed = s.data.events.filter(e => e.type === 'json_parsed').length;
        const candidate = classifyApiCandidate(event);
        s.data.apiCandidates.push(candidate);
        if (event.schema) {
          s.data.schemas.push({
            url: event.url,
            method: event.method,
            schema: event.schema,
            timestamp: event.timestamp
          });
        }
        // Also add to legacy api array
        if (!s.data.api.find(a => a.url === event.url && a.timestamp === event.timestamp)) {
          s.data.api.push(event);
          s.stats.apiCalls = s.data.api.length;
        }
        break;

      case 'response_received':
        if (!s.data.api.find(a => a.url === event.url && a.timestamp === event.timestamp)) {
          s.data.api.push(event);
          s.stats.apiCalls = s.data.api.length;
        }
        break;

      case 'dom_table_changed':
        s.stats.tableChanges = s.data.events.filter(e => e.type === 'dom_table_changed').length;
        break;

      case 'turnstile_detected':
        s.stats.turnstileDetected = event.detected;
        s.data.antiBot = event;
        break;

      case 'nextjs_detected':
        s.data.nextPage = event;
        break;

      case 'page_loaded':
      case 'route_changed':
      case 'request_started':
      case 'request_error':
      case 'export_ready':
        break;
    }

    return s;
  });
}

// ==========================================================
// Extraction Orchestration
// ==========================================================
async function startExtraction(tabId) {
  if (autoStopTimers.has(tabId)) clearTimeout(autoStopTimers.get(tabId));

  // Merge pre-capture buffer into fresh state
  const preCapture = preCaptureBuffers.get(tabId);
  preCaptureBuffers.delete(tabId);

  const initialState = { ...freshState(tabId), status: 'extracting' };

  if (preCapture && preCapture.network.length > 0) {
    initialState.data.network = preCapture.network;
    initialState.data.trpcEndpoints = preCapture.trpcEndpoints;
    initialState.data.requestClassifications = preCapture.requestClassifications;
    initialState.stats.preCaptured = preCapture.network.length;
    initialState.stats.trpcEndpoints = preCapture.trpcEndpoints.length;

    // Count request types from pre-captured classifications
    for (const rc of preCapture.requestClassifications) {
      if (rc.type) {
        initialState.stats.requestTypes[rc.type] = (initialState.stats.requestTypes[rc.type] || 0) + 1;
      }
    }
    initialState.stats.rscRequests = initialState.stats.requestTypes.rsc || 0;

    // Count pre-captured JSON responses as apiCalls
    const jsonResponses = preCapture.network.filter(n => n.isText && /json/i.test(n.mimeType));
    initialState.stats.apiCalls = jsonResponses.length;
    initialState.stats.jsonParsed = jsonResponses.length;

    // Build apiCandidates from trpcEndpoints
    for (const trpc of preCapture.trpcEndpoints) {
      if (trpc.procedures) {
        const tableProc = trpc.procedures.find(p => p.role === 'table_data');
        if (tableProc?.params) {
          initialState.data.apiCandidates.push({
            url: trpc.url,
            method: 'GET',
            status: trpc.status,
            isJson: true,
            isDataEndpoint: true,
            isDetailEndpoint: false,
            isTrpc: true,
            hasPagination: !!(tableProc.params.page || tableProc.params.limit),
            hasFilter: !!(tableProc.params.lpse || tableProc.params.year || tableProc.params.winner || tableProc.params.workUnit),
            paginationParams: Object.fromEntries(
              Object.entries(tableProc.params).filter(([k]) => ['page', 'limit', 'offset', 'cursor'].includes(k))
            ),
            filterParams: Object.fromEntries(
              Object.entries(tableProc.params).filter(([k]) => ['lpse', 'year', 'winner', 'workUnit', 'name', 'keyword'].includes(k))
            ),
            trpcInfo: trpc,
            responseSize: trpc.responseSize || 0,
            correlationId: null
          });
        }
      }
    }
  }

  await updateState(() => initialState);

  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (!res?.pong) throw new Error('Not alive');
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }

  await attachDebugger(tabId);
  chrome.tabs.sendMessage(tabId, { action: 'doExtract' }).catch(() => {});

  try {
    const tab = await chrome.tabs.get(tabId);
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    await updateState(s => {
      s.data.cookies = cookies.map(c => ({ ...c }));
      s.stats.cookies = cookies.length;
      return s;
    });
  } catch {}

  const timer = setTimeout(() => stopExtraction(tabId), MONITOR_DURATION);
  autoStopTimers.set(tabId, timer);
  return { success: true };
}

async function stopExtraction(tabId) {
  if (autoStopTimers.has(tabId)) clearTimeout(autoStopTimers.get(tabId));
  const state = await getState();
  if (state.status !== 'extracting') return { success: false, reason: 'Not extracting' };

  await detachDebugger(tabId);
  try { await chrome.tabs.sendMessage(tabId, { action: 'stopExtract' }); } catch {}
  await new Promise(r => setTimeout(r, 500));

  await updateState(s => {
    s.status = 'complete';
    s.completedAt = Date.now();

    // Deduplicate API candidates
    const seen = new Set();
    s.data.apiCandidates = s.data.apiCandidates.filter(c => {
      const key = `${c.method}:${c.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    s.data.apiCandidates.sort((a, b) => {
      const score = (c) => (c.isDataEndpoint ? 3 : c.isDetailEndpoint ? 2 : c.isJson ? 1 : 0);
      return score(b) - score(a);
    });

    // Deduplicate schemas
    const schemaSeen = new Set();
    s.data.schemas = s.data.schemas.filter(sc => {
      const key = `${sc.method}:${sc.url}`;
      if (schemaSeen.has(key)) return false;
      schemaSeen.add(key);
      return true;
    });

    // Deduplicate trpcEndpoints
    const trpcSeen = new Set();
    s.data.trpcEndpoints = s.data.trpcEndpoints.filter(t => {
      const key = t.procedurePath || t.url;
      if (trpcSeen.has(key)) return false;
      trpcSeen.add(key);
      return true;
    });
    s.stats.trpcEndpoints = s.data.trpcEndpoints.length;

    return s;
  });

  return { success: true };
}

// ==========================================================
// CDP Manager
// ==========================================================
async function attachDebugger(tabId) {
  if (sessions.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    sessions.set(tabId, { pendingRequests: new Map() });
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  } catch (e) {
    console.warn('[DeepScraper] CDP Attach failed:', e);
  }
}

async function detachDebugger(tabId) {
  if (!sessions.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch {}
  sessions.delete(tabId);
}

// ==========================================================
// CDP Event Handler — with classification + tRPC parsing
// ==========================================================
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const session = sessions.get(source.tabId);
  if (!session) return;
  const tabId = source.tabId;
  const isPreCapturing = preCaptureBuffers.has(tabId);

  if (method === 'Network.responseReceived') {
    const mime = params.response?.mimeType || '';
    const headers = params.response?.headers || {};
    const cfHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase().startsWith('cf-')) cfHeaders[k] = '[detected]';
    }
    const hasCfHeaders = Object.keys(cfHeaders).length > 0;

    const classification = classifyRequest(params.response?.url || '', mime);
    const trpcInfo = classification.type === 'trpc' ? parseTrpcUrl(params.response?.url || '') : null;

    session.pendingRequests.set(params.requestId, {
      url: params.response?.url,
      status: params.response?.status,
      mimeType: mime,
      isText: /json|text|xml|javascript|html|graphql|svg/i.test(mime),
      timestamp: params.timestamp,
      cfHeaders,
      hasCfHeaders,
      responseHeaders: headers,
      classification,
      trpcInfo
    });
  }

  else if (method === 'Network.loadingFinished') {
    const info = session.pendingRequests.get(params.requestId);
    if (!info) return;
    session.pendingRequests.delete(params.requestId);

    let body = '[non-text content]';
    if (info.isText) {
      try {
        const result = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId });
        body = result.base64Encoded ? '[base64-encoded]' : (result.body || '').substring(0, 100000);
      } catch { body = '[body unavailable]'; }
    }

    const entry = { ...info, body, capturedAt: Date.now() };

    // Parse tRPC response body
    if (entry.trpcInfo && entry.isText && body !== '[non-text content]' && body !== '[body unavailable]') {
      try {
        const parsedBody = JSON.parse(body);
        entry.trpcParsed = true;

        if (entry.trpcInfo.isBatch && typeof parsedBody === 'object') {
          for (const proc of entry.trpcInfo.procedures) {
            const idx = entry.trpcInfo.procedureNames.indexOf(proc.name);
            const resultData = parsedBody[String(idx)]?.result?.data;
            if (resultData) {
              proc.responseFields = extractTopLevelFields(resultData);
              proc.responseSize = JSON.stringify(resultData).length;
              proc.responsePreview = JSON.stringify(resultData).substring(0, 5000);
            }
          }
        } else if (parsedBody?.result?.data) {
          const data = parsedBody.result.data;
          entry.trpcInfo.procedures[0].responseFields = extractTopLevelFields(data);
          entry.trpcInfo.procedures[0].responseSize = JSON.stringify(data).length;
          entry.trpcInfo.procedures[0].responsePreview = JSON.stringify(data).substring(0, 5000);
        }
      } catch {}
    }

    // Store in pre-capture buffer
    if (isPreCapturing) {
      const buffer = preCaptureBuffers.get(tabId);
      if (buffer && buffer.network.length < PRE_CAPTURE_LIMIT) {
        buffer.network.push(entry);

        if (entry.trpcInfo) {
          buffer.trpcEndpoints.push({
            ...entry.trpcInfo,
            url: entry.url,
            status: entry.status,
            mimeType: entry.mimeType,
            responseSize: body.length,
            responseBodyPreview: entry.isText && body !== '[non-text content]' ? body.substring(0, 50000) : null,
            capturedAt: Date.now()
          });
        }

        buffer.requestClassifications.push({
          url: entry.url,
          ...entry.classification,
          status: entry.status,
          timestamp: Date.now()
        });
      }
      return;
    }

    // Store in active session state
    const state = await getState();
    if (state.status !== 'extracting') return;

    await updateState(s => {
      s.data.network.push(entry);

      if (entry.trpcInfo) {
        s.data.trpcEndpoints.push({
          ...entry.trpcInfo,
          url: entry.url,
          status: entry.status,
          mimeType: entry.mimeType,
          responseSize: body.length,
          responseBodyPreview: entry.isText && body !== '[non-text content]' ? body.substring(0, 50000) : null,
          capturedAt: Date.now()
        });
        s.stats.trpcEndpoints = s.data.trpcEndpoints.length;
      }

      s.data.requestClassifications.push({
        url: entry.url,
        ...entry.classification,
        status: entry.status,
        timestamp: Date.now()
      });

      if (entry.classification) {
        s.stats.requestTypes[entry.classification.type] = (s.stats.requestTypes[entry.classification.type] || 0) + 1;
        s.stats.rscRequests = s.stats.requestTypes.rsc || 0;
      }

      return s;
    });
  }

  else if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
    if (!isPreCapturing) {
      const state = await getState();
      if (state.status !== 'extracting') return;
    }

    const entry = {
      direction: method.includes('Received') ? 'received' : 'sent',
      data: params.response?.payloadData || '',
      timestamp: Date.now()
    };

    if (isPreCapturing) {
      const buffer = preCaptureBuffers.get(tabId);
      if (buffer) {
        // ws not buffered in pre-capture
      }
      return;
    }

    await updateState(s => {
      s.data.ws.push(entry);
      s.stats.wsFrames = s.data.ws.length;
      return s;
    });
  }
});

chrome.debugger.onDetach.addListener((source) => sessions.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  if (autoStopTimers.has(tabId)) clearTimeout(autoStopTimers.get(tabId));
  preCaptureBuffers.delete(tabId);
});

// ==========================================================
// Auto-Capture via webNavigation
// ==========================================================
function isTargetDomain(url) {
  try {
    const u = new URL(url);
    return TARGET_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!isTargetDomain(details.url)) return;

  const tabId = details.tabId;

  // Clear previous buffer for this tab
  preCaptureBuffers.set(tabId, {
    network: [],
    trpcEndpoints: [],
    requestClassifications: [],
    startedAt: Date.now()
  });

  // Auto-attach CDP to capture initial network requests
  await attachDebugger(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  // Clear pre-capture buffer on new navigation
  preCaptureBuffers.delete(details.tabId);
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!isTargetDomain(details.url)) return;
  // Page fully loaded — pre-capture buffer now has initial requests
});
