'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { requireGuest, requireAdmin, roleFor, authorizeSocket, getAdminToken, getGuestPassword } = require('./auth');
const musicRoutes = require('./routes/music');
const { musicEvents, getPlaybackState } = require('../music/player');
const { primaryGuildId } = require('../config/guilds');

const PORT = Number(process.env.CONTROL_API_PORT) || 3005;
// Bind to the Tailscale interface by default, never 0.0.0.0 — the LAN and the
// wider internet should not be able to reach this at all.
const HOST = process.env.CONTROL_API_HOST || '127.0.0.1';

// While a track plays, position advances without any state event firing, so the
// progress bar needs a periodic nudge. Only ticks when someone is listening.
const TICK_MS = 2000;

/**
 * Start the control API. Returns null (without throwing) when unconfigured, so
 * a missing token can never take the Discord bot down with it.
 *
 * @param {import('discord.js').Client} client
 */
function startControlApi(client) {
  if (!getAdminToken()) {
    console.warn('[API] CONTROL_API_TOKEN missing or shorter than 16 chars — control API disabled.');
    return null;
  }
  if (!getGuestPassword()) {
    console.warn('[API] CONTROL_GUEST_PASSWORD not set — only the admin token will work.');
  }

  // The companion app drives one guild. Which one is explicit via
  // CONTROL_API_GUILD_ID, falling back to GUILD_ID for existing deployments.
  const guildId = primaryGuildId();
  if (!guildId) {
    console.warn('[API] No primary guild resolvable (set CONTROL_API_GUILD_ID or GUILD_ID) — control API disabled.');
    return null;
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Unauthenticated: lets the page check reachability before prompting for a
  // password. Deliberately exposes nothing about the guild or playback.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'sheogorath-control', ready: client.isReady() });
  });

  // Lets the page discover which tier a credential grants, so it can show or
  // hide admin-only controls. Returns the role rather than a bare yes/no.
  app.get('/api/auth/verify', requireGuest, (req, res) => {
    res.json({ ok: true, role: req.role });
  });

  // Music is communal — any friend with the guest password gets full control.
  app.use('/api/music', requireGuest, musicRoutes(client, guildId));

  // Moderation and server changes stay admin-only. Mounted now so the boundary
  // exists; routes get added here as those commands are built.
  const adminRouter = express.Router();
  adminRouter.get('/whoami', (req, res) => res.json({ role: req.role }));
  app.use('/api/admin', requireAdmin, adminRouter);

  // The control page itself, same origin as the API — no CORS, and it inherits
  // the Tailscale TLS certificate.
  app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    etag: true,
    // The page is a single self-contained file with no hashed asset names, so
    // a long max-age would leave everyone on a stale UI after each deploy.
    // no-cache still allows a 304 via etag — it just forces revalidation.
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  const server = http.createServer(app);

  // ---- WebSocket live state ----
  // noServer + manual upgrade so we can reject unauthorized sockets before the
  // handshake completes rather than accepting then closing.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/ws')) {
      socket.destroy();
      return;
    }
    const role = authorizeSocket(req);
    if (!role) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.role = role;
      wss.emit('connection', ws, req);
    });
  });

  function broadcast() {
    if (wss.clients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify({ type: 'state', data: getPlaybackState(guildId) });
    } catch (err) {
      console.error('[API] Failed to serialize state:', err?.message || err);
      return;
    }
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload, (err) => {
          if (err) console.error('[API] WS send failed:', err?.message || err);
        });
      }
    }
  }

  wss.on('connection', (ws) => {
    // Send current state immediately so the app renders without waiting for a
    // change or the next tick.
    try {
      ws.send(JSON.stringify({ type: 'state', data: getPlaybackState(guildId) }));
    } catch (err) {
      console.error('[API] WS initial send failed:', err?.message || err);
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => console.error('[API] WS client error:', err?.message || err));
  });

  // Drop sockets that stopped responding — phones suspend and silently vanish,
  // which would otherwise leak connections and keep the tick alive forever.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, 30000);
  heartbeat.unref();

  const onState = () => broadcast();
  musicEvents.on('state', onState);

  const tick = setInterval(broadcast, TICK_MS);
  tick.unref();

  server.on('error', (err) => {
    console.error('[API] Server error:', err?.message || err);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[API] Control API listening on http://${HOST}:${PORT}`);
  });

  return {
    server,
    close() {
      clearInterval(heartbeat);
      clearInterval(tick);
      musicEvents.off('state', onState);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close();
    },
  };
}

module.exports = { startControlApi };
