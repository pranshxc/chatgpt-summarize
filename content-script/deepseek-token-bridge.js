// DeepSeek Token Bridge
// Injected on chat.deepseek.com — reads the auth token directly from
// DeepSeek's localStorage so we never need to call the login API at all.
// This completely sidesteps CloudFront WAF challenge blocking.
(function () {
  if (window.__deepseekTokenBridgeLoaded) return;
  window.__deepseekTokenBridgeLoaded = true;

  function extractToken() {
    try {
      // DeepSeek stores session data in localStorage under these known keys
      const candidates = [
        'userToken',
        'user_token',
        'token',
        'accessToken',
        'access_token',
        'deepseek_token',
        'auth_token',
      ];

      // Direct key check
      for (const key of candidates) {
        const val = localStorage.getItem(key);
        if (val && val.length > 20 && !val.startsWith('{')) return val;
      }

      // JSON-encoded objects in localStorage (e.g. { token: '...' })
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        try {
          const raw = localStorage.getItem(key);
          if (!raw || raw.length < 20) continue;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const field of ['token', 'userToken', 'access_token', 'accessToken', 'biz_data']) {
              if (parsed[field] && typeof parsed[field] === 'string' && parsed[field].length > 20) {
                return parsed[field];
              }
              // Nested: { data: { user: { token } } }
              if (parsed[field] && typeof parsed[field] === 'object') {
                const nested = parsed[field];
                for (const sub of ['token', 'userToken', 'access_token']) {
                  if (nested[sub] && typeof nested[sub] === 'string' && nested[sub].length > 20) {
                    return nested[sub];
                  }
                }
              }
            }
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[DeepSeekBridge] localStorage read failed:', e);
    }
    return null;
  }

  function sendTokenToBackground(token) {
    chrome.runtime.sendMessage(
      { type: 'DEEPSEEK_TOKEN_FROM_PAGE', token },
      response => {
        if (chrome.runtime.lastError) {
          console.warn('[DeepSeekBridge] sendMessage error:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.saved) {
          console.log('[DeepSeekBridge] Token saved to extension storage successfully.');
        }
      }
    );
  }

  // Try immediately on load
  const token = extractToken();
  if (token) {
    console.log('[DeepSeekBridge] Token found on page load, sending to background.');
    sendTokenToBackground(token);
    return;
  }

  // If not found immediately, watch localStorage via storage event
  // (fires when DeepSeek writes the token after login completes)
  window.addEventListener('storage', function onStorage(e) {
    const token = extractToken();
    if (token) {
      console.log('[DeepSeekBridge] Token found after storage event, sending to background.');
      sendTokenToBackground(token);
      window.removeEventListener('storage', onStorage);
    }
  });

  // Also poll briefly for SPA login flows that don't fire storage events
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    const token = extractToken();
    if (token) {
      console.log('[DeepSeekBridge] Token found after polling, sending to background.');
      sendTokenToBackground(token);
      clearInterval(poll);
      return;
    }
    if (attempts >= 20) clearInterval(poll); // stop after 10 seconds
  }, 500);
})();
