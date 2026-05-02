(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;

  console.log('[AutoSave] loaded ✓');

  // ── CLIPBOARD INTERCEPT ────────────────────────────────────────────────
  let lastDownloadedText = null;

  const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function (text) {
    console.log('[AutoSave] clipboard.writeText intercepted, length:', text && text.length, 'preview:', text && text.slice(0, 80));
    const result = _origWriteText(text);
    if (text && text.length > 100 && !text.startsWith('#') && countWords(text) > 15) {
      scheduleDownload(text);
    } else {
      console.log('[AutoSave] skipped (too short or looks like CSS)');
    }
    return result;
  };

  function countWords(t) {
    return (t.match(/[a-zA-Z]{3,}/g) || []).length;
  }

  function scheduleDownload(text) {
    if (text === lastDownloadedText) { console.log('[AutoSave] skipped duplicate'); return; }
    lastDownloadedText = text;
    console.log('[AutoSave] sending download message...');
    chrome.runtime.sendMessage({ type: 'SUMMARY_AUTO_DOWNLOAD', text }, function (resp) {
      if (chrome.runtime.lastError) {
        console.warn('[AutoSave] sendMessage error:', chrome.runtime.lastError.message);
        lastDownloadedText = null;
        setTimeout(() => scheduleDownload(text), 2500);
      } else {
        console.log('[AutoSave] download triggered ✓', resp);
      }
    });
  }

  // ── BUTTON SCAN ───────────────────────────────────────────────────────────

  let autoClickDone = false;

  function getAllButtons() {
    const buttons = [];

    // Regular DOM buttons
    document.querySelectorAll('button').forEach(b => buttons.push({ btn: b, source: 'dom' }));

    // Shadow DOM buttons
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('button').forEach(b => buttons.push({ btn: b, source: 'shadow' }));
      }
    });

    return buttons;
  }

  function tryScan() {
    if (autoClickDone) return;

    const allBtns = getAllButtons();

    // Log ALL visible buttons in the right half so we can identify them
    const panelBtns = allBtns.filter(({ btn }) => {
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left > window.innerWidth * 0.4;
    });

    if (panelBtns.length > 0) {
      console.log('[AutoSave] visible right-side buttons:',
        panelBtns.map(({ btn, source }) => ({
          source,
          tag: btn.tagName,
          class: btn.className,
          id: btn.id,
          title: btn.getAttribute('title'),
          ariaLabel: btn.getAttribute('aria-label'),
          dataTooltip: btn.getAttribute('data-tooltip'),
          text: btn.innerText.trim().slice(0, 30),
          svgCount: btn.querySelectorAll('svg').length,
          x: Math.round(btn.getBoundingClientRect().left),
          y: Math.round(btn.getBoundingClientRect().top),
          w: Math.round(btn.getBoundingClientRect().width),
          h: Math.round(btn.getBoundingClientRect().height),
        }))
      );
    }

    // Try to find copy button
    const copyBtn = allBtns.find(({ btn }) => {
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const label = [
        btn.getAttribute('aria-label') || '',
        btn.getAttribute('title') || '',
        btn.getAttribute('data-tooltip') || '',
        btn.innerText || '',
      ].join(' ').toLowerCase();
      return label.includes('copy');
    });

    if (copyBtn) {
      console.log('[AutoSave] found copy button! clicking...', copyBtn.btn.className, copyBtn.source);
      autoClickDone = true;
      clearInterval(scanInterval);
      setTimeout(() => copyBtn.btn.click(), 200);
    }
  }

  const scanInterval = setInterval(tryScan, 800);

  // Reset when panel re-opens
  let hadButtons = false;
  setInterval(() => {
    const has = getAllButtons().some(({ btn }) => {
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.left > window.innerWidth * 0.4;
    });
    if (!has && hadButtons) {
      autoClickDone = false;
      hadButtons = false;
      console.log('[AutoSave] panel closed, reset');
    }
    if (has) hadButtons = true;
  }, 1500);

})();
