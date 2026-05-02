// Auto-save summary to disk as a .txt file when summary content appears
(function () {
  let lastSavedText = null;

  function getSummaryText() {
    // The summary panel renders inside #app — grab all visible text from the summary output area
    const selectors = [
      '[class*="summary"]',
      '[class*="result"]',
      '[class*="output"]',
      '[class*="content"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 80) {
        return el.innerText.trim();
      }
    }
    // Fallback: grab the largest text block inside #app
    const app = document.getElementById('app');
    if (!app) return null;
    let best = null;
    let bestLen = 80;
    app.querySelectorAll('*').forEach(el => {
      const t = el.childElementCount === 0 ? (el.innerText || '').trim() : '';
      if (t.length > bestLen) { best = t; bestLen = t.length; }
    });
    return best;
  }

  function downloadText(text) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `summary-${timestamp}.txt`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    // Use chrome.downloads API (requires "downloads" permission)
    if (typeof chrome !== 'undefined' && chrome.downloads) {
      chrome.downloads.download({ url, filename, saveAs: false }, () => {
        URL.revokeObjectURL(url);
      });
    } else {
      // Fallback: anchor click
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Also save to chrome.storage for history
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['summaryHistory'], (res) => {
        const history = res.summaryHistory || [];
        history.unshift({ timestamp, text, url: location.href });
        // Keep last 50 entries
        if (history.length > 50) history.length = 50;
        chrome.storage.local.set({ summaryHistory: history });
      });
    }
  }

  function checkAndSave() {
    const text = getSummaryText();
    if (text && text !== lastSavedText) {
      lastSavedText = text;
      downloadText(text);
    }
  }

  // Watch for DOM changes in #app — fires when summary finishes rendering
  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(checkAndSave, 1200);
  });

  function startObserving() {
    const app = document.getElementById('app');
    if (app) {
      observer.observe(app, { childList: true, subtree: true, characterData: true });
    } else {
      setTimeout(startObserving, 300);
    }
  }

  startObserving();
})();
