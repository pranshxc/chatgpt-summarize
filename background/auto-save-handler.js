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

// ── DeepSeek token extraction via tab injection ───────────────────────────────────
//
// WHY THIS APPROACH:
// DeepSeek's login API endpoint is protected by AWS CloudFront WAF.
// It returns HTTP 200 with empty body + x-amzn-waf-action: challenge for ANY
// non-browser request (including from extension service workers), regardless
// of cookies or headers sent. There is no way to bypass this at the network level.
//
// SOLUTION: Instead of calling the login API, we inject a tiny script into the
// user's existing chat.deepseek.com tab and read the auth token directly from
// DeepSeek's own localStorage. DeepSeek stores the token there after login.
// This completely avoids the WAF because we never make the login network request.

async function extractDeepSeekTokenFromTab() {
  // Find an open DeepSeek tab
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });

  if (!tabs || tabs.length === 0) {
    return { error: 'no_tab' };
  }

  const tab = tabs[0];

  try {
    // Inject into the DeepSeek tab and read localStorage
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          // DeepSeek stores auth state in localStorage under various keys
          // Try all known key patterns
          const candidates = [
            'userToken',
            'token',
            'accessToken',
            'access_token',
            'authToken',
            'auth_token',
            'ds_token',
          ];

          // Direct key lookup
          for (const key of candidates) {
            const val = localStorage.getItem(key);
            if (val && val.length > 20) return { token: val, source: key };
          }

          // Scan all localStorage keys for anything that looks like a JWT or token
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            if (!val) continue;

            // JWT pattern: three base64 segments separated by dots
            if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val)) {
              return { token: val, source: key };
            }

            // Try JSON values that might contain a token field
            if (val.startsWith('{')) {
              try {
                const parsed = JSON.parse(val);
                for (const field of ['token', 'access_token', 'accessToken', 'userToken', 'authToken']) {
                  if (parsed[field] && typeof parsed[field] === 'string' && parsed[field].length > 20) {
                    return { token: parsed[field], source: `${key}.${field}` };
                  }
                }
              } catch {}
            }
          }

          return { error: 'not_found', keysScanned: localStorage.length };
        } catch (e) {
          return { error: 'script_error', message: e.message };
        }
      },
    });

    const result = results?.[0]?.result;
    if (!result) return { error: 'no_result' };
    return result;
  } catch (e) {
    return { error: 'injection_failed', message: e.message };
  }
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
  // Auto-download trigger from content script
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  // Legacy: cookie-only fetch
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr().then(cookieStr => {
      sendResponse({ cookieStr: cookieStr || null });
    });
    return true;
  }

  // DEEPSEEK_LOGIN: extract token from open tab instead of calling blocked API
  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      const { email, password } = message;

      console.log('[DeepSeek] Login requested — attempting tab-based token extraction');

      const result = await extractDeepSeekTokenFromTab();

      if (result && result.token) {
        console.log('[DeepSeek] Token extracted from tab localStorage via key:', result.source);
        await chrome.storage.local.set({
          'deepseek-token': result.token,
          'deepseek-login': email,
          'deepseek-password': password,
        });
        sendResponse({ token: result.token });
        return;
      }

      // Tab not found — user hasn't opened DeepSeek yet
      if (result.error === 'no_tab') {
        sendResponse({
          error: 'Please open https://chat.deepseek.com in a browser tab and log in there first, then try again here.\n\nThe extension reads your session from the open tab — no separate login needed.',
        });
        return;
      }

      // Tab found but token not in localStorage—DeepSeek may use a different storage key
      if (result.error === 'not_found') {
        sendResponse({
          error: `A DeepSeek tab is open but the auth token could not be found in localStorage (scanned ${result.keysScanned} keys).\n\nPlease make sure you are fully logged in at https://chat.deepseek.com and then try again.`,
        });
        return;
      }

      // Script injection failed (permissions issue, etc.)
      if (result.error === 'injection_failed' || result.error === 'script_error') {
        // Fall back to cookie-based approach as last resort
        console.warn('[DeepSeek] Tab injection failed, falling back to cookie header approach:', result.message);
        const cookieStr = await getDeepSeekCookieStr();
        sendResponse({
          error: `Could not read the DeepSeek tab directly (${result.message}).\n\nDeepSeek's WAF is also blocking direct API calls. Please try:\n1) Reload the extension at chrome://extensions\n2) Make sure chat.deepseek.com is open and you are logged in\n3) Try again`,
          diagnostic: { reason: result.error, cookieCount: cookieStr ? cookieStr.split(';').length : 0 },
        });
        return;
      }

      sendResponse({ error: `Unexpected error during login: ${JSON.stringify(result)}` });
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
