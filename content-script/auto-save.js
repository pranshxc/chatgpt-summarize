(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;

  // ── STEP 1: Intercept navigator.clipboard.writeText ──────────────────────────
  // The extension's copy button calls navigator.clipboard.writeText(summaryText).
  // We wrap that function so every clipboard write is also sent for download.
  // This is the most reliable method — we get the exact text the copy button copies.

  const _originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);

  navigator.clipboard.writeText = function (text) {
    // Fire the original so copy still works normally
    const result = _originalWriteText(text);
    // Only download if it looks like a real summary (not a URL, short string, etc.)
    if (text && text.length > 100 && looksLikeSummary(text)) {
      triggerDownload(text);
    }
    return result;
  };

  // ── STEP 2: Also intercept document.execCommand('copy') for older fallbacks ──
  const _origExecCommand = document.execCommand.bind(document);
  document.execCommand = function (cmd, ...args) {
    if (cmd === 'copy') {
      // Give the browser a tick to populate the clipboard, then read it
      setTimeout(() => {
        navigator.clipboard.readText && navigator.clipboard.readText().then(text => {
          if (text && text.length > 100 && looksLikeSummary(text)) {
            triggerDownload(text);
          }
        }).catch(() => {});
      }, 100);
    }
    return _origExecCommand(cmd, ...args);
  };

  // ── STEP 3: Auto-click the copy button when streaming finishes ────────────────
  // We watch for the extension's copy button to appear and become stable,
  // then programmatically click it. This fires writeText which we intercept above.

  let lastAutoClickText = null;
  let settleTimer = null;
  let streamCheckTimer = null;

  // Known selectors for the copy button in the ChatGPT Summarize extension
  // The extension renders a panel with a copy icon button
  const COPY_BTN_SELECTORS = [
    'button[title*="Copy"]',
    'button[aria-label*="Copy"]',
    'button[aria-label*="copy"]',
    'button[title*="copy"]',
    '[data-testid*="copy"]',
    'button svg[class*="copy"]',         // button containing a copy SVG
    'button[class*="copy"]',
    'button[class*="Copy"]',
    'button[class*="clipboard"]',
    // The extension panel is a fixed overlay — look inside it
    '[class*="SummaryPanel"] button',
    '[class*="summaryPanel"] button',
    '[class*="summary-panel"] button',
    '[class*="Panel"] button[class*="icon"]',
    '[id*="summarize"] button',
  ];

  function findCopyButton() {
    for (let sel of COPY_BTN_SELECTORS) {
      try {
        const btns = Array.from(document.querySelectorAll(sel));
        for (let btn of btns) {
          const label = (btn.getAttribute('title') || btn.getAttribute('aria-label') || btn.innerText || '').toLowerCase();
          if (label.includes('copy') || btn.querySelector('svg')) {
            // Make sure it's visible
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return btn;
          }
        }
      } catch (e) {}
    }

    // Fallback: scan shadow roots
    let found = null;
    document.querySelectorAll('*').forEach(el => {
      if (found) return;
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('button').forEach(btn => {
          if (found) return;
          const label = (btn.getAttribute('title') || btn.getAttribute('aria-label') || btn.innerText || '').toLowerCase();
          if (label.includes('copy')) found = btn;
        });
      }
    });
    return found;
  }

  function isStreaming() {
    // Look for any streaming/loading indicator in the DOM or shadow roots
    const sel = [
      '[class*="streaming"]', '[class*="Streaming"]',
      '[class*="loading"]',   '[class*="Loading"]',
      '[class*="spinner"]',   '[class*="Spinner"]',
      '[class*="typingCursor"]', '[class*="blink"]',
      '[class*="generating"]',
    ];
    return sel.some(s => { try { return !!document.querySelector(s); } catch { return false; } });
  }

  function attemptAutoClick() {
    if (isStreaming()) {
      clearTimeout(streamCheckTimer);
      streamCheckTimer = setTimeout(attemptAutoClick, 1200);
      return;
    }

    const btn = findCopyButton();
    if (!btn) return;

    // Avoid double-clicking for same result
    const nearbyText = btn.closest('[class*="Panel"], [class*="panel"], [id*="summarize"]');
    const panelText = nearbyText ? (nearbyText.innerText || '').trim() : '';
    if (panelText && panelText === lastAutoClickText) return;
    if (panelText) lastAutoClickText = panelText;

    btn.click();
  }

  // MutationObserver: debounce 2.5s after last DOM mutation, then try auto-click
  const observer = new MutationObserver(() => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(attemptAutoClick, 2500);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ── HELPERS ──────────────────────────────────────────────────────────────────
  function looksLikeSummary(text) {
    if (typeof text !== 'string' || text.length < 100) return false;
    // Reject CSS
    if (/^#[a-zA-Z]|\{\s*\n?\s*(display|background|color|border|padding|margin)/.test(text)) return false;
    // Reject mostly special chars (minified code)
    const specialRatio = (text.match(/[{}\[\]();:<>]/g) || []).length / text.length;
    if (specialRatio > 0.07) return false;
    // Must have enough word-like tokens
    const words = (text.match(/[a-zA-Z]{3,}/g) || []).length;
    if (words < 15) return false;
    return true;
  }

  let lastDownloadedText = null;

  function triggerDownload(text) {
    if (!text || text === lastDownloadedText) return;
    lastDownloadedText = text;
    chrome.runtime.sendMessage(
      { type: 'SUMMARY_AUTO_DOWNLOAD', text },
      function (response) {
        if (chrome.runtime.lastError) {
          setTimeout(() => {
            lastDownloadedText = null; // allow retry
            triggerDownload(text);
          }, 3000);
        }
      }
    );
  }

})();
