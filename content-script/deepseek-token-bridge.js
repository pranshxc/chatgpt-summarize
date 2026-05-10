// This file is intentionally left minimal.
// The token-bridge approach (localStorage injection) has been replaced by
// cookie-based session auth in background/auto-save-handler.js.
// The user logs in at https://chat.deepseek.com directly; the extension
// reads their browser cookies via chrome.cookies — no API login call needed.
