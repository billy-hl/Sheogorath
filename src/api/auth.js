'use strict';
const crypto = require('crypto');

/**
 * Bearer-token auth for the control API.
 *
 * The API is bound to the Tailscale interface, so the tailnet is the primary
 * boundary — this token is the second layer, so a compromised device on the
 * tailnet still can't drive the bot.
 */

/**
 * Compare in constant time. timingSafeEqual throws on length mismatch, which
 * would itself leak length, so hash both sides to a fixed width first.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getToken() {
  const token = process.env.CONTROL_API_TOKEN;
  if (!token || token.trim().length < 16) return null;
  return token.trim();
}

/** Pull the token from an Authorization header or a WebSocket query param. */
function extractToken(req) {
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  // WebSocket clients can't set headers in the browser API; allow ?token= for
  // the upgrade request only.
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q.trim();
  } catch {
    /* malformed URL — treat as no token */
  }
  return null;
}

function isAuthorized(req) {
  const expected = getToken();
  if (!expected) return false;
  const provided = extractToken(req);
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/** Express middleware. */
function requireAuth(req, res, next) {
  if (!getToken()) {
    return res.status(503).json({
      error: 'Control API token not configured. Set CONTROL_API_TOKEN in .env.',
    });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = { requireAuth, isAuthorized, getToken };
