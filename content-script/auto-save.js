// Auto-save summary: watches chrome.storage for new summary data and triggers download via background
(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;

  let lastSavedKey = null;

  // Poll chrome.storage.local for new summary results written by the extension
  function checkStorage() {
    chrome.storage.local.get(null, function (items) {
      if (chrome.runtime.lastError) return;

      // Find the most recent summary key — the extension stores summaries
      // under keys like conversation IDs or page URLs
      let latestKey = null;
      let latestVal = null;
      let latestTime = 0;

      for (let key of Object.keys(items)) {
        let val = items[key];
        // Look for objects that have a summary/result field
        if (val && typeof val === 'object') {
          let summaryText = val.summary || val.result || val.content || val.text || val.answer;
          if (summaryText && typeof summaryText === 'string' && summaryText.length > 80) {
            let time = val.timestamp || val.updatedAt || val.createdAt || 0;
            if (typeof time === 'string') time = new Date(time).getTime() || 0;
            if (time >= latestTime) {
              latestTime = time;
              latestKey = key;
              latestVal = summaryText;
            }
          }
        }
        // Also handle plain string values stored directly
        if (typeof val === 'string' && val.length > 80 && key !== lastSavedKey) {
          latestKey = key;
          latestVal = val;
        }
      }

      if (latestKey && latestKey !== lastSavedKey && latestVal) {
        lastSavedKey = latestKey;
        triggerDownload(latestVal);
      }
    });
  }

  function triggerDownload(text) {
    chrome.runtime.sendMessage(
      { type: 'SUMMARY_AUTO_DOWNLOAD', text: text },
      function (response) {
        if (chrome.runtime.lastError) {
          // Background not ready, retry once
          setTimeout(() => chrome.runtime.sendMessage({ type: 'SUMMARY_AUTO_DOWNLOAD', text }), 2000);
        }
      }
    );
  }

  // Also watch for DOM changes directly on the page — the extension
  // injects the summary panel into the page DOM
  let domDebounce = null;
  let lastDomText = null;

  function checkDom() {
    // The extension renders its panel as a shadow host or a fixed overlay
    // Try to grab text from the rendered summary panel
    const candidates = [
      document.querySelector('[data-testid="summary-result"]'),
      document.querySelector('[class*="summaryContent"]'),
      document.querySelector('[class*="summary-content"]'),
      document.querySelector('[class*="resultText"]'),
      document.querySelector('[class*="SummaryPanel"]'),
      document.querySelector('#chatgpt-summarize-result'),
      document.querySelector('#summarize-result'),
    ];

    let text = null;
    for (let el of candidates) {
      if (el && el.innerText && el.innerText.trim().length > 80) {
        text = el.innerText.trim();
        break;
      }
    }

    // Fallback: find the largest text block in any shadow root on the page
    if (!text) {
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          el.shadowRoot.querySelectorAll('*').forEach(child => {
            if (child.childElementCount === 0) {
              let t = (child.innerText || '').trim();
              if (t.length > 200 && (!text || t.length > text.length)) text = t;
            }
          });
        }
      });
    }

    if (text && text !== lastDomText) {
      lastDomText = text;
      triggerDownload(text);
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(domDebounce);
    domDebounce = setTimeout(checkDom, 1500);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also poll storage every 3 seconds as a reliable fallback
  setInterval(checkStorage, 3000);

  // Run once on load
  setTimeout(checkStorage, 2000);
  setTimeout(checkDom, 2000);
})();
