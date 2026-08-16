'use strict';
const express = require('express');
const {
  getQueue,
  addToQueue,
  clearQueue,
  removeFromQueue,
  moveInQueue,
  getNextSong,
  beginPlayback,
  endPlayback,
  resolveVideoUrl,
  pausePlaying,
  resumePlaying,
  skipSong,
  stopPlaying,
  setVolume,
  setAutoplay,
  getPlaybackState,
  expandPlaylist,
} = require('../../music/player');
const { ensureVoiceConnection, startPlayback } = require('../../music/session');

const PLAYLIST_URL = /^https?:\/\/.*(youtube\.com|youtu\.be).*[?&]list=/;

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId primary guild the app controls
 */
module.exports = function musicRoutes(client, guildId) {
  const router = express.Router();

  // Every handler needs the same try/catch → JSON error shape.
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('[API] music route error:', err?.message || err);
      res.status(500).json({ error: err?.message || 'Internal error' });
    }
  };

  router.get('/state', handle(async (req, res) => {
    res.json(getPlaybackState(guildId));
  }));

  /**
   * Queue a track (or playlist) by URL or search phrase. Starts playback
   * immediately when idle, otherwise appends.
   */
  router.post('/play', handle(async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const connection = await ensureVoiceConnection(client, guildId);
    const queue = getQueue(guildId);
    const addedBy = req.body?.addedBy || 'Control App';

    if (PLAYLIST_URL.test(query)) {
      const playlist = await expandPlaylist(query);
      if (!playlist || playlist.songs.length === 0) {
        return res.status(422).json({ error: 'Could not load that playlist, or it is empty.' });
      }
      for (const song of playlist.songs) {
        addToQueue(guildId, { query: song.query, title: song.title, addedBy });
      }
      if (beginPlayback(guildId)) {
        const first = getNextSong(guildId);
        if (first) await startPlayback(client, connection, guildId, first);
        else endPlayback(guildId);
      }
      return res.json({
        ok: true,
        kind: 'playlist',
        title: playlist.title,
        added: playlist.songs.length,
        totalCount: playlist.totalCount,
        state: getPlaybackState(guildId),
      });
    }

    // Resolve first so the queue entry carries a real title and the exact
    // resolved URL rather than the raw search phrase — the app renders the
    // title directly, and re-searching at playback time could pick a different
    // video than the one we reported here.
    let title = query;
    let resolvedQuery = query;
    try {
      const resolved = await resolveVideoUrl(query);
      title = resolved.title;
      resolvedQuery = resolved.url;
    } catch {
      /* keep the raw query as the display title and as the thing we play */
    }
    const entry = { query: resolvedQuery, title, addedBy };
    addToQueue(guildId, entry);

    if (!beginPlayback(guildId)) {
      return res.json({
        ok: true,
        kind: 'queued',
        title,
        position: queue.songs.indexOf(entry) + 1,
        state: getPlaybackState(guildId),
      });
    }

    // Start from the head of the queue, so anything already waiting there is
    // not jumped by this request.
    const first = getNextSong(guildId);
    if (!first) {
      endPlayback(guildId);
      return res.status(409).json({ error: 'Nothing in the queue to play.' });
    }
    await startPlayback(client, connection, guildId, first);
    return res.json({
      ok: true, kind: 'playing', title: first.title || first.query, state: getPlaybackState(guildId),
    });
  }));

  /** Resolve a search phrase without queueing it, for the app's search screen. */
  router.post('/search', handle(async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'query is required' });
    const result = await resolveVideoUrl(query);
    res.json({ ok: true, result });
  }));

  router.post('/pause', handle(async (req, res) => {
    const ok = pausePlaying(guildId);
    res.json({ ok, state: getPlaybackState(guildId) });
  }));

  router.post('/resume', handle(async (req, res) => {
    const ok = resumePlaying(guildId);
    res.json({ ok, state: getPlaybackState(guildId) });
  }));

  router.post('/skip', handle(async (req, res) => {
    const ok = skipSong(guildId);
    res.json({ ok, state: getPlaybackState(guildId) });
  }));

  router.post('/stop', handle(async (req, res) => {
    stopPlaying(guildId);
    res.json({ ok: true, state: getPlaybackState(guildId) });
  }));

  router.post('/volume', handle(async (req, res) => {
    const level = Number(req.body?.level);
    if (!Number.isFinite(level)) {
      return res.status(400).json({ error: 'level must be a number between 0 and 2' });
    }
    setVolume(guildId, level);
    res.json({ ok: true, state: getPlaybackState(guildId) });
  }));

  router.post('/autoplay', handle(async (req, res) => {
    // Toggle when no explicit value is supplied.
    const enabled = typeof req.body?.enabled === 'boolean'
      ? req.body.enabled
      : !getQueue(guildId).autoplay;
    setAutoplay(guildId, enabled);
    res.json({ ok: true, autoplay: enabled, state: getPlaybackState(guildId) });
  }));

  router.get('/queue', handle(async (req, res) => {
    const state = getPlaybackState(guildId);
    res.json({ queue: state.queue, nowPlaying: state.nowPlaying });
  }));

  router.delete('/queue', handle(async (req, res) => {
    clearQueue(guildId);
    res.json({ ok: true, state: getPlaybackState(guildId) });
  }));

  router.delete('/queue/:index', handle(async (req, res) => {
    const index = Number.parseInt(req.params.index, 10);
    if (!Number.isInteger(index)) {
      return res.status(400).json({ error: 'index must be an integer' });
    }
    const removed = removeFromQueue(guildId, index);
    if (!removed) return res.status(404).json({ error: 'No queued song at that index' });
    res.json({ ok: true, removed: removed.title || removed.query, state: getPlaybackState(guildId) });
  }));

  router.post('/queue/move', handle(async (req, res) => {
    const from = Number.parseInt(req.body?.from, 10);
    const to = Number.parseInt(req.body?.to, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return res.status(400).json({ error: 'from and to must be integers' });
    }
    const moved = moveInQueue(guildId, from, to);
    if (!moved) return res.status(400).json({ error: 'Index out of range' });
    res.json({ ok: true, moved: moved.title || moved.query, state: getPlaybackState(guildId) });
  }));

  return router;
};
