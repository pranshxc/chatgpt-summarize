(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;

  // Keys/patterns that are definitely NOT summary content
  const SKIP_PATTERNS = [
    /^#/, // CSS selectors
    /\{\s*display\s*:/, // CSS rules
    /background-color/, // CSS
    /border-radius/, // CSS
    /^_summary/, // our own history key prefix
    /^settings/, // settings objects
    /^config/, // config objects
    /^theme/, // theme data
  ];

  // A summary result must look like natural language prose/bullets
  function looksLikeSummary(text) {
    if (typeof text !== 'string') return false;
    if (text.length < 100) return false;
    // Skip anything that looks like CSS or code
    if (SKIP_PATTERNS.some(p => p.test(text.slice(0, 120)))) return false;
    // Must have spaces between words (not minified code/CSS)
    const wordRatio = (text.match(/[a-zA-Z]{3,}/g) || []).length / (text.length / 10);
    if (wordRatio < 0.5) return false;
    // Should not be mostly special characters
    const specialRatio = (text.match(/[{}\[\]();:<>]/g) || []).length / text.length;
    if (specialRatio > 0.08) return false;
    return true;
  }

  // ── STORAGE WATCHER ──────────────────────────────────────────────────────────
  let lastStorageKey = null;

  function checkStorage() {
    chrome.storage.local.get(null, function (items) {
      if (chrome.runtime.lastError) return;

      // Look for keys that store summary objects: { result, summary, content, answer, text }
      // and have a recent-ish timestamp
      let best = null;
      let bestTime = 0;

      for (let key of Object.keys(items)) {
        // Skip our own meta keys
        if (key === '_summaryHistory') continue;

        const val = items[key];

        // Case 1: object with a known summary field
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (let field of ['summary', 'result', 'content', 'answer', 'text', 'output']) {
            const candidate = val[field];
            if (looksLikeSummary(candidate)) {
              const t = val.timestamp || val.updatedAt || val.createdAt || 0;
              const ts = typeof t === 'string' ? new Date(t).getTime() || 1 : (t || 1);
              if (ts >= bestTime) {
                bestTime = ts;
                best = { key: key + '::' + field, text: candidate };
              }
            }
          }
        }

        // Case 2: plain string value
        if (looksLikeSummary(val)) {
          if (1 >= bestTime) {
            bestTime = 1;
            best = { key, text: val };
          }
        }
      }

      if (best && best.key !== lastStorageKey) {
        lastStorageKey = best.key;
        triggerDownload(best.text, 'storage');
      }
    });
  }

  // ── DOM WATCHER ──────────────────────────────────────────────────────────────
  // The extension renders a panel. We watch for it to *stop changing* (stream done).
  let domSettleTimer = null;
  let lastDomText = null;
  let streamingCheckTimer = null;

  // Selectors used by the ChatGPT Summarize extension panel
  const PANEL_SELECTORS = [
    '[data-testid="summary-result"]',
    '[class*="summaryContent"]',
    '[class*="summary-content"]',
    '[class*="SummaryPanel"]',
    '[class*="resultText"]',
    '[class*="summary_content"]',
    '[id*="summarize-result"]',
    '[id*="summary-result"]',
    // The extension appends a fixed overlay with a specific structure
    'div[class*="Panel"] p',
    'div[class*="panel"] li',
  ];

  function getPanelText() {
    // Try direct selectors first
    for (let sel of PANEL_SELECTORS) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          let combined = Array.from(els).map(e => e.innerText || '').join('\n').trim();
          if (looksLikeSummary(combined)) return combined;
        }
      } catch (e) {}
    }

    // Fallback: scan shadow roots
    let best = '';
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('*').forEach(child => {
          if (child.childElementCount === 0) {
            const t = (child.innerText || '').trim();
            if (t.length > best.length) best = t;
          }
        });
      }
    });
    if (looksLikeSummary(best)) return best;

    // Last resort: look for the largest visible text block in the top-right quadrant
    // (where the extension panel renders)
    let largest = '';
    document.querySelectorAll('div, section, article').forEach(el => {
      try {
        const rect = el.getBoundingClientRect();
        // Panel is typically in the right half of the viewport
        if (rect.left < window.innerWidth * 0.5) return;
        if (rect.width < 200 || rect.height < 100) return;
        const t = (el.innerText || '').trim();
        if (t.length > largest.length && looksLikeSummary(t)) largest = t;
      } catch (e) {}
    });
    return largest || null;
  }

  // Detect whether streaming is still in progress
  // The extension shows a spinner/cursor while streaming
  function isStreaming() {
    const streamingIndicators = [
      document.querySelector('[class*="streaming"]'),
      document.querySelector('[class*="Streaming"]'),
      document.querySelector('[class*="loading"]'),
      document.querySelector('[class*="Loading"]'),
      document.querySelector('[class*="spinner"]'),
      document.querySelector('[class*="Spinner"]'),
      document.querySelector('[class*="cursor"]'),
      document.querySelector('[class*="typingIndicator"]'),
      document.querySelector('span[class*="blink"]'),
    ];
    return streamingIndicators.some(Boolean);
  }

  function tryCaptureDom() {
    if (isStreaming()) {
      // Still streaming — check again in 1s
      clearTimeout(streamingCheckTimer);
      streamingCheckTimer = setTimeout(tryCaptureDom, 1000);
      return;
    }

    const text = getPanelText();
    if (text && text !== lastDomText && looksLikeSummary(text)) {
      lastDomText = text;
      triggerDownload(text, 'dom');
    }
  }

  // MutationObserver: debounce 2.5s after last DOM change, then check
  const observer = new MutationObserver(() => {
    clearTimeout(domSettleTimer);
    // Wait 2.5 seconds of no DOM changes = streaming likely done
    domSettleTimer = setTimeout(tryCaptureDom, 2500);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ── DOWNLOAD TRIGGER ────────────────────────────────────────────────────────
  let lastDownloadedText = null;

  function triggerDownload(text, source) {
    if (!text || text === lastDownloadedText) return;
    if (!looksLikeSummary(text)) return;
    lastDownloadedText = text;

    chrome.runtime.sendMessage(
      { type: 'SUMMARY_AUTO_DOWNLOAD', text: text },
      function (response) {
        if (chrome.runtime.lastError) {
          setTimeout(() => triggerDownload(text, source + '_retry'), 3000);
        }
      }
    );
  }

  // Poll storage every 4 seconds as reliable fallback
  setInterval(checkStorage, 4000);
  setTimeout(checkStorage, 3000);

})();
