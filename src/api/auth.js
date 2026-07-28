'use strict';
const crypto = require('crypto');

/**
 * Two-tier auth for the control API.
 *
 *   guest — CONTROL_GUEST_PASSWORD. Friends. Full music control: play, queue,
 *           skip, stop, volume, reorder. Music is communal.
 *   admin — CONTROL_API_TOKEN. Moderation and server changes (ban, kick, and
 *           anything else that alters the guild rather than the playlist).
 *
 * An admin token satisfies a guest requirement, so there's no need to hold two.
 *
 * This is reachable from the public internet via Tailscale Funnel, and the
 * hostname is discoverable in certificate-transparency logs, so a shared
 * password alone would be brute-forceable. Failed attempts are rate limited
 * per client below.
 */

const MIN_ADMIN_LEN = 16;
const MIN_GUEST_LEN = 8;

// ── brute-force throttle ──────────────────────────────────────────────────
// Only failures are counted, so ordinary use never trips it.
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;   // rolling window
const LOCKOUT_MS = 15 * 60 * 1000;  // block duration once tripped
const fails = new Map(); // ip -> { count, first, blockedUntil }

// Bound the map so a spray of spoofed sources can't grow it without limit.
const MAX_TRACKED = 5000;

function clientIp(req) {
  // Behind tailscale serve/funnel the socket address is always loopback, so
  // prefer the forwarded header it sets. Only the last hop is trustworthy.
  const fwd = req.headers?.['x-forwarded-for'];
  if (fwd) {
    const parts = String(fwd).split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isBlocked(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
  if (rec.blockedUntil && Date.now() >= rec.blockedUntil) {
    fails.delete(ip);
    return false;
  }
  return false;
}

function noteFailure(ip) {
  const now = Date.now();
  let rec = fails.get(ip);

  if (!rec || now - rec.first > WINDOW_MS) {
    rec = { count: 0, first: now, blockedUntil: 0 };
    if (fails.size >= MAX_TRACKED) {
      // Drop the oldest entry rather than letting the map grow unbounded.
      const oldest = fails.keys().next().value;
      if (oldest !== undefined) fails.delete(oldest);
    }
  }

  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.blockedUntil = now + LOCKOUT_MS;
    console.warn(`[API] Too many failed auth attempts from ${ip} — blocked for 15 minutes.`);
  }
  fails.set(ip, rec);
}

function noteSuccess(ip) {
  fails.delete(ip);
}

// ── credential comparison ─────────────────────────────────────────────────
/**
 * Constant-time compare. timingSafeEqual throws on length mismatch, which would
 * itself leak length, so hash both sides to a fixed width first.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getAdminToken() {
  const t = process.env.CONTROL_API_TOKEN;
  return t && t.trim().length >= MIN_ADMIN_LEN ? t.trim() : null;
}

function getGuestPassword() {
  const p = process.env.CONTROL_GUEST_PASSWORD;
  return p && p.trim().length >= MIN_GUEST_LEN ? p.trim() : null;
}

/** Pull the credential from an Authorization header or a WebSocket query param. */
function extractCredential(req) {
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  // Browsers can't set headers on a WebSocket handshake; allow ?token= there.
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q.trim();
  } catch {
    /* malformed URL — treat as absent */
  }
  return null;
}

/**
 * Resolve the caller's role.
 * @returns {'admin'|'guest'|null}
 */
function roleFor(req) {
  const provided = extractCredential(req);
  if (!provided) return null;

  const admin = getAdminToken();
  if (admin && safeEqual(provided, admin)) return 'admin';

  const guest = getGuestPassword();
  if (guest && safeEqual(provided, guest)) return 'guest';

  return null;
}

/**
 * Build a middleware requiring at least `level`.
 * Note: must NOT be named `require` — a hoisted function declaration by that
 * name shadows Node's module loader for the whole file.
 * @param {'guest'|'admin'} level
 */
function requireRole(level) {
  return (req, res, next) => {
    if (!getAdminToken()) {
      return res.status(503).json({ error: 'Control API not configured.' });
    }
    if (level === 'guest' && !getGuestPassword() && !getAdminToken()) {
      return res.status(503).json({ error: 'No guest password configured.' });
    }

    const ip = clientIp(req);
    const role = roleFor(req);

    // Deliberately check the credential before consulting the throttle. Behind
    // Funnel several clients can share an apparent source address, so blocking
    // on IP alone would let one bad actor lock every friend out. A correct
    // password always gets in; only wrong guesses are ever refused.
    if (!role) {
      if (isBlocked(ip)) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      }
      noteFailure(ip);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (level === 'admin' && role !== 'admin') {
      // A valid guest asking for admin is not a credential guess, so it isn't
      // counted against the throttle.
      return res.status(403).json({ error: 'That requires the admin token.' });
    }

    noteSuccess(ip);
    req.role = role;
    return next();
  };
}

const requireGuest = requireRole('guest');
const requireAdmin = requireRole('admin');

/** For the WebSocket upgrade, which can't use Express middleware. */
function authorizeSocket(req) {
  const ip = clientIp(req);
  const role = roleFor(req);
  // Same ordering as the HTTP path: a valid credential is never throttled.
  if (!role) {
    if (!isBlocked(ip)) noteFailure(ip);
    return null;
  }
  noteSuccess(ip);
  return role;
}

module.exports = {
  requireGuest,
  requireAdmin,
  roleFor,
  authorizeSocket,
  getAdminToken,
  getGuestPassword,
  clientIp,
};
