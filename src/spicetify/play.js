(function play() {
  // Install before Spotify is ready so newly rendered quality text never paints.
  if (!document.querySelector('#jsh-player-style')) {
    const style = document.createElement('style');
    style.id = 'jsh-player-style';
    style.textContent = `
      .main-nowPlayingWidget-trackInfo .main-trackInfo-overlay:has(button) { display: none !important; }
      .jsh-playing-album { grid-area: quality; font-size: 12px; color: var(--text-subdued, #b3b3b3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .jsh-playing-album:hover { color: var(--text-base, #fff); text-decoration: underline; }
      .jsh-playing-album:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
      .jsh-queue-button { position: relative; overflow: visible; }
      .jsh-queue-count { position: absolute; top: -2px; right: -5px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 999px; background: #1db954; color: #000; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; pointer-events: none; }
      .jsh-queue-count:empty { display: none; }
    `;
    document.head.append(style);
  }
  const playRoute =
    /^\/search\/spotifi-play-(library|180g|liked|playlist)-(sequential|shuffle|smart-shuffle)-/;
  const likedSongsUri = 'spotify:collection:tracks';
  const nowPlayingTitle = [
    '.main-nowPlayingWidget-trackInfo .main-trackInfo-name a',
    '.main-nowPlayingView-trackInfo .main-trackInfo-name a',
  ].join(', ');

  if (!window.Spicetify || !Spicetify.Player?.playUri || !Spicetify.Platform?.History) {
    setTimeout(play, 250);
    return;
  }

  let handlingRoute = false;
  let lastSafePath = null;
  let observedBar;

  function queueCount() {
    // Spotify prefetches hidden tracks beyond the end of the visible queue.
    return Spicetify.Queue?.nextTracks?.filter(
      (track) => track.contextTrack?.metadata?.hidden !== 'true',
    ).length;
  }

  function openQueue(toggle = false) {
    const button = document.querySelector('.main-nowPlayingBar-nowPlayingBar [data-testid="control-button-queue"]');
    if (!button || button.disabled) throw new Error('Queue unavailable');
    if (toggle || button.getAttribute('aria-pressed') !== 'true') button.click();
  }

  function decoratePlayer() {
    const bar = document.querySelector('.main-nowPlayingBar-nowPlayingBar');
    if (!bar) return;
    if (observedBar !== bar) {
      observedBar = bar;
      new MutationObserver(decoratePlayer).observe(bar, { childList: true, subtree: true });
    }
    for (const [direction, method] of [['back', 'skipBack'], ['forward', 'skipForward']]) {
      const native = bar.querySelector(`[data-testid="control-button-skip-${direction}"]`);
      if (!native || bar.querySelector(`.jsh-seek-${direction}`)) continue;
      const button = document.createElement('button');
      button.className = `${native.className} jsh-seek-${direction}`;
      button.type = 'button';
      button.title = button.ariaLabel = `${direction === 'back' ? 'Rewind' : 'Fast-forward'} 10 seconds`;
      button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><g transform="${direction === 'forward' ? 'translate(24 0) scale(-1 1)' : ''}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11a9 9 0 1 0 9-9c-2.5 0-4.8 1-6.5 2.5L3 7"></path><path d="M3 2v5h5"></path></g><text x="12" y="15" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="8" font-weight="600">10</text></svg>`;
      button.onclick = () => Spicetify.Player[method](10000);
      if (direction === 'back') native.before(button);
      else native.after(button);
    }
    for (const button of bar.querySelectorAll('.jsh-seek-back, .jsh-seek-forward'))
      button.disabled = Spicetify.Player.data?.restrictions?.canSeek === false;

    const info = bar.querySelector('.main-nowPlayingWidget-trackInfo');
    if (info && !info.querySelector('.jsh-playing-album')) {
      const album = document.createElement('a');
      album.className = 'jsh-playing-album';
      info.append(album);
    }
    const album = info?.querySelector('.jsh-playing-album');
    const item = Spicetify.Player.data?.item;
    const albumUri = item?.album?.uri || item?.metadata?.album_uri;
    if (album) {
      const name = item?.album?.name || item?.metadata?.album_title || '';
      if (album.textContent !== name) album.textContent = name;
      const href = albumUri?.startsWith('spotify:album:') ? Spicetify.URI.fromString(albumUri).toURLPath(true) : '';
      if (href && album.getAttribute('href') !== href) album.setAttribute('href', href);
      if (!href) album.removeAttribute('href');
      album.hidden = !href || !name;
    }
    const queue = bar.querySelector('[data-testid="control-button-queue"]');
    if (queue && !queue.querySelector('.jsh-queue-count')) {
      queue.classList.add('jsh-queue-button');
      const count = document.createElement('span');
      count.className = 'jsh-queue-count';
      count.id = 'jsh-queue-count';
      queue.setAttribute('aria-describedby', count.id);
      queue.append(count);
    }
    const count = queue?.querySelector('.jsh-queue-count');
    const remaining = queueCount();
    const value = remaining > 0 ? String(remaining) : '';
    if (count && count.textContent !== value) {
      count.textContent = value;
      count.ariaLabel = value ? `${value} ${remaining === 1 ? 'track' : 'tracks'} remaining in queue` : '';
    }
  }

  window.JshMusic ||= {};
  window.JshMusic.play = { queueCount, openQueue, randomize: (validate) => playSelection('randomize', 'current', validate) };
  setInterval(decoratePlayer, 1000);
  decoratePlayer();

  function playlistsFrom(rows) {
    const playlists = [];

    function visit(items) {
      for (const item of items || []) {
        if (!item) continue;
        const uri = item.link || item.uri;
        if (item.type === 'playlist' && uri?.startsWith('spotify:playlist:')) {
          playlists.push({ name: item.name, uri });
        }
        visit(item.rows || item.items);
      }
    }

    visit(rows);
    return [...new Map(playlists.map((playlist) => [playlist.uri, playlist])).values()];
  }

  function playlistSources(playlists) {
    return [likedSongsUri, ...playlists.map((playlist) => playlist.uri)];
  }

  async function platformAPI(name, method) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const api = Spicetify.Platform[name];
      if (typeof api?.[method] === 'function') return api;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Spotify ${name} is not ready`);
  }

  async function loadPlaylists() {
    const rootlistAPI = await platformAPI('RootlistAPI', 'getContents');
    const root = await rootlistAPI.getContents();
    return playlistsFrom(root?.items || root?.rows);
  }

  function randomItem(items) {
    return items[randomIndex(items.length)];
  }

  function randomIndex(length) {
    const value = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / length) * length;
    do window.crypto.getRandomValues(value);
    while (value[0] >= limit);
    return value[0] % length;
  }

  function locationPath(location) {
    return `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`;
  }

  function showContext(uri) {
    const path = Spicetify.URI.fromString(uri).toURLPath(true);
    lastSafePath = path;
    Spicetify.Platform.History.replace(path);
  }

  async function trackCount(uri) {
    if (uri === likedSongsUri) {
      const libraryAPI = await platformAPI('LibraryAPI', 'getTracks');
      const response = await libraryAPI.getTracks({ offset: 0, limit: 50000 });
      return response.items?.length;
    }

    const playlistAPI = await platformAPI('PlaylistAPI', 'getContents');
    const response = await playlistAPI.getContents(uri, { offset: 0, limit: 1 });
    return response.totalLength;
  }

  async function randomNonemptySource(sources) {
    const remaining = [...sources];

    while (remaining.length) {
      const uri = randomItem(remaining);
      remaining.splice(remaining.indexOf(uri), 1);
      const count = await trackCount(uri);
      if (!Number.isInteger(count) || count < 1) continue;
      return { count, uri };
    }

    throw new Error('No tracks found in the selected source');
  }

  async function selectPlayback(selector) {
    if (selector === 'liked') {
      const selected = await randomNonemptySource([likedSongsUri]);
      return { uri: selected.uri, index: randomIndex(selected.count) };
    }

    const playlists = await loadPlaylists();

    if (selector === 'playlist' || selector === 'randomize') {
      const selected = await randomNonemptySource(playlists.map((playlist) => playlist.uri));
      return { uri: selected.uri, ...(selector === 'randomize' ? { index: randomIndex(selected.count) } : {}) };
    }

    if (selector === '180g') {
      const playlist = playlists.find((item) => item.name?.toLowerCase() === '180g');
      if (!playlist) throw new Error('The 180g playlist was not found');

      const playlistAPI = await platformAPI('PlaylistAPI', 'getContents');
      const response = await playlistAPI.getContents(playlist.uri, { offset: 0, limit: 50000 });
      const albums = [
        ...new Set((response.items || []).map((item) => item.album?.uri).filter(Boolean)),
      ];
      if (!albums.length) throw new Error('No albums found in the 180g playlist');
      return { uri: randomItem(albums) };
    }

    const selected = await randomNonemptySource(playlistSources(playlists));
    return { uri: selected.uri, index: randomIndex(selected.count) };
  }

  async function setPlaybackMode(uri, mode) {
    if (mode === 'sequential') {
      Spicetify.Player.setShuffle(false);
      return;
    }

    if (mode === 'shuffle') {
      Spicetify.Player.setShuffle(true);
      return;
    }

    const contextualShuffle = Spicetify.Player.origin?._contextualShuffle;
    if (typeof contextualShuffle?.setContextualShuffleMode !== 'function') {
      throw new Error('Smart Shuffle is not available in this Spotify client');
    }
    await contextualShuffle.setContextualShuffleMode(uri, 2);
  }

  async function playSelection(selector, mode, validate = () => {}) {
    const selection = await selectPlayback(selector);
    validate();
    if (mode === 'current') mode = Spicetify.Player.getShuffle() ? 'shuffle' : 'sequential';
    Spicetify.Player.setShuffle(false);
    if (Number.isInteger(selection.index)) {
      await Spicetify.Player.playUri(selection.uri, {}, { skipTo: { index: selection.index } });
    } else {
      await Spicetify.Player.playUri(selection.uri);
    }
    await setPlaybackMode(selection.uri, mode);
    showContext(selection.uri);
  }

  async function handleRoute(location = Spicetify.Platform.History.location) {
    const pathname = location?.pathname;
    const route = pathname?.match(playRoute);
    if (!route) {
      if (!handlingRoute && pathname) lastSafePath = locationPath(location);
      return;
    }
    if (handlingRoute) return;

    handlingRoute = true;
    Spicetify.Platform.History.replace(lastSafePath || '/');
    try {
      await playSelection(route[1], route[2]);
    } catch (error) {
      console.error('[play] Failed to select playback', error);
      Spicetify.showNotification(`Play: ${error.message}`, true);
    } finally {
      handlingRoute = false;
    }
  }

  function nowPlayingContextLocation() {
    const { context, item, index } = Spicetify.Player.data || {};
    if (!context?.uri || !item?.uri) return null;

    // Match Spotify's Go to Now Playing shortcut, including the page and row position.
    const trackContext = context.uri.startsWith('spotify:track:');
    let contextUri = context.uri;
    if (trackContext || item.provider === 'queue') contextUri = item.album?.uri || item.uri;
    if (contextUri === 'spotify:internal:local-files' || contextUri === 'spotify:local-files') {
      contextUri = 'spotify:collection:local-files';
    }

    let pathname;
    try {
      pathname = Spicetify.URI.fromString(contextUri).toURLPath(true);
    } catch {
      return null;
    }
    if (!pathname) return null;

    const params = new URLSearchParams();
    if (item.uid != null) params.set('uid', item.uid);
    params.set('uri', item.uri);
    if (index?.pageIndex != null) params.set('page', index.pageIndex);
    if (index?.pageURI != null) params.set('pageUri', index.pageURI);
    if (index?.itemIndex != null) params.set('index', index.itemIndex);
    if (trackContext) params.set('highlight', item.uri);
    return { pathname, search: `?${params}` };
  }

  window.addEventListener(
    'click',
    (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (!(event.target instanceof Element)) return;
      const album = event.target.closest('.jsh-playing-album');
      if (album?.getAttribute('href')) {
        event.preventDefault();
        event.stopPropagation();
        Spicetify.Platform.History.push(album.getAttribute('href'));
        return;
      }
      if (!event.target.closest(nowPlayingTitle)) return;
      const location = nowPlayingContextLocation();
      if (!location) return;
      event.preventDefault();
      event.stopPropagation();
      Spicetify.Platform.History.push(location);
    },
    true,
  );

  Spicetify.Platform.History.listen(handleRoute);
  handleRoute();
})();
