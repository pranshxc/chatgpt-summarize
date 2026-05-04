// Auto-download handler
// 1. Receives SUMMARY_AUTO_DOWNLOAD message from content script (manual trigger)
// 2. Watches chrome.storage.onChanged for the key the extension uses to save summaries

// ── Storage watcher ──────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener(function (changes, area) {
  for (const key of Object.keys(changes)) {
    const { oldValue, newValue } = changes[key];
    const preview = typeof newValue === 'string'
      ? newValue.slice(0, 120)
      : (newValue && typeof newValue === 'object'
          ? JSON.stringify(newValue).slice(0, 120)
          : String(newValue));
    console.log('[AutoSave][storage.onChanged]', area, 'key:', key, '| preview:', preview);
    const text = extractSummaryText(newValue);
    if (text && text !== extractSummaryText(oldValue)) {
      console.log('[AutoSave] Detected summary in key:', key, '- triggering download');
      doDownload(text, null);
    }
  }
});

function extractSummaryText(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    return looksLikeSummary(val) ? val : null;
  }
  if (typeof val === 'object') {
    for (const field of ['summary', 'result', 'content', 'answer', 'text', 'output', 'response', 'message']) {
      if (looksLikeSummary(val[field])) return val[field];
    }
    for (const sub of Object.values(val)) {
      if (sub && typeof sub === 'object') {
        for (const field of ['summary', 'result', 'content', 'answer', 'text', 'output']) {
          if (looksLikeSummary(sub[field])) return sub[field];
        }
      }
    }
  }
  return null;
}

function looksLikeSummary(text) {
  if (typeof text !== 'string') return false;
  if (text.length < 150) return false;
  if (/^[\s]*[#.\[\*@]/.test(text.slice(0, 10))) return false;
  if ((text.match(/[{}();]/g) || []).length / text.length > 0.06) return false;
  return (text.match(/[a-zA-Z]{4,}/g) || []).length > 20;
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // Auto-download trigger from content script
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  // Cookie fetch for DeepSeek login — chrome.cookies only works in background SW
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    chrome.cookies.getAll({ domain: 'chat.deepseek.com' }, function (cookies) {
      if (chrome.runtime.lastError || !cookies || cookies.length === 0) {
        console.warn('[DeepSeek] No cookies found for chat.deepseek.com');
        sendResponse({ cookieStr: null });
        return;
      }
      const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
      console.log('[DeepSeek] Sending', cookies.length, 'cookies to popup');
      sendResponse({ cookieStr });
    });
    return true; // keep message channel open for async sendResponse
  }
});

let lastDownloadedText = null;

function doDownload(text, sender, sendResponse) {
  if (!text || text === lastDownloadedText) {
    sendResponse && sendResponse({ success: false, reason: 'duplicate' });
    return;
  }
  lastDownloadedText = text;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'summaries/summary-' + timestamp + '.txt';
  const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);

  chrome.downloads.download(
    { url: dataUrl, filename: filename, saveAs: false },
    function (downloadId) {
      if (chrome.runtime.lastError) {
        console.warn('[AutoSave] Download failed:', chrome.runtime.lastError.message);
        lastDownloadedText = null;
        sendResponse && sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log('[AutoSave] Saved:', filename, '| ID:', downloadId);
        chrome.storage.local.get(['_summaryHistory'], function (res) {
          const history = res._summaryHistory || [];
          history.unshift({ timestamp, text: text.slice(0, 500), url: (sender && sender.url) || '' });
          if (history.length > 50) history.length = 50;
          chrome.storage.local.set({ _summaryHistory: history });
        });
        sendResponse && sendResponse({ success: true, downloadId });
      }
    }
  );
}
