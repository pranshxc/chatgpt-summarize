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
  if (/^[\s]*[#.[\*@]/.test(text.slice(0, 10))) return false;
  if ((text.match(/[{}();]/g) || []).length / text.length > 0.06) return false;
  return (text.match(/[a-zA-Z]{4,}/g) || []).length > 20;
}

// ── Cookie helper (kept for GET_DEEPSEEK_COOKIES legacy compat) ─────────────────
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
        const k = `${c.name}|${c.domain}|${c.path}`;
        if (!seen.has(k)) seen.set(k, c);
      }
    } catch (e) {
      console.warn('[DeepSeek] cookie fetch failed for', url, e);
    }
  }
  if (seen.size === 0) return null;
  return Array.from(seen.values()).map(c => `${c.name}=${c.value}`).join('; ');
}

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // Auto-download trigger from content script
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  // Legacy cookie fetch
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr().then(cookieStr => {
      sendResponse({ cookieStr: cookieStr || null });
    });
    return true;
  }

  // Token bridge: DeepSeek tab content script pushes token here on page load
  if (message && message.type === 'DEEPSEEK_TOKEN_FROM_PAGE') {
    if (message.token) {
      console.log('[DeepSeek] Token received from page bridge, key:', message.source);
      chrome.storage.local.set({ 'deepseek-cached-token': message.token });
    }
    sendResponse({ ok: true });
    return true;
  }

  // DEEPSEEK_LOGIN:
  // Strategy: read the token that the content bridge already pushed into storage.
  // This completely avoids DeepSeek's CloudFront WAF which blocks all non-browser
  // login API calls regardless of headers, cookies, or request origin.
  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      const { email, password } = message;
      console.log('[DeepSeek] Login requested — checking for cached token from page bridge');

      // 1. Check if the bridge already pushed a token
      const stored = await chrome.storage.local.get(['deepseek-cached-token']);
      const cachedToken = stored['deepseek-cached-token'];

      if (cachedToken) {
        console.log('[DeepSeek] Using token from page bridge cache');
        await chrome.storage.local.set({
          'deepseek-token': cachedToken,
          'deepseek-login': email,
          'deepseek-password': password,
        });
        sendResponse({ token: cachedToken });
        return;
      }

      // 2. Token not yet cached — try to trigger the bridge by finding the open tab
      // and injecting the script directly as a fallback
      console.log('[DeepSeek] No cached token — attempting scripting injection fallback');
      const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });

      if (!tabs || tabs.length === 0) {
        sendResponse({
          error: 'Please open https://chat.deepseek.com in a tab and log in there first, then try again here.\n\nThe extension reads your session from the open tab — no separate API call needed.',
        });
        return;
      }

      // Inject and extract directly
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            const candidates = ['userToken','token','accessToken','access_token','authToken','auth_token','ds_token','biz_token'];
            for (const key of candidates) {
              const val = localStorage.getItem(key);
              if (val && val.length > 20) return { token: val, source: key };
            }
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const val = localStorage.getItem(key);
              if (!val) continue;
              if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val))
                return { token: val, source: key };
              if (val.startsWith('{')) {
                try {
                  const p = JSON.parse(val);
                  for (const f of ['token','access_token','accessToken','userToken','authToken','biz_token']) {
                    if (p[f] && typeof p[f] === 'string' && p[f].length > 20)
                      return { token: p[f], source: `${key}.${f}` };
                  }
                } catch {}
              }
            }
            // Also dump all keys for debugging
            const allKeys = [];
            for (let i = 0; i < localStorage.length; i++) allKeys.push(localStorage.key(i));
            return { error: 'not_found', keys: allKeys };
          },
        });

        const result = results?.[0]?.result;

        if (result && result.token) {
          await chrome.storage.local.set({
            'deepseek-token': result.token,
            'deepseek-cached-token': result.token,
            'deepseek-login': email,
            'deepseek-password': password,
          });
          sendResponse({ token: result.token });
          return;
        }

        if (result && result.error === 'not_found') {
          // Log the actual keys found so we can see what DeepSeek uses
          console.warn('[DeepSeek] Token not found. localStorage keys present:', result.keys);
          sendResponse({
            error: `Logged into DeepSeek but token not found in localStorage.\n\nKeys found: ${(result.keys || []).join(', ')}\n\nPlease report these key names so the extension can be updated.`,
          });
          return;
        }

        sendResponse({ error: `Unexpected result from tab injection: ${JSON.stringify(result)}` });
      } catch (err) {
        sendResponse({ error: `Tab injection failed: ${err.message}\n\nPlease reload the extension at chrome://extensions and try again.` });
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
