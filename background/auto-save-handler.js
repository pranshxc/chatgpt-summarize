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

// ── DeepSeek cookie helper ────────────────────────────────────────────────────
// Uses chrome.cookies (MV3) to read whatever cookies the user's browser already
// has for DeepSeek after they logged in normally at chat.deepseek.com.
// No login API call is ever made — we just piggyback on the existing session.
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

  if (seen.size === 0) {
    console.warn('[DeepSeek] No cookies found — user needs to log in at chat.deepseek.com first');
    return null;
  }

  const cookieStr = Array.from(seen.values()).map(c => `${c.name}=${c.value}`).join('; ');
  console.log('[DeepSeek] Collected', seen.size, 'unique cookies across DeepSeek domains');
  return cookieStr;
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  // Auto-download trigger from content script
  if (message && message.type === 'SUMMARY_AUTO_DOWNLOAD' && message.text) {
    doDownload(message.text, sender, sendResponse);
    return true;
  }

  // Cookie fetch (used by chunk-LBLDOCW3.js getDeepSeekCookies)
  if (message && message.type === 'GET_DEEPSEEK_COOKIES') {
    getDeepSeekCookieStr().then(cookieStr => {
      sendResponse({ cookieStr: cookieStr || null });
    });
    return true;
  }

  // DEEPSEEK_LOGIN
  // ─────────────────────────────────────────────────────────────────────────
  // NEW APPROACH: We do NOT call the login API at all.
  //
  // DeepSeek's login endpoint (https://chat.deepseek.com/api/v0/users/login)
  // is protected by AWS CloudFront WAF which rejects any request not coming
  // from a real browser (TLS fingerprint + HTTP/2 frame checks). There is no
  // way to bypass this from a service worker or extension background page.
  //
  // Instead: the user logs in once normally at https://chat.deepseek.com.
  // Their browser stores a session cookie (typically named "userToken" or a
  // similar auth cookie). We read those cookies via chrome.cookies and attach
  // them to every outgoing DeepSeek API request.
  //
  // This means:
  //   • No email/password is needed by the extension
  //   • No login network request is ever made
  //   • The WAF is never triggered
  //   • Session automatically inherits the user's logged-in state
  // ─────────────────────────────────────────────────────────────────────────
  if (message && message.type === 'DEEPSEEK_LOGIN') {
    (async () => {
      const cookieStr = await getDeepSeekCookieStr();

      if (!cookieStr) {
        sendResponse({
          error: 'Not logged in to DeepSeek.\n\nPlease open https://chat.deepseek.com in a new tab, log in with your account, then come back and click Connect again.',
        });
        return;
      }

      // Store cookie string so chunk-LBLDOCW3.js can use it for API calls
      await chrome.storage.local.set({ 'deepseek-cookie': cookieStr });

      // Verify the session is valid by calling a lightweight authenticated endpoint
      try {
        const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
          method: 'GET',
          headers: {
            'Cookie': cookieStr,
            'Accept': 'application/json',
            'x-app-version': '20241129.1',
            'x-client-platform': 'web',
          },
          credentials: 'omit',
        });

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}

        // WAF challenge or empty body — cookies exist but aren't being forwarded
        // to the API (this is a browser security restriction — Cookie header is
        // not sent by service workers to 3rd-party origins in all browsers).
        // In that case, skip verification and trust the cookies are valid.
        if (!text || (res.status === 200 && !data)) {
          console.warn('[DeepSeek] Session check returned empty — proceeding with cookies anyway');
          sendResponse({ cookieStr, skippedVerify: true });
          return;
        }

        if (!res.ok || data?.code !== 0) {
          sendResponse({
            error: `DeepSeek session is expired or invalid (HTTP ${res.status}).\n\nPlease log in again at https://chat.deepseek.com and then click Connect.`,
          });
          return;
        }

        // Success — store user info if available
        const user = data?.data?.user;
        if (user) {
          await chrome.storage.local.set({
            'deepseek-user': user,
            // Also store token if the /current endpoint returns one
            ...(user.token ? { 'deepseek-token': user.token } : {}),
          });
        }

        console.log('[DeepSeek] Session verified via cookies. User:', user?.email || user?.nickname || 'unknown');
        sendResponse({ cookieStr, user: user || null });

      } catch (err) {
        // Network error during verification — still return the cookies
        // so the extension can attempt API calls
        console.warn('[DeepSeek] Session verify failed (network):', err.message);
        sendResponse({ cookieStr, skippedVerify: true });
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
