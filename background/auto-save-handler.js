// Background handler for auto-download of summaries
// This file is injected via manifest content_scripts logic.
// It listens for SUMMARY_AUTO_DOWNLOAD messages from content scripts.

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    const text = message.text;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = 'summaries/summary-' + timestamp + '.txt';

    // Create a data URL from the text
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);

    chrome.downloads.download(
      { url: dataUrl, filename: filename, saveAs: false },
      function (downloadId) {
        if (chrome.runtime.lastError) {
          console.warn('[AutoSave] Download failed:', chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[AutoSave] Summary saved. Download ID:', downloadId);
          // Also store in history
          chrome.storage.local.get(['_summaryHistory'], function (res) {
            const history = res._summaryHistory || [];
            history.unshift({ timestamp, text: text.slice(0, 500), url: sender.url || '' });
            if (history.length > 50) history.length = 50;
            chrome.storage.local.set({ _summaryHistory: history });
          });
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true; // keep message channel open for async response
  }
});
