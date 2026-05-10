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

// ── DeepSeek cookie helper ──────────────────────────────────────────────────
// FIX: Use { url } instead of { domain } — the domain filter is unreliable in MV3.
// Query multiple URLs to catch cookies set on root domain vs subdomain.
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

  if (seen.size === 0) {
    console.warn('[DeepSeek] No cookies found across all DeepSeek domains');
    return null;
  }

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

  // Legacy: cookie-only fetch (kept for backward compat)
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr().then(cookieStr => {
      sendResponse({ cookieStr: cookieStr || null });
    });
    return true;
  }

  // Full background-owned DeepSeek login
  // Runs from SW context to bypass CloudFront/WAF blocking of extension-origin requests
  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      try {
        const { email, password } = message;

        const cookieStr = await getDeepSeekCookieStr();
        console.log('[DeepSeek] Login attempt — cookies:', cookieStr ? cookieStr.split(';').length + ' found' : 'none');

        // Mimic a real browser request from chat.deepseek.com to defeat WAF fingerprinting
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://chat.deepseek.com',
          'Referer': 'https://chat.deepseek.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'x-app-version': '20241129.1',
          'x-client-platform': 'web',
          'x-client-locale': 'en_US',
        };
        if (cookieStr) headers['Cookie'] = cookieStr;

        const res = await fetch('https://chat.deepseek.com/api/v0/users/login', {
          method: 'POST',
          headers,
          credentials: 'omit',
          body: JSON.stringify({
            email,
            password,
            mobile: '',
            area_code: '',
            device_id: '',
            os: 'web',
          }),
        });

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}

        const ct = res.headers.get('content-type') || '';
        const wafAction = res.headers.get('x-amzn-waf-action') || '';

        // WAF challenge detected — either empty body or HTML challenge page
        if (wafAction === 'challenge' || (!text && res.status !== 200)) {
          if (!cookieStr) {
            sendResponse({
              error: 'DeepSeek requires browser cookies to authenticate.\n\nPlease: 1) Open https://chat.deepseek.com in a tab, 2) Log in there, 3) Come back and try again here.',
              diagnostic: { reason: 'waf_no_cookies', status: res.status, wafAction },
            });
          } else {
            sendResponse({
              error: `DeepSeek's WAF is actively blocking this login request (HTTP ${res.status}).\n\nThis is a server-side bot protection issue. Please:\n1) Open https://chat.deepseek.com\n2) Complete any CAPTCHA challenge\n3) Log in manually\n4) Then try again here.`,
              diagnostic: { reason: 'waf_blocked_with_cookies', status: res.status, wafAction, cookieCount: cookieStr.split(';').length },
            });
          }
          return;
        }

        if (!text) {
          sendResponse({
            error: `DeepSeek returned an empty response (HTTP ${res.status}). Please wait a moment and try again.`,
            diagnostic: { reason: 'empty_body', status: res.status },
          });
          return;
        }

        // HTML body = challenge page without WAF header
        if (!ct.includes('application/json')) {
          sendResponse({
            error: 'DeepSeek is returning a bot-protection page instead of a login response.\n\nPlease open https://chat.deepseek.com, complete any CAPTCHA, log in, then try again.',
            diagnostic: { reason: 'html_challenge', status: res.status, preview: text.slice(0, 200) },
          });
          return;
        }

        if (!res.ok) {
          sendResponse({
            error: data?.error || data?.detail?.message || data?.message || `Login failed (HTTP ${res.status}). Please check your credentials.`,
            diagnostic: { reason: 'api_error', status: res.status },
          });
          return;
        }

        if (data?.data?.user?.token) {
          await chrome.storage.local.set({
            'deepseek-token': data.data.user.token,
            'deepseek-login': email,
            'deepseek-password': password,
          });
          sendResponse({ token: data.data.user.token });
          return;
        }

        sendResponse({
          error: `DeepSeek login response has an unexpected format. The API may have changed.\n\nRaw preview: ${text.slice(0, 200)}`,
          diagnostic: { reason: 'unexpected_shape', status: res.status },
        });
      } catch (err) {
        sendResponse({ error: err?.message || 'DeepSeek login failed in background worker' });
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
