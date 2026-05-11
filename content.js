// ==========================================================
// Deep Scraper v2 — content.js (Isolated World)
// DOM scraping + UI action recorder + Next.js/Turnstile detectors
// + table MutationObserver + schema extractor + correlation engine
// ==========================================================

(() => {
  'use strict';

  const MSG_PREFIX = '__DEEP_SCRAPER__';
  let isExtracting = false;
  let domObserver = null;
  const dynamicNodes = [];
  let actionCounter = 0;
  let currentCorrelationId = null;

  // ==========================================================
  // Communication: Background <-> Content
  // ==========================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ pong: true });
    } else if (msg.action === 'doExtract') {
      startExtraction();
      sendResponse({ ok: true });
    } else if (msg.action === 'stopExtract') {
      stopExtraction();
      sendResponse({ ok: true });
    }
    return false;
  });

  // ==========================================================
  // Communication: Main World (Injected) -> Content
  // ==========================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.type?.startsWith(MSG_PREFIX)) return;

    const payload = event.data.payload;

    if (event.data.type === `${MSG_PREFIX}REQUEST_STARTED`) {
      chrome.runtime.sendMessage({ action: 'event', data: { type: 'request_started', ...payload } }).catch(() => {});
    }

    if (event.data.type === `${MSG_PREFIX}RESPONSE_RECEIVED`) {
      const eventData = { type: 'response_received', ...payload };
      if (payload.schema) eventData.type = 'json_parsed';
      chrome.runtime.sendMessage({ action: 'event', data: eventData }).catch(() => {});
    }

    if (event.data.type === `${MSG_PREFIX}REQUEST_ERROR`) {
      chrome.runtime.sendMessage({ action: 'event', data: { type: 'request_error', ...payload } }).catch(() => {});
    }

    // Legacy compatibility
    if (event.data.type === `${MSG_PREFIX}FETCH` || event.data.type === `${MSG_PREFIX}XHR`) {
      chrome.runtime.sendMessage({ action: 'apiData', data: payload }).catch(() => {});
    }
  });

  // ==========================================================
  // Extraction Lifecycle
  // ==========================================================
  function startExtraction() {
    if (isExtracting) return;
    isExtracting = true;
    dynamicNodes.length = 0;
    actionCounter = 0;

    const domData = scrapeDOM();
    chrome.runtime.sendMessage({ action: 'domData', data: domData }).catch(() => {});

    injectMainWorldScript();
    startMutationObserver();
    startTableObserver();
    startUIActionRecorder();
    patchSPARouting();
    detectNextJS();
    detectTurnstile();

    chrome.runtime.sendMessage({ action: 'event', data: { type: 'page_loaded', url: location.href, title: document.title, timestamp: Date.now() } }).catch(() => {});
  }

  // Auto-inject page hooks on load so we don't miss early fetch/XHR
  if (document.readyState === 'loading' || document.readyState === 'interactive') {
    injectMainWorldScript();
  }

  function stopExtraction() {
    isExtracting = false;
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    if (tableObserver) { tableObserver.disconnect(); tableObserver = null; }
    stopUIActionRecorder();

    chrome.runtime.sendMessage({
      action: 'domDataUpdate',
      data: { dynamicElements: [...dynamicNodes] }
    }).catch(() => {});

    chrome.runtime.sendMessage({ action: 'event', data: { type: 'export_ready', timestamp: Date.now() } }).catch(() => {});
  }

  // ==========================================================
  // Module 3: UI Action Recorder
  // ==========================================================
  const recordedActions = [];
  let uiListenersAttached = false;

  function recordAction(actionType, element, extra = {}) {
    if (!isExtracting) return;
    actionCounter++;
    currentCorrelationId = `action_${actionCounter}_${Date.now()}`;

    // Set correlation in page context
    try {
      const script = document.createElement('script');
      script.textContent = `window.__DEEP_SCRAPER_SET_CORRELATION__('${currentCorrelationId}')`;
      document.documentElement.appendChild(script);
      script.remove();
    } catch {}

    const action = {
      id: currentCorrelationId,
      type: actionType,
      timestamp: Date.now(),
      url: location.href,
      tag: element?.tagName?.toLowerCase() || '',
      id: element?.id || '',
      className: (typeof element?.className === 'string' ? element.className : '').substring(0, 200),
      text: (element?.textContent || '').substring(0, 200).trim(),
      href: element?.href || '',
      name: element?.name || '',
      value: element?.value ? String(element.value).substring(0, 200) : '',
      selector: getSelector(element),
      ...extra
    };

    recordedActions.push(action);
    chrome.runtime.sendMessage({ action: 'event', data: { type: 'user_action', ...action } }).catch(() => {});

    // Auto-clear correlation after observation window
    setTimeout(() => {
      if (currentCorrelationId === action.id) currentCorrelationId = null;
    }, 8000);
  }

  function getSelector(el) {
    if (!el || el === document || el === document.body) return '';
    const parts = [];
    let current = el;
    while (current && current !== document && parts.length < 5) {
      let part = current.tagName?.toLowerCase() || '';
      if (current.id) { part += `#${current.id}`; parts.unshift(part); break; }
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.split(/\s+/).filter(c => c && !c.startsWith('__')).slice(0, 2).join('.');
        if (cls) part += `.${cls}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function startUIActionRecorder() {
    if (uiListenersAttached) return;
    uiListenersAttached = true;

    document.addEventListener('click', (e) => {
      recordAction('click', e.target, {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        isLink: !!e.target.closest('a'),
        isButton: e.target.tagName === 'BUTTON' || e.target.closest('button') !== null,
        isPagination: isPaginationElement(e.target),
        isFilter: isFilterElement(e.target),
        isTableAction: isTableActionElement(e.target),
        isDetailLink: isDetailLinkElement(e.target)
      });
    }, true);

    document.addEventListener('input', (e) => {
      recordAction('input', e.target, { inputType: e.inputType, value: e.target.value?.substring(0, 200) });
    }, true);

    document.addEventListener('change', (e) => {
      recordAction('change', e.target, {
        value: e.target.value?.substring(0, 200),
        selectedOptions: e.target.selectedOptions ? Array.from(e.target.selectedOptions).map(o => o.value) : undefined
      });
    }, true);

    document.addEventListener('submit', (e) => {
      recordAction('submit', e.target, { action: e.target.action, method: e.target.method });
    }, true);
  }

  function stopUIActionRecorder() {
    // Can't easily remove capture-phase listeners, so we just stop recording
    uiListenersAttached = false;
  }

  // Heuristic element classifiers
  function isPaginationElement(el) {
    const text = (el.textContent || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    const parent = el.closest('[class*="paginat"], [class*="pager"], [class*="page-btn"], nav, [role="navigation"]');
    return /next|prev|page|›|»|‹|«|last|first|more/i.test(text) || parent !== null;
  }

  function isFilterElement(el) {
    const tag = el.tagName;
    const name = (el.name || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    const parent = el.closest('[class*="filter"], [class*="search"], form, [role="search"]');
    if (parent === null && !/search|filter|lpse|year|kategori|jenis/i.test(name + cls)) return false;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || el.closest('form') !== null;
  }

  function isTableActionElement(el) {
    return el.closest('table') !== null || el.closest('[class*="table"]') !== null;
  }

  function isDetailLinkElement(el) {
    const a = el.closest('a[href]');
    if (!a) return false;
    const href = a.href || '';
    const text = (a.textContent || '').toLowerCase();
    return /detail|view|lihat|buka|show/i.test(text) || /\/tender\/\d+|\/detail/i.test(href);
  }

  // ==========================================================
  // Module 4: Next.js Detector
  // ==========================================================
  function detectNextJS() {
    const profile = { detected: false, version: null, data: null, rsc: false, assets: [], buildId: null, routeType: null };

    // __NEXT_DATA__ script
    const nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      profile.detected = true;
      try {
        const nd = JSON.parse(nextDataEl.textContent);
        profile.data = {
          buildId: nd.buildId || null,
          page: nd.page || null,
          query: nd.query || null,
          props: nd.props ? { pageProps: Object.keys(nd.props?.pageProps || {}), __N_SSP: !!nd.props?.__N_SSP, __N_SSG: !!nd.props?.__N_SSG } : null
        };
        profile.buildId = nd.buildId;
        profile.routeType = nd.props?.__N_SSP ? 'SSR' : nd.props?.__N_SSG ? 'SSG' : 'CSR';
      } catch {}
    }

    // #__next element
    if (document.getElementById('__next')) profile.detected = true;

    // _next/static/ assets
    const nextAssets = [];
    document.querySelectorAll('script[src*="/_next/"], link[href*="/_next/"]').forEach(el => {
      const src = el.src || el.href;
      if (src) {
        const match = src.match(/\/_next\/static\/([^/]+)/);
        if (match && !nextAssets.includes(match[1])) nextAssets.push(match[1]);
      }
    });
    if (nextAssets.length) {
      profile.detected = true;
      profile.assets = nextAssets;
    }

    // RSC (React Server Components) detection
    if (document.querySelector('[data-rsc]') || document.documentElement.innerHTML.includes('RSC_PAYLOAD')) {
      profile.detected = true;
      profile.rsc = true;
    }

    // Check for Next.js router patterns
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    if (scripts.some(s => s.includes('_next/static/chunks') && (s.includes('webpack') || s.includes('main-app')))) {
      profile.detected = true;
    }

    chrome.runtime.sendMessage({ action: 'event', data: { type: 'nextjs_detected', ...profile, timestamp: Date.now() } }).catch(() => {});
    return profile;
  }

  // ==========================================================
  // Module 5: Turnstile Detector
  // ==========================================================
  function detectTurnstile() {
    const status = {
      detected: false,
      widgetLoaded: false,
      tokenFieldFound: false,
      iframeFound: false,
      iframeSrc: null,
      challengeStatus: 'unknown',
      observations: []
    };

    // Check for Turnstile iframe
    const turnstileIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
    if (turnstileIframes.length) {
      status.detected = true;
      status.iframeFound = true;
      status.iframeSrc = turnstileIframes[0].src || null;
      status.widgetLoaded = true;
      status.observations.push('Turnstile iframe detected in DOM');
    }

    // Check for Turnstile script
    const turnstileScript = document.querySelector('script[src*="challenges.cloudflare.com"]');
    if (turnstileScript) {
      status.detected = true;
      status.observations.push('Turnstile challenge script loaded');
    }

    // Check for Turnstile widget container
    const widgetContainer = document.querySelector('[class*="cf-turnstile"], #cf-turnstile, .cf-turnstile');
    if (widgetContainer) {
      status.detected = true;
      status.widgetLoaded = true;
      status.observations.push('Turnstile widget container found');
    }

    // Check for Turnstile token hidden field
    const tokenFields = document.querySelectorAll('input[name*="cf-turnstile"], input[name*="turnstile"], input[name*="cf_turnstile"], [data-turnstile-response]');
    if (tokenFields.length) {
      status.tokenFieldFound = true;
      status.observations.push(`Turnstile token field found (${tokenFields.length} field(s))`);
    }

    // Check for Cloudflare headers (via meta or script content)
    const html = document.documentElement.innerHTML.substring(0, 50000);
    if (html.includes('cf-chl-bypass') || html.includes('cf_turnstile') || html.includes('__cf_bm')) {
      status.detected = true;
      status.observations.push('Cloudflare challenge markers found in page source');
    }

    // Determine challenge status
    if (status.widgetLoaded && status.tokenFieldFound) {
      // Check if token has a value
      const tokenInput = document.querySelector('input[name*="cf-turnstile"], [data-turnstile-response]');
      if (tokenInput && tokenInput.value && tokenInput.value.length > 10) {
        status.challengeStatus = 'passed';
        status.observations.push('Turnstile token present (challenge likely passed)');
      } else {
        status.challengeStatus = 'pending';
        status.observations.push('Turnstile widget loaded but no token yet');
      }
    } else if (status.detected) {
      status.challengeStatus = 'background';
      status.observations.push('Turnstile detected but may be running in background/managed mode');
    }

    // Check for cf-mitigated / challenge page
    if (document.title.includes('Just a moment') || document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification')) {
      status.challengeStatus = 'active_challenge';
      status.observations.push('Active Cloudflare challenge page detected');
    }

    chrome.runtime.sendMessage({ action: 'event', data: { type: 'turnstile_detected', ...status, timestamp: Date.now() } }).catch(() => {});
    return status;
  }

  // ==========================================================
  // Enhanced Table Observer (Module 3 part 2)
  // ==========================================================
  let tableObserver = null;
  let lastTableRowCounts = new Map();

  function startTableObserver() {
    if (tableObserver) tableObserver.disconnect();
    tableObserver = new MutationObserver((mutations) => {
      if (!isExtracting) return;

      const tables = document.querySelectorAll('table');
      tables.forEach((table, idx) => {
        const rows = table.querySelectorAll('tbody tr, tr').length;
        const key = `table_${idx}`;
        const prev = lastTableRowCounts.get(key);

        if (prev !== undefined && prev !== rows) {
          chrome.runtime.sendMessage({
            action: 'event',
            data: {
              type: 'dom_table_changed',
              tableIndex: idx,
              previousRows: prev,
              currentRows: rows,
              rowDelta: rows - prev,
              correlationId: currentCorrelationId,
              timestamp: Date.now()
            }
          }).catch(() => {});
        }
        lastTableRowCounts.set(key, rows);
      });
    });
    tableObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  // ==========================================================
  // Injectors & Observers
  // ==========================================================
  function injectMainWorldScript() {
    if (document.querySelector('script[data-ds-injected]')) return;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected-page.js');
    script.dataset.dsInjected = '1';
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function startMutationObserver() {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(mutations => {
      if (!isExtracting) return;
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            dynamicNodes.push({
              tag: node.tagName?.toLowerCase() || '',
              text: (node.textContent || '').substring(0, 200).trim(),
              id: node.id || '',
              className: (typeof node.className === 'string' ? node.className : '').substring(0, 100),
              timestamp: Date.now(),
              correlationId: currentCorrelationId
            });
          }
        });
      });
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function patchSPARouting() {
    if (window._dsSpaPatched) return;
    window._dsSpaPatched = true;

    const notifyNav = (type) => {
      if (!isExtracting) return;
      chrome.runtime.sendMessage({
        action: 'event',
        data: { type: 'route_changed', url: location.href, method: type, timestamp: Date.now() }
      }).catch(() => {});
    };

    ['pushState', 'replaceState'].forEach(method => {
      const original = history[method];
      history[method] = function (...args) {
        original.apply(this, args);
        notifyNav(method);
      };
    });
    window.addEventListener('popstate', () => notifyNav('popstate'));
  }

  // ==========================================================
  // DOM Scraping Logic (Enhanced - kept from v1)
  // ==========================================================
  function scrapeDOM() {
    const getText = (el) => (el?.textContent || '').trim().substring(0, 500);

    return {
      url: location.href,
      title: document.title,

      headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(el => ({
        level: parseInt(el.tagName[1], 10),
        text: getText(el)
      })).filter(h => h.text),

      links: [...new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href))]
        .map(href => {
          const el = document.querySelector(`a[href="${href}"]`);
          return { href, text: getText(el) };
        }),

      images: Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.currentSrc || img.src || img.dataset?.src || '',
        alt: img.alt || '',
        width: img.naturalWidth || img.width || null,
        height: img.naturalHeight || img.height || null
      })),

      tables: Array.from(document.querySelectorAll('table')).map(table => {
        const headerRow = Array.from(table.querySelectorAll('thead th, thead td')).map(getText);
        const bodyRows = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
          Array.from(tr.querySelectorAll('th, td')).map(getText)
        ).filter(row => row.length > 0);
        const allRows = Array.from(table.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('th, td')).map(getText)
        ).filter(row => row.length > 0);
        return { headers: headerRow, body: bodyRows, all: allRows, rowCount: allRows.length };
      }).filter(t => t.all.length > 0),

      metaTags: Array.from(document.querySelectorAll('meta')).map(m => ({
        name: m.name || m.getAttribute('property') || m.httpEquiv || '',
        content: m.content || ''
      })).filter(m => m.name && m.content),

      jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => {
        try { return JSON.parse(s.textContent); } catch { return null; }
      }).filter(Boolean),

      forms: Array.from(document.querySelectorAll('form')).map(form => ({
        action: form.action || '',
        method: (form.method || 'GET').toUpperCase(),
        fields: Array.from(form.querySelectorAll('input, select, textarea')).map(f => ({
          tag: f.tagName.toLowerCase(),
          type: f.type || '',
          name: f.name || '',
          placeholder: f.placeholder || '',
          id: f.id || '',
          required: f.required || false,
          pattern: f.pattern || '',
          min: f.min || '',
          max: f.max || '',
          step: f.step || ''
        }))
      })),

      cssColors: sampleColors(),
      dynamicElements: [],
      visibleText: (document.body?.innerText || '').substring(0, 200000),

      overview: {
        url: location.href, title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        language: document.documentElement.lang || '',
        charset: document.characterSet || '',
        referrer: document.referrer || '',
        protocol: location.protocol, host: location.host,
        hostname: location.hostname, pathname: location.pathname,
        search: location.search, hash: location.hash,
        lastModified: document.lastModified || '',
        viewport: document.querySelector('meta[name="viewport"]')?.content || '',
        canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || '',
        favicon: document.querySelector('link[rel*="icon"]')?.href || '',
        generator: document.querySelector('meta[name="generator"]')?.content || '',
        themeColor: document.querySelector('meta[name="theme-color"]')?.content || '',
        manifest: document.querySelector('link[rel="manifest"]')?.href || '',
        rssFeed: document.querySelector('link[type="application/rss+xml"]')?.href || '',
        atomFeed: document.querySelector('link[type="application/atom+xml"]')?.href || '',
        pageType: detectPageType(),
        doctype: document.doctype?.name || 'none',
      },

      seo: {
        metaRobots: document.querySelector('meta[name="robots"]')?.content || '',
        metaDescription: document.querySelector('meta[name="description"]')?.content || '',
        metaKeywords: document.querySelector('meta[name="keywords"]')?.content || '',
        metaAuthor: document.querySelector('meta[name="author"]')?.content || '',
        openGraph: extractOpenGraph(),
        twitterCard: extractTwitterCard(),
        hreflang: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map(l => ({
          lang: l.getAttribute('hreflang'), href: l.href
        })),
      },

      css: {
        colors: sampleColorsEnhanced(), fonts: extractFonts(),
        frameworks: detectCSSFrameworks(), variables: extractCSSVariables(),
        animations: detectAnimations(), layoutPatterns: detectLayoutPatterns(),
        mediaQueries: extractMediaQueries(), importedFonts: extractImportedFonts(),
      },

      tech: {
        jsFrameworks: detectJSFrameworks(),
        thirdParty: detectThirdPartyServices(),
        stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => ({
          href: l.href, media: l.media || 'all', crossorigin: l.crossOrigin || ''
        })),
        scripts: Array.from(document.querySelectorAll('script[src]')).map(s => ({
          src: s.src, type: s.type || '', async: s.async || false,
          defer: s.defer || false, module: s.type === 'module' || false,
          crossorigin: s.crossOrigin || '', integrity: s.integrity || ''
        })),
        inlineScripts: Array.from(document.querySelectorAll('script:not([src])')).map(s =>
          s.textContent.substring(0, 500)
        ).filter(Boolean),
      },

      performance: {
        totalDOMNodes: document.querySelectorAll('*').length,
        scriptsCount: document.querySelectorAll('script').length,
        inlineScripts: document.querySelectorAll('script:not([src])').length,
        stylesheetsCount: document.querySelectorAll('link[rel="stylesheet"]').length,
        inlineStyles: document.querySelectorAll('style').length,
        imagesCount: document.querySelectorAll('img').length,
        lazyLoadedImages: document.querySelectorAll('img[loading="lazy"]').length,
        iframesCount: document.querySelectorAll('iframe').length,
        videosCount: document.querySelectorAll('video').length,
        audioCount: document.querySelectorAll('audio').length,
        canvasCount: document.querySelectorAll('canvas').length,
        svgCount: document.querySelectorAll('svg').length,
        preloads: document.querySelectorAll('link[rel="preload"]').length,
        prefetches: document.querySelectorAll('link[rel="prefetch"]').length,
        preconnects: Array.from(document.querySelectorAll('link[rel="preconnect"]')).map(l => l.href),
        dnsPrefetch: Array.from(document.querySelectorAll('link[rel="dns-prefetch"]')).map(l => l.href),
      },

      semantics: {
        landmarks: extractLandmarks(),
        headingOutline: extractHeadingOutline(),
        ariaRoles: extractARIARoles(),
      },

      linksAnalysis: {
        internal: [], external: [],
        anchors: Array.from(document.querySelectorAll('a[name], a[id]')).map(a => ({
          name: a.name || a.id || '', href: a.href || ''
        })).filter(l => l.name),
        externalDomains: [],
      },
    };
  }

  // ==========================================================
  // Helper: Page Type Detection
  // ==========================================================
  function detectPageType() {
    const html = document.documentElement.outerHTML.substring(0, 30000).toLowerCase();
    const path = location.pathname.toLowerCase();

    if (html.includes('application/ld+json') && html.includes('"@type"')) {
      try {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          const data = JSON.parse(s.textContent);
          const type = data['@type'];
          if (type === 'Article' || type === 'NewsArticle' || type === 'BlogPosting') return 'Article / Blog Post';
          if (type === 'Product') return 'Product Page';
          if (type === 'FAQPage') return 'FAQ Page';
          if (type === 'VideoObject') return 'Video Page';
          if (type === 'Recipe') return 'Recipe Page';
          if (type === 'Event') return 'Event Page';
          if (type === 'JobPosting') return 'Job Listing';
          if (type === 'LocalBusiness') return 'Local Business Page';
          if (type === 'Person') return 'Profile Page';
          if (type === 'WebApplication') return 'Web Application';
          if (type === 'ItemList') return 'List / Collection Page';
          if (type === 'BreadcrumbList') return 'Breadcrumb Page';
        }
      } catch {}
    }

    if (document.querySelector('article')) return 'Article / Content Page';
    if (path.includes('/product') || path.includes('/item') || path.includes('/shop/') || path.includes('/p/')) return 'Product Page';
    if (path.includes('/blog') || path.includes('/post') || path.includes('/article') || path.includes('/news')) return 'Blog / Article';
    if (path.includes('/search') || path.includes('/results') || path.includes('/q=') || path.includes('?s=')) return 'Search Results Page';
    if (path.includes('/cart') || path.includes('/checkout') || path.includes('/basket')) return 'E-commerce / Checkout';
    if (path.includes('/login') || path.includes('/signin') || path.includes('/auth/signin')) return 'Login Page';
    if (path.includes('/register') || path.includes('/signup') || path.includes('/join')) return 'Registration Page';
    if (path.includes('/contact') || path.includes('/support') || path.includes('/help')) return 'Contact / Support Page';
    if (path.includes('/about') || path.includes('/team') || path.includes('/company')) return 'About / Company Page';
    if (path.includes('/pricing') || path.includes('/plans')) return 'Pricing Page';
    if (path.includes('/docs') || path.includes('/documentation') || path.includes('/api-docs')) return 'Documentation Page';
    if (path.includes('/dashboard') || path.includes('/admin') || path.includes('/panel')) return 'Dashboard / Admin';
    if (path.includes('/profile') || path.includes('/account') || path.includes('/settings')) return 'User Profile / Settings';
    if (path.includes('/forum') || path.includes('/community')) return 'Forum / Community';
    if (path.includes('/gallery') || path.includes('/portfolio')) return 'Gallery / Portfolio';
    if (path.includes('/video') || path.includes('/watch')) return 'Video Page';
    if (path === '/' || path === '' || path === '/index.html') return 'Homepage';
    if (path.includes('/tender')) return 'Tender / Procurement Page';
    if (document.querySelector('form[action*="login"], form[action*="signin"]')) return 'Login Page';
    if (document.querySelector('.pricing-table, .plan-card, [class*="pricing"]')) return 'Pricing Page';

    return 'Web Page';
  }

  // ==========================================================
  // Helpers (kept from v1, abbreviated for space)
  // ==========================================================
  function extractOpenGraph() {
    const og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => { og[m.getAttribute('property')] = m.content || ''; });
    return og;
  }

  function extractTwitterCard() {
    const tc = {};
    document.querySelectorAll('meta[name^="twitter:"]').forEach(m => { tc[m.name] = m.content || ''; });
    return tc;
  }

  function sampleColors() {
    const colors = new Set();
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 600)) {
      try {
        const cs = window.getComputedStyle(el);
        ['color', 'backgroundColor', 'borderColor'].forEach(prop => {
          if (cs[prop] && cs[prop] !== 'rgba(0, 0, 0, 0)') colors.add(cs[prop]);
        });
      } catch {}
    }
    return [...colors].slice(0, 200);
  }

  function sampleColorsEnhanced() {
    const colorMap = {};
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 600)) {
      try {
        const cs = window.getComputedStyle(el);
        ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor'].forEach(prop => {
          const val = cs[prop];
          if (val && val !== 'rgba(0, 0, 0, 0)' && val !== 'transparent' && val !== 'currentColor') {
            colorMap[val] = (colorMap[val] || 0) + 1;
          }
        });
      } catch {}
    }
    return Object.entries(colorMap).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([color, usage]) => ({ color, usage }));
  }

  function extractFonts() {
    const fontMap = {};
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 400)) {
      try {
        const cs = window.getComputedStyle(el);
        const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.fontStyle}`;
        if (cs.fontFamily) fontMap[key] = (fontMap[key] || 0) + 1;
      } catch {}
    }
    return Object.entries(fontMap).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([font, usage]) => {
      const parts = font.split('|');
      return { family: (parts[0] || '').trim(), size: (parts[1] || '').trim(), weight: (parts[2] || '').trim(), style: (parts[3] || '').trim(), usage };
    });
  }

  function extractImportedFonts() {
    const fonts = [];
    document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      if (link.href && link.href.includes('fonts.googleapis.com')) {
        const params = new URL(link.href).searchParams;
        (params.get('family') || '').split('|').forEach(f => {
          fonts.push({ source: 'Google Fonts', name: f.split(':')[0].replace(/\+/g, ' '), weights: (f.split(':')[1] || '').split(',').filter(Boolean) });
        });
      }
    });
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSFontFaceRule) {
            fonts.push({
              source: '@font-face', name: rule.style.getPropertyValue('font-family')?.replace(/['"]/g, '') || '',
              weights: rule.style.getPropertyValue('font-weight') ? [rule.style.getPropertyValue('font-weight')] : [],
              src: (rule.style.getPropertyValue('src') || '').substring(0, 200)
            });
          }
        }
      } catch {}
    }
    return fonts;
  }

  function detectCSSFrameworks() {
    const detected = [];
    const html = document.documentElement.outerHTML.substring(0, 50000);
    const sheetHrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.href.toLowerCase());
    const twHits = ['flex-col', 'items-center', 'justify-between', 'bg-gray', 'text-sm', 'px-', 'py-', 'rounded-', 'shadow-'];
    if (twHits.filter(p => html.includes(p)).length >= 3 || sheetHrefs.some(s => s.includes('tailwind'))) detected.push('Tailwind CSS');
    if (sheetHrefs.some(s => s.includes('bootstrap')) || document.querySelector('.container-fluid, .navbar-expand')) detected.push('Bootstrap');
    if (sheetHrefs.some(s => s.includes('bulma'))) detected.push('Bulma');
    if (html.includes('ant-') || sheetHrefs.some(s => s.includes('ant-design'))) detected.push('Ant Design');
    return [...new Set(detected)];
  }

  function extractCSSVariables() {
    const vars = {};
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === ':root' || rule.selectorText === 'html' || rule.selectorText?.includes(':root')) {
              for (let i = 0; i < rule.style.length; i++) {
                const name = rule.style[i];
                if (name.startsWith('--')) vars[name] = rule.style.getPropertyValue(name).trim();
              }
            }
          }
        } catch {}
      }
    } catch {}
    return vars;
  }

  function detectAnimations() {
    const animations = new Set();
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 200)) {
      try { const cs = window.getComputedStyle(el); if (cs.animationName && cs.animationName !== 'none') animations.add(cs.animationName); } catch {}
    }
    try {
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) { if (rule.type === CSSRule.KEYFRAMES_RULE) animations.add(rule.name); } } catch {}
      }
    } catch {}
    return [...animations].slice(0, 100);
  }

  function detectLayoutPatterns() {
    let flexCount = 0, gridCount = 0, fixedCount = 0, absoluteCount = 0, stickyCount = 0;
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 300)) {
      try {
        const cs = window.getComputedStyle(el);
        if (cs.display?.includes('flex')) flexCount++;
        if (cs.display?.includes('grid')) gridCount++;
        if (cs.position === 'fixed') fixedCount++;
        if (cs.position === 'absolute') absoluteCount++;
        if (cs.position === 'sticky') stickyCount++;
      } catch {}
    }
    return { flexbox: flexCount, grid: gridCount, fixed: fixedCount, absolute: absoluteCount, sticky: stickyCount,
      primary: flexCount > gridCount ? 'flexbox' : gridCount > flexCount ? 'grid' : 'block/flow' };
  }

  function extractMediaQueries() {
    const queries = new Set();
    try {
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) { if (rule.type === CSSRule.MEDIA_RULE) queries.add(rule.conditionText || rule.media?.mediaText || ''); } } catch {}
      }
    } catch {}
    return [...queries].filter(Boolean).slice(0, 30);
  }

  function detectJSFrameworks() {
    const detected = [];
    const html = document.documentElement.outerHTML.substring(0, 50000);
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src.toLowerCase());

    if (document.getElementById('__NEXT_DATA__') || document.querySelector('[id^="__next"]'))
      detected.push({ name: 'Next.js', confidence: 'high', evidence: '__NEXT_DATA__ script or #__next element' });
    if (document.querySelector('[data-reactroot]') || document.querySelector('[data-reactid]'))
      detected.push({ name: 'React', confidence: 'high', evidence: 'data-reactroot / data-reactid attribute' });
    if (document.getElementById('___gatsby') || html.includes('___gatsby'))
      detected.push({ name: 'Gatsby', confidence: 'high', evidence: '___gatsby element' });
    if (document.querySelector('[data-server-rendered]') || document.querySelector('[data-v-]'))
      detected.push({ name: 'Vue.js', confidence: 'high', evidence: 'Vue SSR / scoped style attribute' });
    if (document.getElementById('__NUXT_DATA__') || document.querySelector('[id^="__nuxt"]'))
      detected.push({ name: 'Nuxt.js', confidence: 'high', evidence: '__NUXT_DATA__ or #__nuxt element' });
    if (document.querySelector('[ng-version]') || document.querySelector('[ng-app]'))
      detected.push({ name: 'Angular', confidence: 'high', evidence: `ng-version="${document.querySelector('[ng-version]')?.getAttribute('ng-version') || ''}"` });
    if (document.querySelector('[class*="svelte-"]'))
      detected.push({ name: 'Svelte', confidence: 'high', evidence: 'svelte- class prefix' });
    if (document.querySelector('[x-data]') || document.querySelector('[x-init]'))
      detected.push({ name: 'Alpine.js', confidence: 'high', evidence: 'x-data / x-init attribute' });
    if (document.querySelector('[hx-get]') || document.querySelector('[hx-post]'))
      detected.push({ name: 'htmx', confidence: 'high', evidence: 'hx-* attributes' });
    if (scripts.some(s => s.includes('jquery'))) detected.push({ name: 'jQuery', confidence: 'high', evidence: 'Script source' });
    if (scripts.some(s => s.includes('axios'))) detected.push({ name: 'Axios', confidence: 'high', evidence: 'Script source' });
    if (scripts.some(s => s.includes('d3.js') || s.includes('d3.min'))) detected.push({ name: 'D3.js', confidence: 'high', evidence: 'Script source' });
    if (scripts.some(s => s.includes('socket.io'))) detected.push({ name: 'Socket.IO', confidence: 'high', evidence: 'Script source' });

    if (html.includes('wp-content') || document.querySelector('meta[name="generator"][content*="WordPress"]'))
      detected.push({ name: 'WordPress', confidence: 'high', evidence: 'wp-content paths' });
    if (document.querySelector('meta[name="generator"][content*="Wix"]'))
      detected.push({ name: 'Wix', confidence: 'high', evidence: 'Generator meta tag' });
    if (document.querySelector('meta[name="generator"][content*="Webflow"]'))
      detected.push({ name: 'Webflow', confidence: 'high', evidence: 'Generator meta tag' });

    return detected;
  }

  function detectThirdPartyServices() {
    const services = [];
    const html = document.documentElement.outerHTML.substring(0, 60000);
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    const allUrls = scripts.join(' ') + ' ' + html;

    const checks = [
      { name: 'Google Analytics', category: 'Analytics', patterns: ['google-analytics.com', 'gtag(', 'googletagmanager.com'] },
      { name: 'Google Tag Manager', category: 'Analytics', patterns: ['googletagmanager.com/gtm.js'] },
      { name: 'Facebook Pixel', category: 'Analytics', patterns: ['connect.facebook.net', 'fbevents.js'] },
      { name: 'Hotjar', category: 'Analytics', patterns: ['hotjar.com', 'static.hotjar.com'] },
      { name: 'PostHog', category: 'Analytics', patterns: ['posthog.com', 'cdn.pgh.io'] },
      { name: 'Sentry', category: 'Monitoring', patterns: ['sentry.io', 'browser.sentry-cdn'] },
      { name: 'Datadog', category: 'Monitoring', patterns: ['datadoghq.com'] },
      { name: 'reCAPTCHA', category: 'Security', patterns: ['recaptcha', 'recaptcha.net'] },
      { name: 'hCaptcha', category: 'Security', patterns: ['hcaptcha.com'] },
      { name: 'Cloudflare Turnstile', category: 'Security', patterns: ['challenges.cloudflare.com'] },
      { name: 'Cloudflare CDN', category: 'CDN', patterns: ['cdnjs.cloudflare.com'] },
      { name: 'Stripe', category: 'Payment', patterns: ['stripe.com', 'js.stripe.com'] },
      { name: 'PayPal', category: 'Payment', patterns: ['paypal.com'] },
      { name: 'Auth0', category: 'Authentication', patterns: ['auth0.com', 'cdn.auth0.com'] },
      { name: 'Firebase', category: 'Backend', patterns: ['firebaseapp.com', 'firebase.google.com'] },
      { name: 'Intercom', category: 'Support', patterns: ['intercom.io', 'intercomcdn.com'] },
      { name: 'Algolia', category: 'Search', patterns: ['algolia.net', 'algoliasearch'] },
      { name: 'Google Maps', category: 'Maps', patterns: ['maps.googleapis.com'] },
    ];

    for (const check of checks) {
      if (check.patterns.some(p => allUrls.toLowerCase().includes(p.toLowerCase()))) {
        services.push({ name: check.name, category: check.category });
      }
    }
    return [...new Map(services.map(s => [s.name, s])).values()];
  }

  function extractLandmarks() {
    const landmarks = [];
    const checks = [
      { selector: 'header', role: 'banner' }, { selector: 'nav', role: 'navigation' },
      { selector: 'main', role: 'main' }, { selector: 'footer', role: 'contentinfo' },
      { selector: 'aside', role: 'complementary' }, { selector: 'section', role: 'section' },
      { selector: 'article', role: 'article' }, { selector: '[role="search"]', role: 'search' },
    ];
    for (const { selector, role } of checks) {
      document.querySelectorAll(selector).forEach(el => {
        landmarks.push({ role, tag: el.tagName.toLowerCase(), label: el.getAttribute('aria-label') || el.id || '', hidden: el.hidden });
      });
    }
    const grouped = {};
    for (const l of landmarks) {
      if (!grouped[l.role]) grouped[l.role] = { role: l.role, tags: new Set(), labels: [], count: 0, visible: 0 };
      grouped[l.role].tags.add(l.tag);
      if (l.label) grouped[l.role].labels.push(l.label);
      grouped[l.role].count++;
      if (!l.hidden) grouped[l.role].visible++;
    }
    return Object.values(grouped).map(g => ({ role: g.role, tags: [...g.tags], labels: g.labels.slice(0, 5), count: g.count, visible: g.visible }));
  }

  function extractHeadingOutline() {
    return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map(el => ({ level: parseInt(el.tagName[1], 10), text: (el.textContent || '').trim().substring(0, 200), id: el.id || '' }))
      .filter(h => h.text);
  }

  function extractARIARoles() {
    const roles = new Map();
    document.querySelectorAll('[role]').forEach(el => { const r = el.getAttribute('role'); roles.set(r, (roles.get(r) || 0) + 1); });
    return [...roles.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count);
  }

})();
