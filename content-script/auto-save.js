(function () {
  if (window.__summarizeAutoSaveLoaded) return;
  window.__summarizeAutoSaveLoaded = true;

  // ── CLIPBOARD INTERCEPT ────────────────────────────────────────────────
  // The copy button calls navigator.clipboard.writeText with the exact summary.
  // We intercept every writeText call and download if it looks like real content.

  let lastDownloadedText = null;

  const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = function (text) {
    const result = _origWriteText(text);
    if (text && text.length > 100 && (text.match(/[a-zA-Z]{3,}/g) || []).length > 15) {
      scheduleDownload(text);
    }
    return result;
  };

  function scheduleDownload(text) {
    if (text === lastDownloadedText) return;
    lastDownloadedText = text;
    chrome.runtime.sendMessage({ type: 'SUMMARY_AUTO_DOWNLOAD', text }, function (resp) {
      if (chrome.runtime.lastError) {
        lastDownloadedText = null;
        setTimeout(() => scheduleDownload(text), 2500);
      }
    });
  }

  // ── BUTTON GROUP DETECTION ──────────────────────────────────────────────
  // From the console log we know:
  // - All buttons have minified class names with NO aria-label / title
  // - The 3 action buttons (copy/rewrite/info) are the LAST 3 in the right-side
  //   button list, all small (w<60, h<60), all sharing similar class length
  // - They appear as a tightly grouped cluster (y-positions within ~10px of each other)
  // - Count jumps from 8 to 11 exactly when streaming finishes
  //
  // Strategy: wait until we see exactly 3 small icon-buttons clustered together
  // in the right panel, then click the FIRST one (copy is always first).

  let autoClickDone = false;
  let prevCount = 0;

  function getRightPanelSmallButtons() {
    return Array.from(document.querySelectorAll('button')).filter(btn => {
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (r.width > 55 || r.height > 55) return false;   // icon buttons only
      if (r.left < window.innerWidth * 0.45) return false; // right panel only
      return true;
    });
  }

  function findActionGroup(buttons) {
    // Sort by Y position
    const sorted = [...buttons].sort((a, b) => {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });

    // Find a group of 3 buttons whose Y positions are all within 15px of each other
    // and whose X positions are within 120px of each other (horizontal row)
    for (let i = 0; i <= sorted.length - 3; i++) {
      const a = sorted[i].getBoundingClientRect();
      const b = sorted[i + 1].getBoundingClientRect();
      const c = sorted[i + 2].getBoundingClientRect();

      const ySpread = Math.max(a.top, b.top, c.top) - Math.min(a.top, b.top, c.top);
      const xSpread = Math.max(a.left, b.left, c.left) - Math.min(a.left, b.left, c.left);

      if (ySpread < 20 && xSpread < 150) {
        // Found a horizontal group of 3 — return them sorted by X (left to right)
        return [sorted[i], sorted[i+1], sorted[i+2]].sort((x, y) =>
          x.getBoundingClientRect().left - y.getBoundingClientRect().left
        );
      }
    }
    return null;
  }

  function tryScan() {
    if (autoClickDone) return;

    const smallBtns = getRightPanelSmallButtons();
    const count = smallBtns.length;

    // The 3 action buttons appear when count increases to >= 3 more than before
    // OR simply when we can find a tight 3-button horizontal cluster
    const group = findActionGroup(smallBtns);
    if (!group) return;

    // We have the group — click the first button (copy)
    autoClickDone = true;
    clearInterval(scanInterval);

    const copyBtn = group[0];
    setTimeout(() => {
      copyBtn.click();
    }, 300);
  }

  const scanInterval = setInterval(tryScan, 600);

  // Reset when button group disappears (new summary started)
  let hadGroup = false;
  setInterval(() => {
    const group = findActionGroup(getRightPanelSmallButtons());
    if (!group && hadGroup) {
      autoClickDone = false;
      hadGroup = false;
      lastDownloadedText = null;
    }
    if (group) hadGroup = true;
  }, 1200);

})();
