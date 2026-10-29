(function mini(attempt = 0) {
  const bridge = window.JshMiniBridge;
  if (!bridge) {
    if (!/mac/i.test(navigator.userAgentData?.platform || navigator.platform)) return;
    fetch('/extensions/mini-bridge.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Companion not installed');
        return response.json();
      })
      .then((config) => {
        if (
          !/^[a-f0-9]{64}$/.test(config.token) ||
          !Number.isInteger(config.port) ||
          config.port < 1024 ||
          config.port > 65535
        )
          throw new Error('Invalid mini bridge configuration');
        window.JshMiniBridge = config;
        mini();
      })
      .catch(() => {
        // Allow startup/apply recovery, then stay quiet when the companion is not installed.
        if (attempt < 5) setTimeout(() => mini(attempt + 1), Math.min(5000 * 2 ** attempt, 30000));
      });
    return;
  }
  const api = window.JshMusic;
  if (!api?.like || !api.love || !api.add || !Spicetify.Player?.data) {
    setTimeout(mini, 250);
    return;
  }

  const results = new Map();
  const skip = { __proto__: null, previous: 'back', next: 'next' };
  const seek = { __proto__: null, 'seek-back': 'skipBack', 'seek-forward': 'skipForward' };
  let timer;
  let eventTimer;
  const connectionAbort = new AbortController();
  let syncing = false;
  let dirty = false;
  let lastState = '';
  let resultVersion = 0;
  let sentResults = -1;
  let connectionVersion = 0;
  let retryDelay = 1000;
  let syncRetryDelay = 1000;
  let progress;
  let pendingSeek;
  let seeking = false;
  let stopped = false;
  const namespace = () => Spicetify.Platform?.LocalStorageAPI?.namespace || '';

  function state() {
    const item = Spicetify.Player.data?.item;
    const meta = item?.metadata || {};
    const uri = item?.uri || '';
    const supported = uri.startsWith('spotify:track:') && !meta.is_advertisement;
    return {
      account: namespace(),
      uri,
      supported,
      shuffle: Spicetify.Player.getShuffle?.() ?? null,
      position: Spicetify.Player.getProgress?.() ?? null,
      playing: Spicetify.Player.isPlaying?.() ?? Spicetify.Player.data?.isPaused === false,
      duration: Spicetify.Player.getDuration?.() ?? null,
      canSeek: supported && Spicetify.Player.data?.restrictions?.canSeek !== false &&
        typeof Spicetify.Player.seek === 'function',
      title: item?.name || meta.title || 'Nothing playing',
      artist:
        item?.artists
          ?.map((artist) => artist.name)
          .filter(Boolean)
          .join(', ') ||
        Object.entries(meta)
          .filter(([key]) => /^artist_name(?:_\d+)?$/.test(key))
          .map(([, name]) => name)
          .join(', ') ||
        'Artist unavailable',
      album: item?.album?.name || meta.album_title || 'Album unavailable',
      queueCount: api.play?.queueCount?.() ?? null,
      image: (
        meta.image_xlarge_url ||
        meta.image_large_url ||
        meta.image_url ||
        item?.album?.images?.[0]?.url ||
        ''
      ).replace('spotify:image:', 'https://i.scdn.co/image/'),
      liked: supported ? (api.like.state(uri) ?? null) : null,
      loved: supported ? (api.love.state(uri) ?? null) : null,
      added: supported ? (api.add.state?.(uri) ?? null) : null,
      removal: api.add.removalState(),
      playlistSelector: api.add.playlistSelection?.(),
    };
  }

  async function execute(command) {
    if (!command || typeof command.id !== 'string' || results.has(command.id)) return;
    results.set(command.id, null); // Reserve before awaiting: repeated deliveries cannot mutate twice.
    let result;
    try {
      const validate = () => {
        if (!Number.isFinite(command.expires) || Date.now() > command.expires)
          throw new Error('Shortcut expired; try again');
        if (!namespace() || command.account !== namespace())
          throw new Error('Spotify account changed');
        // Navigation stays valid across track changes so rapid repeated presses all apply.
        if (skip[command.action] || ['keys', 'queue', 'queue-toggle', 'shuffle', 'randomize'].includes(command.action)) return;
        if (command.uri !== Spicetify.Player.data?.item?.uri)
          throw new Error('Track changed; try again');
      };
      validate();
      if (command.value !== undefined && typeof command.value !== 'boolean')
        throw new Error('Invalid curation state');
      if (command.action === 'like')
        result = await api.like.toggle(command.uri, command.value, validate);
      else if (command.action === 'love')
        result = await api.love.toggle(command.uri, command.value, validate);
      else if (command.action === 'add') {
        api.add.toggle();
        result = { ok: true, message: '' };
      } else if (command.action === 'playlist') {
        result = await api.add.toggleSelectedPlaylist(command, validate);
      } else if (command.action === 'keys') {
        if (!api.keys) throw new Error('Shortcuts overlay unavailable');
        api.keys.toggle();
        result = { ok: true, message: '' };
      } else if (['queue', 'queue-toggle'].includes(command.action)) {
        if (!api.play) throw new Error('Queue unavailable');
        api.play.openQueue(command.action === 'queue-toggle');
        result = { ok: true, message: '' };
      } else if (skip[command.action]) {
        await Spicetify.Player[skip[command.action]]();
        result = { ok: true, message: '' };
      } else if (command.action === 'seek') {
        const duration = Spicetify.Player.getDuration();
        if (!command.uri.startsWith('spotify:track:') || Spicetify.Player.data?.item?.metadata?.is_advertisement ||
            Spicetify.Player.data?.restrictions?.canSeek === false ||
            !Number.isFinite(command.position) || command.position < 0 ||
            !Number.isFinite(duration) || duration <= 0)
          throw new Error('Seeking unavailable');
        await Spicetify.Player.seek(Math.floor(Math.min(command.position, duration - 1)));
        result = { ok: true, message: '' };
      } else if (seek[command.action]) {
        if (Spicetify.Player.data?.restrictions?.canSeek === false) throw new Error('Seeking unavailable');
        await Spicetify.Player[seek[command.action]](10000);
        result = { ok: true, message: '' };
      } else if (command.action === 'shuffle') {
        if (typeof command.value !== 'boolean' || Spicetify.Player.data?.restrictions?.canToggleShuffle === false)
          throw new Error('Shuffle unavailable');
        await Spicetify.Player.setShuffle(command.value);
        result = { ok: true, message: '' };
      } else if (command.action === 'randomize') {
        if (!api.play?.randomize) throw new Error('Random playback unavailable');
        await api.play.randomize(validate);
        result = { ok: true, message: '' };
      } else if (['remove', 'undo'].includes(command.action)) {
        const current = api.add.removalState();
        if (
          !current.enabled ||
          current.action !== command.action ||
          ['context', 'itemUid', 'provider', 'id'].some(
            (key) => current[key] !== command.removal?.[key],
          )
        )
          throw new Error('Playing playlist or Remove/Undo state changed');
        result = await api.add.changePlayingPlaylist(command.action, command.removal);
      } else throw new Error('Unknown mini player action');
    } catch (error) {
      result = { ok: false, message: error.message || 'Could not complete action' };
    }
    results.set(command.id, { id: command.id, ...result });
    resultVersion += 1;
    changed();
    if (results.size > 128) {
      const completed = [...results].find(([, value]) => value);
      if (completed) results.delete(completed[0]);
    }
  }

  function changed() {
    dirty = true;
    if (!stopped && !syncing && !timer) void sync();
  }

  async function receive(command) {
    if (command?.action !== 'seek') return execute(command);
    if (results.has(command.id)) return;
    pendingSeek = command;
    if (seeking) return;
    seeking = true;
    try {
      while (pendingSeek && !stopped) {
        const next = pendingSeek;
        pendingSeek = null;
        await execute(next);
      }
    } finally { seeking = false; }
  }

  async function sync() {
    syncing = true;
    dirty = false;
    try {
      const snapshot = state();
      const serialized = JSON.stringify(snapshot);
      const version = resultVersion;
      const connection = connectionVersion;
      const sentAt = Date.now();
      if (serialized === lastState && version === sentResults) return;
      const response = await fetch(`http://127.0.0.1:${bridge.port}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: snapshot, results: [...results.values()].filter(Boolean) }),
        signal: AbortSignal.any([connectionAbort.signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok) throw new Error(`Companion returned ${response.status}`);
      const data = await response.json();
      syncRetryDelay = 1000;
      if (connection === connectionVersion) {
        lastState = serialized;
        sentResults = version;
      }
      progress = { uri: snapshot.uri, position: snapshot.position, playing: snapshot.playing, time: sentAt };
      api.mini.shortcuts = data.shortcuts;
      for (const command of data.commands || []) void receive(command);
    } catch {
      if (!stopped) {
        timer = setTimeout(() => { timer = null; changed(); }, syncRetryDelay);
        syncRetryDelay = Math.min(syncRetryDelay * 2, 30000);
      }
    } finally {
      syncing = false;
      if (dirty && !stopped && !timer) changed();
    }
  }

  async function connect() {
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/events`, {
        headers: { Authorization: `Bearer ${bridge.token}` },
        signal: connectionAbort.signal,
      });
      if (!response.ok || !response.body) throw new Error('Companion event stream unavailable');
      retryDelay = 1000;
      syncRetryDelay = 1000;
      clearTimeout(timer);
      timer = null;
      connectionVersion += 1;
      lastState = '';
      changed();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Companion disconnected');
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 262144) throw new Error('Companion event too large');
          let boundary;
          while ((boundary = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 1);
            if (!line) continue;
            const data = JSON.parse(line);
            api.mini.shortcuts = data.shortcuts || api.mini.shortcuts;
            for (const command of data.commands || []) void receive(command);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      // Reconnect only after a broken connection; an idle stream sends no requests.
      if (!stopped) {
        eventTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    }
  }

  api.mini = { state, execute, changed };
  for (const event of ['songchange', 'onplaypause']) Spicetify.Player.addEventListener?.(event, changed);
  for (const event of ['update', 'queue_update'])
    Spicetify.Platform.PlayerAPI?.getEvents?.()?.addListener?.(event, changed);
  Spicetify.Player.addEventListener?.('onprogress', ({ data: position }) => {
    if (!progress || !Number.isFinite(position)) return;
    const expected = progress.position + (progress.playing ? Date.now() - progress.time : 0);
    if (Math.abs(position - expected) > 500) changed();
  });
  window.addEventListener(
    'pagehide',
    () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(eventTimer);
      connectionAbort.abort();
    },
    { once: true },
  );
  changed();
  void connect();
})();
