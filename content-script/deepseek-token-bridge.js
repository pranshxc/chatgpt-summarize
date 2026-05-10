// DeepSeek Token Bridge
// Runs as a content script on https://chat.deepseek.com/*
// Proactively extracts the auth token from localStorage and pushes it
// to the background SW via chrome.runtime.sendMessage.
// This is the only reliable way to get the token — DeepSeek's login API
// is blocked by AWS CloudFront WAF for any non-browser origin.

(function extractAndSendToken() {
  const candidates = [
    'userToken',
    'token',
    'accessToken',
    'access_token',
    'authToken',
    'auth_token',
    'ds_token',
  ];

  function findToken() {
    // 1. Direct key lookup
    for (const key of candidates) {
      const val = localStorage.getItem(key);
      if (val && val.length > 20) return { token: val, source: key };
    }

    // 2. Scan all localStorage entries
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      if (!val) continue;

      // JWT pattern: three base64url segments
      if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val)) {
        return { token: val, source: key };
      }

      // JSON object containing a token field
      if (val.startsWith('{')) {
        try {
          const parsed = JSON.parse(val);
          for (const field of ['token', 'access_token', 'accessToken', 'userToken', 'authToken', 'biz_token']) {
            if (parsed[field] && typeof parsed[field] === 'string' && parsed[field].length > 20) {
              return { token: parsed[field], source: `${key}.${field}` };
            }
          }
        } catch {}
      }
    }

    return null;
  }

  function sendToken(result) {
    if (!result || !result.token) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'DEEPSEEK_TOKEN_FROM_PAGE', token: result.token, source: result.source },
        () => { if (chrome.runtime.lastError) {} } // suppress error if SW is asleep
      );
      console.log('[DeepSeek Bridge] Token sent to background from localStorage key:', result.source);
    } catch (e) {
      console.warn('[DeepSeek Bridge] Could not send token:', e.message);
    }
  }

  // Try immediately (page already loaded)
  const immediate = findToken();
  if (immediate) {
    sendToken(immediate);
    return;
  }

  // If not found yet, wait for page to fully initialize and try again
  // DeepSeek is a SPA — token may be written to localStorage after React hydration
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    const result = findToken();
    if (result) {
      clearInterval(interval);
      sendToken(result);
      return;
    }
    if (attempts >= 20) { // give up after 10 seconds
      clearInterval(interval);
      console.warn('[DeepSeek Bridge] Token not found in localStorage after 10s');
    }
  }, 500);
})();
