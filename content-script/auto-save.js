(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;

  // ── CLIPBOARD INTERCEPTION ────────────────────────────────────────────────
  // We wrap writeText so that whenever the copy button is clicked (by user OR
  // by us auto-clicking it), we capture the exact text and download it.

  let lastDownloadedText = null;

  const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function (text) {
    const result = _origWriteText(text);
    if (text && text.length > 100 && !text.startsWith('#') && countWords(text) > 15) {
      scheduleDownload(text);
    }
    return result;
  };

  function countWords(t) {
    return (t.match(/[a-zA-Z]{3,}/g) || []).length;
  }

  function scheduleDownload(text) {
    if (text === lastDownloadedText) return;
    lastDownloadedText = text;
    chrome.runtime.sendMessage({ type: 'SUMMARY_AUTO_DOWNLOAD', text }, function () {
      if (chrome.runtime.lastError) {
        // Background woke up late — retry once
        lastDownloadedText = null;
        setTimeout(() => scheduleDownload(text), 2500);
      }
    });
  }

  // ── BUTTON WATCHER ────────────────────────────────────────────────────────
  // The extension renders 3 action buttons (copy / rewrite / info) at the
  // bottom of the summary panel ONLY after the stream finishes.
  // We detect when these appear, find the copy button among them, and click it.
  //
  // From the screenshot the panel is a fixed overlay on the right side.
  // The buttons are small SVG-icon buttons grouped together.

  let autoClickDone = false;
  let scanTimer = null;

  function findActionButtons() {
    // Strategy: find groups of 2-4 small icon-buttons that are visible and
    // positioned in the right half of the viewport (where the panel lives).
    // The copy button is always one of them.

    const allButtons = Array.from(document.querySelectorAll('button'));
    const panelButtons = allButtons.filter(btn => {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.width > 60 || rect.height > 60) return false; // icon buttons are small
      if (rect.left < window.innerWidth * 0.45) return false; // right-side panel
      return true;
    });

    if (panelButtons.length < 2) return null; // need at least 2 of the 3 buttons

    // Among these, find the copy button by aria-label, title, or SVG content
    const copyBtn = panelButtons.find(btn => {
      const label = (
        (btn.getAttribute('aria-label') || '') +
        (btn.getAttribute('title') || '') +
        (btn.getAttribute('data-tooltip') || '') +
        (btn.innerText || '')
      ).toLowerCase();
      if (label.includes('copy')) return true;
      // Check SVG path data — copy icons typically have a rect+path pattern
      const svg = btn.querySelector('svg');
      if (svg) {
        const paths = svg.querySelectorAll('path, rect');
        if (paths.length >= 2) return true; // copy icon has 2 shapes
      }
      return false;
    });

    return copyBtn || panelButtons[0]; // fallback to first button in group
  }

  function tryScan() {
    if (autoClickDone) return;

    const btn = findActionButtons();
    if (!btn) return; // buttons not visible yet

    autoClickDone = true;
    clearInterval(scanInterval);

    // Small delay to make sure the panel text is fully rendered
    setTimeout(() => {
      btn.click();
    }, 300);
  }

  // Poll every 500ms — as soon as buttons appear we click immediately
  const scanInterval = setInterval(tryScan, 500);

  // Reset autoClickDone when the panel closes/re-opens for a new summary
  // We detect this by watching for the buttons to disappear then reappear
  let buttonsWereVisible = false;
  const resetInterval = setInterval(() => {
    const btn = findActionButtons();
    if (!btn && buttonsWereVisible) {
      // Panel closed or new summary started
      autoClickDone = false;
      buttonsWereVisible = false;
    }
    if (btn) buttonsWereVisible = true;
  }, 1000);

})();
