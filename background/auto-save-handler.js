// Auto-download handler
// 1. Receives SUMMARY_AUTO_DOWNLOAD message from content script (manual trigger)
// 2. Watches chrome.storage.onChanged for the key the extension uses to save summaries
// 3. Handles DEEPSEEK_TOKEN_FROM_PAGE — saves token extracted from DeepSeek's localStorage
// 4. Handles DEEPSEEK_LOGIN — legacy path with WAF diagnostics
// 5. Handles GET_DEEPSEEK_COOKIES — legacy cookie fetch

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
  if (/^[\s]*[#.[\*@]/.test(text.slice(0, 10))) return false;
  if ((text.match(/[{}();]/g) || []).length / text.length > 0.06) return false;
  return (text.match(/[a-zA-Z]{4,}/g) || []).length > 20;
}

// ── DeepSeek cookie helper (used by legacy GET_DEEPSEEK_COOKIES) ───────────────
async function getDeepSeekCookieStr() {
  const urls = [
    'https://chat.deepseek.com',
    'https://www.deepseek.com',
    'https://deepseek.com',
  ];
  const seen = new Map();
  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const c of cookies) {
        const key = `${c.name}|${c.domain}|${c.path}`;
        if (!seen.has(key)) seen.set(key, c);
      }
    } catch (e) {
      console.warn('[DeepSeek] cookie fetch failed for', url, e);
    }
  }
  if (seen.size === 0) return null;
  const cookieStr = Array.from(seen.values()).map(c => `${c.name}=${c.value}`).join('; ');
  console.log('[DeepSeek] Collected', seen.size, 'unique cookies across DeepSeek domains');
  return cookieStr;
}

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  // Auto-download trigger
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  // ★ PRIMARY PATH: Token extracted directly from DeepSeek's localStorage by content script
  // No API call, no WAF, no cookies needed. Works as long as user is logged in on chat.deepseek.com.
  if (message && message.type === 'DEEPSEEK_TOKEN_FROM_PAGE') {
    const { token } = message;
    if (!token || token.length < 20) {
      sendResponse({ saved: false, error: 'Invalid token received from page' });
      return true;
    }
    chrome.storage.local.set({ 'deepseek-token': token }, () => {
      console.log('[DeepSeek] Token saved from page localStorage. Length:', token.length);
      sendResponse({ saved: true });
    });
    return true;
  }

  // Legacy: cookie-only fetch
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr().then(cookieStr => {
      sendResponse({ cookieStr: cookieStr || null });
    });
    return true;
  }

  // Legacy: full background login attempt (WAF-blocked, kept for diagnostics)
  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      try {
        const { email, password } = message;

        // First, check if we already have a token saved from the page bridge
        const stored = await chrome.storage.local.get({ 'deepseek-token': '' });
        if (stored['deepseek-token'] && stored['deepseek-token'].length > 20) {
          console.log('[DeepSeek] Using existing token from page bridge, skipping login API call.');
          sendResponse({ token: stored['deepseek-token'] });
          return;
        }

        // No page-bridge token available — instruct user to log in on the site
        // (Direct API login is blocked by DeepSeek CloudFront WAF regardless of headers/cookies)
        const cookieStr = await getDeepSeekCookieStr();
        if (!cookieStr) {
          sendResponse({
            error: 'DeepSeek requires you to log in via the browser.\n\nPlease:\n1) Open https://chat.deepseek.com in a tab\n2) Log in there\n3) Come back and try again — the extension will automatically pick up your session.',
            diagnostic: { reason: 'no_page_token_no_cookies' },
          });
          return;
        }

        // Has cookies but no page token yet — user may be logged in but token bridge hasn\'t run
        sendResponse({
          error: 'Your DeepSeek session was detected but the token bridge has not run yet.\n\nPlease:\n1) Make sure https://chat.deepseek.com is open in a tab\n2) Refresh that tab\n3) Try again here',
          diagnostic: { reason: 'cookies_but_no_page_token', cookieCount: cookieStr.split(';').length },
        });
      } catch (err) {
        sendResponse({ error: err?.message || 'DeepSeek login failed' });
      }
    })();
    return true;
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
