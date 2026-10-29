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
      .player-controls__left > .jsh-seek-back, .player-controls__right > .jsh-seek-forward { order: 1; }
      .player-controls__left > :is([data-testid="control-button-skip-back"], :has([data-testid="control-button-skip-back"])),
      .player-controls__right > :is([data-testid="control-button-repeat"], :has([data-testid="control-button-repeat"])) { order: 2; }
    `;
    document.head.append(style);
  }
  const playRoute =
    /^\/search\/spotifi-play-(library|180g|liked|playlist)-(sequential|shuffle|smart-shuffle)-/;
  const likedSongsUri = 'spotify:collection:tracks';
  const nowPlayingTarget = [
    '.main-nowPlayingWidget-trackInfo .main-trackInfo-name a',
    '.main-nowPlayingView-trackInfo .main-trackInfo-name a',
    '[data-testid="now-playing-widget"] .main-trackInfo-name a',
    // The v2 title has no stable class or test ID; exclude its artist byline.
    '[data-testid="now-playing-widget-v2"] a[href]:not([data-testid="now-playing-widget-v2-byline"] a)',
    '[data-testid="now-playing-widget"] [data-testid="cover-art-button"]',
    '[data-testid="now-playing-widget-v2"] [data-testid="cover-art-button"]',
    '[data-testid="cover-art-slot"] a[href]',
    '[data-testid="track-visual-enhancement"] a[data-testid="context-link"]',
    '[data-testid="NPV_Panel_OpenDiv"] .main-trackInfo-name a',
    // shortcut: NPV exposes only a hashed title class; replace when Spotify adds a stable selector.
    '.hvJdEwDFPYnCjweD6tWI > :first-child a',
  ].join(', ');

  if (!window.Spicetify || !Spicetify.Player?.playUri || !Spicetify.Platform?.History) {
    setTimeout(play, 250);
    return;
  }

  let handlingRoute = false;
  let lastSafePath = null;

  function queueCount() {
    // Spotify prefetches hidden tracks beyond the end of the visible queue.
    return Spicetify.Queue?.nextTracks?.filter(
      (track) => track.contextTrack?.metadata?.hidden !== 'true',
    ).length;
  }

  function openQueue(toggle = false) {
    const button = document.querySelector('[data-testid="now-playing-bar"] [data-testid="control-button-queue"]') ||
      document.querySelector('.main-nowPlayingBar-nowPlayingBar [data-testid="control-button-queue"]');
    if (!button || button.disabled) throw new Error('Queue unavailable');
    if (toggle || button.getAttribute('aria-pressed') !== 'true') button.click();
  }

  function decoratePlayer() {
    const bar = document.querySelector('[data-testid="now-playing-bar"]') || document.querySelector('.main-nowPlayingBar-nowPlayingBar');
    if (!bar) return;
    for (const [direction, method] of [['back', 'skipBack'], ['forward', 'skipForward']]) {
      const native = bar.querySelector(`[data-testid="control-button-skip-${direction}"]`);
      if (!native) continue;
      let button = bar.querySelector(`.jsh-seek-${direction}`);
      if (!button) {
        button = document.createElement('button');
        button.className = `${native.className} jsh-seek-${direction}`;
        button.type = 'button';
        button.title = button.ariaLabel = `${direction === 'back' ? 'Rewind' : 'Fast-forward'} 10 seconds`;
        button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><g transform="${direction === 'forward' ? 'translate(24 0) scale(-1 1)' : ''}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11a9 9 0 1 0 9-9c-2.5 0-4.8 1-6.5 2.5L3 7"></path><path d="M3 2v5h5"></path></g><text x="12" y="15" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="8" font-weight="600">10</text></svg>`;
        button.onclick = () => Spicetify.Player[method](10000);
      }
      // Spotify wraps individual controls; insert beside the wrapper in the
      // flex group so a tooltip wrapper cannot change the visual order.
      let group = native.closest(direction === 'back' ? '.player-controls__left' : '.player-controls__right');
      const controls = native.closest('[data-testid="general-controls"]');
      if (!group && controls) {
        group = native;
        while (group.parentElement && group.parentElement !== controls) group = group.parentElement;
      }
      let anchor = native;
      if (group) while (anchor.parentElement !== group) anchor = anchor.parentElement;
      if (direction === 'back') {
        if (anchor.previousElementSibling !== button) anchor.before(button);
      } else if (anchor.nextElementSibling !== button) anchor.after(button);
    }
    for (const button of bar.querySelectorAll('.jsh-seek-back, .jsh-seek-forward')) {
      const disabled = Spicetify.Player.data?.restrictions?.canSeek === false;
      if (button.disabled !== disabled) button.disabled = disabled;
    }

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
      if (!href && album.hasAttribute('href')) album.removeAttribute('href');
      const hidden = !href || !name;
      if (album.hidden !== hidden) album.hidden = hidden;
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
  Spicetify.Player.addEventListener?.('songchange', decoratePlayer);
  Spicetify.Platform.PlayerAPI?.getEvents?.()?.addListener?.('queue_update', decoratePlayer);
  const playerControls = '[data-testid="now-playing-bar"], .main-nowPlayingBar-nowPlayingBar, .main-nowPlayingWidget-trackInfo, [data-testid="control-button-queue"], [data-testid="control-button-shuffle"], [data-testid="control-button-skip-back"], [data-testid="control-button-skip-forward"]';
  new MutationObserver((records) => {
    if (records.some(({ target, addedNodes, removedNodes }) =>
      target.closest?.('.main-nowPlayingWidget-trackInfo') ||
      [...addedNodes, ...removedNodes].some((node) => node.nodeType === 1 &&
        (node.matches(playerControls) || node.querySelector(playerControls)))))
      decoratePlayer();
  }).observe(document.body, { childList: true, subtree: true });
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
    if (trackContext || (item.provider === 'queue' && !context.uri.startsWith('spotify:playlist:'))) contextUri = item.album?.uri || item.uri;
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
    // Spotify resolves playlist uid links by loading the entire list. Scroll by
    // a verified index instead so opening a large playlist remains responsive.
    if (item.uid != null && !contextUri.startsWith('spotify:playlist:')) params.set('uid', item.uid);
    params.set('uri', item.uri);
    if (index?.pageIndex != null) params.set('page', index.pageIndex);
    if (index?.pageURI != null) params.set('pageUri', index.pageURI);
    if (index?.itemIndex != null) params.set('index', index.itemIndex);
    if (trackContext) params.set('highlight', item.uri);
    return { pathname, search: `?${params}` };
  }

  function scrollOpenPlaylist(index) {
    const list = document.querySelector('.main-view-container .main-trackList-trackList') ||
      document.querySelector('.main-trackList-trackList');
    const key = list && Object.getOwnPropertyNames(list).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = key && list[key], depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
      const direct = fiber.ref?.current;
      if (typeof direct?.scrollToIndex === 'function') { direct.scrollToIndex(index); return true; }
      for (let hook = fiber.memoizedState, count = 0; hook && count < 100; hook = hook.next, count++) {
        const handle = hook.memoizedState?.current;
        if (typeof handle?.scrollToIndex === 'function') { handle.scrollToIndex(index); return true; }
      }
    }
    const scroller = list?.closest?.('[data-overlayscrollbars-viewport], .main-view-container__scroll-node');
    if (list && scroller && typeof getComputedStyle === 'function') {
      const rowHeight = parseFloat(getComputedStyle(list).getPropertyValue('--row-height'));
      if (Number.isFinite(rowHeight) && rowHeight > 0) {
        const header = list.querySelector?.('.main-trackList-trackListHeader');
        const top = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTop = Math.max(0, top + (header?.offsetHeight || 0) + index * rowHeight - scroller.clientHeight / 2);
        return true;
      }
    }
    return false;
  }

  function visiblePlayingRow(uri) {
    const list = document.querySelector('.main-view-container .main-trackList-trackList') ||
      document.querySelector('.main-trackList-trackList');
    const trackId = uri.startsWith('spotify:track:') ? uri.slice('spotify:track:'.length) : '';
    for (const row of list?.querySelectorAll?.('.main-trackList-trackListRow') || []) {
      const key = Object.getOwnPropertyNames(row).find((name) => name.startsWith('__reactFiber$'));
      for (let fiber = key && row[key], depth = 0; fiber && depth < 16; fiber = fiber.return, depth++) {
        const props = fiber.memoizedProps;
        if (props?.uri === uri || props?.item?.uri === uri) return row;
      }
      if (trackId && [...(row.querySelectorAll?.('a[href]') || [])].some((link) => {
        const href = link.getAttribute('href') || '';
        return href.split(/[?#]/)[0].replace(/\/$/, '').endsWith(`/track/${trackId}`);
      })) return row;
    }
    return null;
  }

  let jumpSequence = 0;
  // The playlist sort provider stores its per-playlist state under sortedState.
  // Keep the lightweight request in the same order as the rendered track list.
  function playlistSort(context) {
    let states = Spicetify.Platform.LocalStorageAPI?.getItem?.('sortedState');
    if (typeof states === 'string') { try { states = JSON.parse(states); } catch { return null; } }
    let sort = states?.[context];
    const list = document.querySelector('.main-view-container .main-trackList-trackList') ||
      document.querySelector('.main-trackList-trackList');
    const key = list && Object.getOwnPropertyNames(list).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = key && list[key], depth = 0; fiber && depth < 80; fiber = fiber.return, depth++) {
      const value = fiber.memoizedProps?.value;
      if (value && typeof value.setSortState === 'function' && 'sortState' in value) {
        sort = value.sortState;
        break;
      }
    }
    if (!sort) return null;
    if (sort.column) {
      const fields = { TITLE: 'TITLE', TITLE_COMPACT: 'TITLE', TITLE_AND_ARTIST: 'TITLE',
        ARTIST: 'ARTIST', ALBUM: 'ALBUM', ALBUM_OR_PODCAST: 'ALBUM', ADDED_AT: 'ADDED_AT',
        ADDED_BY: 'ADDED_BY', DURATION: 'DURATION', RELEASE_DATE: 'PUBLISH_DATE', TITLE_AND_AUTHOR: 'TITLE' };
      const field = sort.column === 'TITLE_AND_ARTIST' && [3, 4].includes(sort.order) ? 'ARTIST' : fields[sort.column];
      sort = { field, order: [1, 3].includes(sort.order) ? 'ASC' : [2, 4].includes(sort.order) ? 'DESC' : null };
    }
    const keys = { ALBUM: 7, ARTIST: 9, TITLE: 11, ADDED_AT: 13, ADDED_BY: 15,
      DURATION: 17, SHOW_NAME: 19, PUBLISH_DATE: 21 };
    if (!keys[sort.field] || !['ASC', 'DESC'].includes(sort.order)) throw new Error('Unknown playlist sort');
    return { field: sort.field, order: sort.order, sortBy: keys[sort.field] + (sort.order === 'DESC' ? 1 : 0) };
  }

  async function jumpToPlaylist(location, selection) {
    const sequence = ++jumpSequence;
    let position = selection.index?.itemIndex;
    const api = Spicetify.Platform.PlaylistAPI;
    if (!api?.getContents) {
      Spicetify.showNotification?.('Could not locate this track in the playing playlist', true);
      return;
    }
    try {
      const sort = playlistSort(selection.context);
      const sameSort = () => JSON.stringify(playlistSort(selection.context)) === JSON.stringify(sort);
      let restarting = false;
      const current = () => {
        if (sequence !== jumpSequence || Spicetify.Player.data?.context?.uri !== selection.context ||
            Spicetify.Player.data?.item?.uri !== selection.uri) return false;
        if (sameSort()) return true;
        if (!restarting) {
          restarting = true;
          setTimeout(() => { if (sequence === jumpSequence) void jumpToPlaylist(location, selection); }, 0);
        }
        return false;
      };
      if (!sort && Number.isInteger(position) && position >= 0) {
        const page = await api.getContents(selection.context, { offset: position, limit: 1 });
        if (!current()) return;
        if (page?.items?.[0]?.uri !== selection.uri) position = -1;
      } else position = -1;
      if (position < 0) {
        // Spotify's own playlist service supports a lightweight policy: fetch
        // only URIs and row IDs, without decorating thousands of tracks.
        const raw = api._playlistDataClient;
        if (typeof raw?.get === 'function') {
          try {
            const result = await raw.get({ uri: selection.context, query: { includeAllPlaceholders: true, ...(sort ? { sortBy: sort.sortBy } : {}) },
              policy: { item: { uri: true }, track: { rowId: true } } });
            if (!current()) return;
            if (Array.isArray(result?.data?.item)) {
              const items = result.data.item;
              const exact = selection.uid ? items.findIndex((row) => row?.rowId === selection.uid && row?.uri === selection.uri) : -1;
              position = exact >= 0 ? exact : items.findIndex((row) => row?.uri === selection.uri);
              if (position >= 0) {
                // The lightweight response can omit rows and compact their indices.
                const page = await api.getContents(selection.context, { offset: position, limit: 1,
                  ...(sort ? { sort: { field: sort.field, order: sort.order } } : {}) });
                if (!current()) return;
                const row = page?.items?.[0];
                if (row?.uri !== selection.uri || (selection.uid && row.uid !== selection.uid)) position = -1;
              }
            }
          } catch { position = -1; }
        }
        let offset = 0;
        while (position < 0 && offset < 50000 && current()) {
          const page = await api.getContents(selection.context, { offset, limit: 100,
            ...(sort ? { sort: { field: sort.field, order: sort.order } } : {}) });
          if (!current()) return;
          if (!Array.isArray(page?.items) || page.items.length === 0) break;
          const found = page.items.findIndex((row) => row?.uri === selection.uri && (!selection.uid || row.uid === selection.uid));
          if (found >= 0) { position = offset + found; break; }
          offset += page.items.length;
          if ((Number.isInteger(page.totalLength) && offset >= page.totalLength) ||
              (!Number.isInteger(page.totalLength) && page.items.length < 100)) break;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!current()) return;
        if (position < 0) throw new Error('Track not found');
      }
      const attempt = (remaining) => {
        if (!current()) return;
        const path = Spicetify.Platform.History.location?.pathname;
        if (path === location.pathname && scrollOpenPlaylist(position)) {
          // A virtualized list renders asynchronously. Do not treat assigning
          // scrollTop as success until Spotify actually renders the target row.
          const verify = (retries) => {
            if (!current() || Spicetify.Platform.History.location?.pathname !== location.pathname) return;
            const row = visiblePlayingRow(selection.uri);
            if (row) { row.scrollIntoView({ block: 'center', inline: 'nearest' }); return; }
            if (retries > 0) setTimeout(() => verify(retries - 1), 100);
            else Spicetify.showNotification?.('The playlist opened, but Spotify did not reveal the playing track', true);
          };
          verify(20);
          return;
        }
        if (remaining > 0) setTimeout(() => attempt(remaining - 1), 100);
        else Spicetify.showNotification?.('Could not scroll to this track in the playing playlist', true);
      };
      attempt(50);
    } catch {
      if (sequence === jumpSequence) Spicetify.showNotification?.('Could not locate this track in the playing playlist', true);
    }
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
      if (!event.target.closest(nowPlayingTarget)) return;
      const location = nowPlayingContextLocation();
      if (!location) return;
      event.preventDefault();
      event.stopPropagation();
      const data = Spicetify.Player.data;
      const context = data?.context?.uri;
      const item = data?.item;
      Spicetify.Platform.History.push(location);
      if (context?.startsWith('spotify:playlist:')) {
        void jumpToPlaylist(location, { context, uri: item.uri, uid: item.uid, index: data.index });
      } else jumpSequence++;
    },
    true,
  );

  Spicetify.Platform.History.listen(handleRoute);
  handleRoute();
})();
