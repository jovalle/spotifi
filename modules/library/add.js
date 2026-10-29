(function add() {
  if (!window.Spicetify?.Player || !Spicetify.ContextMenu) {
    setTimeout(add, 250);
    return;
  }

  const OVERLAY_ID = 'adder';
  const RESULT_LIMIT = 100;
  let activeOverlay = null;
  let addScanQueued = false;

  function account() {
    return Spicetify.Platform?.LocalStorageAPI?.namespace || '';
  }

  // One undo record follows the active playback occurrence, including pause/resume.
  let removalIdentity = '';
  let removal = null;
  let restoredUid = '';
  let removalBusy = false;
  let capabilities = null;
  let removalSequence = 0;
  let deferred = null;
  let deferredEntry = null;
  const deferredListeners = new Set();
  const hideFormats = new Set(['artistsets', 'artist-mix-reader', 'blend', 'daily-mix', 'daylist',
    'discover-weekly', 'descripto', 'inspiredby-mix', 'on-repeat', 'release-radar',
    'repeat-rewind', 'topic-mix']);

  function notifyDeferred() {
    for (const listener of deferredListeners) listener();
  }

  function feedbackAPI() {
    try {
      return Spicetify.Platform?.FeedbackAPI || Spicetify.Platform?.Registry?.resolve?.(Symbol.for('FeedbackAPI'));
    } catch {
      return null;
    }
  }

  function deferredState() {
    const selection = playingSelection();
    const metadata = capabilities?.key === `${selection.account}:${selection.context}` ? capabilities.value : null;
    // Start the shared asynchronous metadata lookup.
    removalState();
    const feedback = feedbackAPI();
    const format = Spicetify.Player.data?.context?.metadata?.format_list_type || metadata?.format_list_type || metadata?.metadata?.format_list_type || metadata?.formatListData?.type;
    const validContext = validPlaylistContext(selection);
    const contextEntry = validPlaylistContext(selection);
    const queueEntry = validQueueContext(selection);
    const entryKey = JSON.stringify(selection);
    if (((contextEntry && !selection.itemUid) || queueEntry) && (!deferredEntry || deferredEntry.key !== entryKey)) {
      const request = { key: entryKey, uid: '', loading: true };
      deferredEntry = request;
      playlistRows(selection.context).then((rows) => {
        const matches = rows.filter((row) => row.uri === selection.uri);
        if (queueEntry && selection.itemUid && matches.some((row) => row.uid === selection.itemUid))
          request.uid = selection.itemUid;
        else if (matches.length === 1 && matches[0].uid) request.uid = matches[0].uid;
      }).catch(() => {
        setTimeout(() => {
          if (deferredEntry === request) { deferredEntry = null; notifyDeferred(); }
        }, 10000);
      }).finally(() => {
        request.loading = false;
        if (deferredEntry === request) notifyDeferred();
      });
    }
    const resolvedUid = queueEntry ? (deferredEntry?.key === entryKey ? deferredEntry.uid : '') :
      selection.itemUid || (deferredEntry?.key === entryKey ? deferredEntry.uid : '');
    const valid = validSelection(selection) || ((contextEntry || queueEntry) && resolvedUid);
    let mode = null;
    if (valid && metadata?.canRemove === true && Spicetify.Platform?.PlaylistAPI?.remove && Spicetify.Platform?.PlaylistAPI?.getContents) mode = 'remove';
    else if (validContext && metadata?.canRemove === false &&
      hideFormats.has(format) && feedback?.getCapabilities?.()?.canBan === true &&
      typeof feedback.addContextTrackBan === 'function') mode = 'hide';
    return { ...selection, mode, resolvedUid, selected: Boolean(deferred && sameDeferredSelection(deferred.selection, selection)) };
  }

  function sameDeferredSelection(a, b) {
    return a.account === b.account && a.context === b.context && a.uri === b.uri &&
      a.provider === b.provider && (!a.itemUid || !b.itemUid || a.itemUid === b.itemUid);
  }

  function toggleDeferred() {
    const state = deferredState();
    if (!state.mode) return;
    deferred = state.selected ? null : { selection: playingSelection(), mode: state.mode, targetUid: state.resolvedUid };
    notifyDeferred();
  }

  async function executeDeferred(job) {
    const { selection, mode, targetUid } = job;
    try {
      if (account() !== selection.account) throw new Error('Spotify account changed');
      const api = Spicetify.Platform.PlaylistAPI;
      const metadata = await api.getMetadata(selection.context);
      if (account() !== selection.account) throw new Error('Spotify account changed');
      if (mode === 'remove') {
        if (metadata?.canRemove !== true) throw new Error('Playlist permission changed');
        const rows = await playlistRows(selection.context);
        if (account() !== selection.account) throw new Error('Spotify account changed');
        const target = { uri: selection.uri, uid: targetUid };
        if (!rows.some((row) => sameRow(row, target))) throw new Error('Playlist entry no longer exists');
        await api.remove(selection.context, [target]);
        if ((await playlistRows(selection.context)).some((row) => sameRow(row, target)))
          throw new Error('Spotify did not remove the playlist entry');
      } else {
        const feedback = feedbackAPI();
        if (metadata?.canRemove !== false || feedback?.getCapabilities?.()?.canBan !== true ||
            typeof feedback.addContextTrackBan !== 'function') throw new Error('Hide is unavailable');
        await feedback.addContextTrackBan(selection.context, selection.uri, selection.provider);
      }
      Spicetify.showNotification?.(`${mode === 'hide' ? 'Hidden in' : 'Removed from'} ${metadata.name || 'playing playlist'}`);
    } catch (error) {
      Spicetify.showNotification?.(`Could not ${mode} track: ${error.message || 'Check Spotify'}`, true);
    }
  }

  function deferredSongChange() {
    if (deferred) {
      const current = playingSelection();
      if (current.account && current.context && current.uri && !sameDeferredSelection(current, deferred.selection)) {
        const job = deferred;
        deferred = null;
        if (current.account === job.selection.account) void executeDeferred(job);
      }
    }
    notifyDeferred();
  }

  function playingSelection() {
    const data = Spicetify.Player.data;
    const item = data?.item;
    return {
      account: account(),
      context: data?.context?.uri || '',
      uri: item?.uri || '',
      itemUid: item?.uid || '',
      provider: item?.provider || '',
    };
  }

  function observeRemoval() {
    const playing = playingSelection();
    const identity = JSON.stringify(playing);
    if (identity !== removalIdentity) {
      removalIdentity = identity;
      removal = null;
      restoredUid = '';
    }
    return playing;
  }

  function validSelection(playing) {
    return (
      playing.account &&
      /^spotify:playlist:[a-zA-Z0-9]+$/.test(playing.context) &&
      isTrack(playing.uri) &&
      typeof playing.itemUid === 'string' &&
      playing.itemUid &&
      !['queue', 'autoplay'].includes(playing.provider) &&
      !Spicetify.Player.data?.item?.metadata?.is_advertisement
    );
  }

  function validPlaylistContext(playing) {
    return Boolean(playing.account && /^spotify:playlist:[a-zA-Z0-9]+$/.test(playing.context) &&
      isTrack(playing.uri) && playing.provider === 'context' &&
      !Spicetify.Player.data?.item?.metadata?.is_advertisement);
  }

  function validQueueContext(playing) {
    return Boolean(playing.account && /^spotify:playlist:[a-zA-Z0-9]+$/.test(playing.context) &&
      isTrack(playing.uri) && playing.provider === 'queue' &&
      !Spicetify.Player.data?.item?.metadata?.is_advertisement);
  }

  function removalState() {
    const playing = observeRemoval();
    const api = Spicetify.Platform?.PlaylistAPI;
    const key = `${playing.account}:${playing.context}`;
    if (
      (validSelection(playing) || validPlaylistContext(playing) || validQueueContext(playing)) &&
      api?.getMetadata &&
      (!capabilities || capabilities.key !== key ||
        (capabilities.value === null && Date.now() - capabilities.time > 30000))
    ) {
      const request = { key, time: Date.now(), value: null };
      capabilities = request;
      api
        .getMetadata(playing.context)
        .then((value) => {
          request.value = value;
          window.JshMusic?.mini?.changed?.();
          notifyDeferred();
        })
        .catch(() => {
          setTimeout(() => { if (capabilities === request) { window.JshMusic?.mini?.changed?.(); notifyDeferred(); } }, 30000);
        });
    }
    const permissions = capabilities?.key === key ? capabilities.value : null;
    return {
      ...playing,
      action: removal ? 'undo' : 'remove',
      id: removal?.id || '',
      enabled: Boolean(
        validSelection(playing) &&
        api?.getContents &&
        api?.remove &&
        api?.add &&
        permissions?.canAdd === true &&
        permissions?.canRemove === true &&
        !removalBusy,
      ),
      playlistName: permissions?.name || 'playing playlist',
      reason: !validSelection(playing)
        ? 'Play an entry from a writable playlist'
        : removalBusy
          ? 'Playlist update in progress'
          : 'Playlist permissions unavailable',
    };
  }

  function assertPlaying(expected) {
    const current = observeRemoval();
    if (
      !validSelection(current) ||
      ['account', 'context', 'uri', 'itemUid', 'provider'].some(
        (key) => expected[key] !== current[key],
      )
    )
      throw new Error('Playing playlist entry changed; try again');
  }

  async function playlistRows(context) {
    const api = Spicetify.Platform?.PlaylistAPI;
    const rows = [];
    let total;
    for (let offset = 0; offset <= 10000; offset += 100) {
      const page = await api.getContents(context, { offset, limit: 100 });
      if (!Array.isArray(page?.items)) throw new Error('Cannot verify playlist contents');
      if (offset && page.items[0]?.uid && page.items[0].uid === rows[offset - 100]?.uid)
        throw new Error('Spotify did not paginate playlist contents');
      if (Number.isInteger(page.totalLength)) {
        if (total !== undefined && total !== page.totalLength)
          throw new Error('Playlist changed during lookup; try again');
        total = page.totalLength;
      }
      rows.push(...page.items);
      if (page.items.length < 100) {
        if (total !== undefined && total !== rows.length)
          throw new Error('Playlist contents are incomplete');
        return rows;
      }
    }
    throw new Error('Cannot verify the entire playlist');
  }

  const sameRow = (row, target) =>
    Boolean(row?.uid && target.uid && row.uid === target.uid && row.uri === target.uri);
  const trackUids = (rows, uri) => rows.filter((row) => row?.uri === uri).map((row) => row.uid);

  function undoPosition(rows, record) {
    const previous = rows.findIndex((row) => sameRow(row, record.previous || {}));
    const next = rows.findIndex((row) => sameRow(row, record.next || {}));
    let position;
    if (previous >= 0 && next >= 0 && previous >= next)
      throw new Error('Playlist order changed; cannot restore the original position');
    if (next >= 0) position = { before: record.next };
    else if (previous >= 0) position = { after: record.previous };
    else if (record.count === 1 && rows.length === 0) position = { before: 'start' };
    else throw new Error('Original playlist neighbors are gone; cannot restore the position');
    return position;
  }

  function restoredInPosition(rows, row, record) {
    const position = undoPosition(
      rows.filter((item) => item !== row),
      record,
    );
    const index = rows.indexOf(row);
    if (position.before === 'start') return index === 0;
    if (position.before)
      return index + 1 === rows.findIndex((item) => sameRow(item, position.before));
    return index === rows.findIndex((item) => sameRow(item, position.after)) + 1;
  }

  async function changePlayingPlaylist(action, expected) {
    if (removalBusy) return { ok: false, message: 'Playlist update in progress' };
    removalBusy = true;
    let wrote = false;
    try {
      assertPlaying(expected);
      if ((removal ? 'undo' : 'remove') !== action || (removal?.id || '') !== expected.id)
        throw new Error('Remove/Undo state changed; try again');
      const api = Spicetify.Platform.PlaylistAPI;
      const permissions = await api.getMetadata(expected.context);
      if (permissions?.canRemove !== true || permissions?.canAdd !== true)
        throw new Error('Playing playlist does not allow Remove and Undo');
      const rows = await playlistRows(expected.context);
      assertPlaying(expected);
      if (action === 'remove') {
        const target = { uri: expected.uri, uid: restoredUid || expected.itemUid };
        const index = rows.findIndex((row) => sameRow(row, target));
        if (rows.some((row) => row?.uri === expected.uri && !row.uid))
          throw new Error('Playlist entry identity unavailable');
        if (index < 0) throw new Error('Playing entry is no longer in this playlist');
        removal = {
          id: String(++removalSequence),
          target,
          index,
          count: rows.length,
          previous: rows[index - 1] || null,
          next: rows[index + 1] || null,
          remaining: trackUids(
            rows.filter((_, i) => i !== index),
            expected.uri,
          ),
          attemptedUndo: false,
        };
        wrote = true;
        await api.remove(expected.context, [target]);
        const after = await playlistRows(expected.context);
        assertPlaying(expected);
        if (after.some((row) => sameRow(row, target))) {
          removal = null;
          throw new Error('Spotify did not remove the playing entry');
        }
        return {
          ok: true,
          message: `Removed from ${permissions.name || 'playing playlist'} — Undo available`,
        };
      }

      const record = removal;
      // After a lost response, establish membership before considering another write.
      const original = rows.find((row) => sameRow(row, record.target));
      const recreated = rows.filter(
        (row) =>
          row?.uri === expected.uri &&
          !record.remaining.includes(row.uid) &&
          row.uid !== record.target.uid,
      );
      if (original || recreated.length === 1) {
        if (!original && !restoredInPosition(rows, recreated[0], record))
          throw new Error('A matching entry appeared elsewhere; Undo position is uncertain');
        // Only our own verified add may replace the active occurrence for another Remove.
        restoredUid = original?.uid || (record.attemptedUndo ? recreated[0].uid : '');
        removal = null;
        return { ok: true, message: 'Entry already restored; no change made' };
      }
      if (recreated.length || record.attemptedUndo)
        throw new Error('Undo outcome uncertain; check this playlist in Spotify');
      const position = undoPosition(rows, record);
      const before = trackUids(rows, expected.uri);
      assertPlaying(expected);
      record.attemptedUndo = true;
      wrote = true;
      await api.add(expected.context, [expected.uri], position);
      const after = await playlistRows(expected.context);
      assertPlaying(expected);
      const added = after.filter((row) => row?.uri === expected.uri && !before.includes(row.uid));
      if (added.length !== 1 || !added[0].uid)
        throw new Error('Cannot verify Undo; check this playlist in Spotify');
      if (!restoredInPosition(after, added[0], record))
        throw new Error('Track was added but the original position was not restored');
      restoredUid = added[0].uid;
      removal = null;
      return { ok: true, message: `Restored to ${permissions.name || 'playing playlist'}` };
    } catch (error) {
      const message = `${error.message || 'Playlist update failed'}${wrote ? '; check playlist before retrying' : ''}`;
      return { ok: false, message };
    } finally {
      removalBusy = false;
      observeRemoval();
      invalidateMemberships();
    }
  }

  const addStyle = document.createElement('style');
  addStyle.textContent = `
    .jsh-like-button + button[aria-checked] { opacity: 1 !important; }
    button[data-jsh-added="false"] { color: var(--spice-subtext, #b3b3b3) !important; }
    button[data-jsh-added="true"] { color: #1ed760 !important; }
    button[data-jsh-added="false"] svg { --encore-icon-fill: var(--spice-subtext, #b3b3b3); }
    button[data-jsh-added="true"] svg { --encore-icon-fill: #1ed760; }
    button[data-jsh-added] svg path { fill: currentColor; }
    button[data-jsh-added] svg path ~ path { display: none; }
    button[data-jsh-added] svg[viewBox="0 0 24 24"] path { transform: scale(1.5); }
    button[data-jsh-added="false"] svg path { d: path("M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0-1a8 8 0 1 1 0 16A8 8 0 0 1 8 0zm-.75 4h1.5v3.25H12v1.5H8.75V12h-1.5V8.75H4v-1.5h3.25V4z"); }
    button[data-jsh-added="true"] svg path { d: path("M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-4.146-2.146-1.061-1.061L6.5 9.086 4.707 7.293 3.646 8.354 6.5 11.207l5.354-5.353z"); }
  `;
  document.head.append(addStyle);

  function normalize(value) {
    return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  }

  function fuzzyScore(query, value) {
    if (!query) return 0;

    const exactIndex = value.indexOf(query);
    if (exactIndex !== -1) return exactIndex;

    let queryIndex = 0;
    let previousMatch = -1;
    let score = 100;

    for (
      let valueIndex = 0;
      valueIndex < value.length && queryIndex < query.length;
      valueIndex += 1
    ) {
      if (value[valueIndex] !== query[queryIndex]) continue;

      const gap = previousMatch === -1 ? valueIndex : valueIndex - previousMatch - 1;
      const wordStart = valueIndex === 0 || /[\s_\-/.]/.test(value[valueIndex - 1]);
      score += gap - (wordStart ? 2 : 0);
      previousMatch = valueIndex;
      queryIndex += 1;
    }

    return queryIndex === query.length ? score : Number.POSITIVE_INFINITY;
  }

  function isTrack(uri) {
    if (typeof uri !== 'string') return false;
    if (uri.startsWith('spotify:track:')) return true;

    try {
      const parsed = Spicetify.URI?.fromString?.(uri);
      const trackType = Spicetify.URI?.Type?.TRACK;
      return Boolean(trackType && parsed?.type === trackType);
    } catch {
      return false;
    }
  }

  function isAlbum(uri) {
    if (typeof uri !== 'string') return false;
    if (uri.startsWith('spotify:album:')) return true;

    try {
      const parsed = Spicetify.URI?.fromString?.(uri);
      const albumType = Spicetify.URI?.Type?.ALBUM;
      return Boolean(albumType && parsed?.type === albumType);
    } catch {
      return false;
    }
  }

  function isSupportedTarget(uri) {
    return isTrack(uri) || isAlbum(uri);
  }

  function getCurationAPI() {
    return Object.values(Spicetify.Platform || {}).find(
      (api) =>
        api &&
        typeof api.getCurationContexts === 'function' &&
        typeof api.curateItems === 'function',
    );
  }

  function uniquePlaylists(playlists) {
    return playlists.filter(
      (playlist, index, all) =>
        playlist.uri.startsWith('spotify:playlist:') &&
        all.findIndex(({ uri }) => uri === playlist.uri) === index,
    );
  }

  async function loadWithCurationAPI(itemUri, curationAPI) {
    const items = [];
    for (let offset = 0; ;) {
      const response = await curationAPI.getCurationContexts({
        curatedItemUri: itemUri,
        flatten: true,
        sortOrder: 5, // Spotify's RECENTLY_UPDATED order, also used by its native Add picker.
        limit: 1000,
        offset,
      });
      if (!Array.isArray(response?.items)) throw new Error('Playlist membership unavailable');
      if (!response.items.length && Number.isFinite(response.totalLength) && items.length < response.totalLength)
        throw new Error('Playlist membership incomplete');
      if (offset && response.items[0]?.uri && items.some((item) => item?.uri === response.items[0].uri))
        throw new Error('Spotify did not paginate playlists');
      items.push(...response.items);
      if (!response.items.length || (Number.isFinite(response.totalLength)
        ? items.length >= response.totalLength : response.items.length < 1000)) break;
      offset += response.items.length;
    }

    return uniquePlaylists(
      items
        .filter((item) => item?.uri && item.name)
        .map((item) => ({
          count: Number.isFinite(item.trackCount) ? item.trackCount : item.totalLength,
          folder: item.fromFolder?.name,
          image: item.images?.[0]?.url,
          name: item.name,
          saved: typeof item.hasCuratedItems === 'boolean' ? item.hasCuratedItems : null,
          uri: item.uri,
        })),
    );
  }

  async function loadWithCosmos() {
    const root = await Spicetify.CosmosAsync.get('sp://core-playlist/v1/rootlist');
    const playlists = [];

    function visit(rows) {
      for (const row of rows || []) {
        const uri = row.link || row.uri;
        if (row.type === 'playlist' && uri && row.name) {
          playlists.push({
            count: Number.isFinite(row.total_length) ? row.total_length : undefined,
            folder: undefined,
            image: undefined,
            name: row.name,
            saved: false,
            uri,
          });
        }
        visit(row.rows);
      }
    }

    visit(root.rows);
    return uniquePlaylists(playlists);
  }

  async function loadPlaylists(itemUri) {
    const curationAPI = getCurationAPI();
    if (curationAPI) {
      try {
        return {
          curationAPI,
          playlists: await loadWithCurationAPI(itemUri, curationAPI),
        };
      } catch {
        // Fall through to the documented Cosmos rootlist endpoint.
      }
    }

    return {
      curationAPI: null,
      playlists: await loadWithCosmos(),
    };
  }

  async function albumTrackUris(albumUri) {
    const albumId = albumUri.split(':')[2];
    const trackUris = [];
    let endpoint = `https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50`;
    while (endpoint) {
      const page = await Spicetify.CosmosAsync.get(endpoint);
      trackUris.push(...(page.items || []).map(({ uri }) => uri).filter(isTrack));
      endpoint = page.next;
    }
    return trackUris;
  }

  async function updatePlaylist(playlist, itemUri, curationAPI, validate) {
    const remove = playlist.saved;

    if (isTrack(itemUri)) {
      const music = window.JshMusic;
      // Spotify exposes Liked Songs as this synthetic playlist, regardless of its translated name.
      const action = playlist.uri === 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ' ? 'like' :
        playlist.name === 'Loved Songs' && playlist.uri === await music.love.playlistUri() ? 'love' : null;
      if (action) {
        const result = await music[action].toggle(itemUri, !remove, validate, playlist.uri);
        if (!result.ok) throw new Error(result.message || 'Could not update Liked/Loved Songs');
        return;
      }
    }

    if (curationAPI) {
      await curationAPI.curateItems(
        itemUri,
        remove ? [] : [playlist.uri],
        remove ? [playlist.uri] : [],
      );
      return;
    }

    const playlistId = playlist.uri.split(':')[2];
    const endpoint = `https://api.spotify.com/v1/playlists/${playlistId}/items`;
    const itemUris = isAlbum(itemUri) ? await albumTrackUris(itemUri) : [itemUri];
    for (let index = 0; index < itemUris.length; index += 100) {
      const batch = itemUris.slice(index, index + 100);
      if (remove) {
        await Spicetify.CosmosAsync.del(endpoint, {
          items: batch.map((uri) => ({ uri })),
        });
      } else {
        await Spicetify.CosmosAsync.post(endpoint, { uris: batch });
      }
    }
  }

  let selector = null;

  async function loadSelectorPlaylists(uri, curationAPI) {
    // Curation groups by membership; Library supplies the global recent-edit order.
    const [playlists, recent] = await Promise.all([
      loadWithCurationAPI(uri, curationAPI),
      (async () => {
        const items = [];
        for (let offset = 0; ; offset += 1000) {
          const page = await Spicetify.Platform.LibraryAPI.getContents({
            filters: ['2', '101'], sortOrder: '5', flattenTree: true, offset, limit: 1000,
          });
          if (!Array.isArray(page?.items)) throw new Error('Playlist sorting unavailable');
          if (offset && page.items[0]?.uri && items.some((item) => item?.uri === page.items[0].uri))
            throw new Error('Spotify did not paginate the library');
          items.push(...page.items);
          if (!page.items.length || items.length >= page.totalLength || page.items.length < 1000) break;
        }
        return new Map(items.map((item, index) => [item.uri, index]));
      })(),
    ]);
    for (const playlist of playlists) playlist.recent = recent.get(playlist.uri) ?? null;
    return playlists.sort((a, b) => Number(b.saved) - Number(a.saved) ||
      (a.recent ?? Infinity) - (b.recent ?? Infinity));
  }

  function playlistSelection() {
    const uri = Spicetify.Player.data?.item?.uri || '';
    const key = `${account()}:${uri}`;
    if (!selector || selector.key !== key)
      selector = { key, uri, account: account(), playlists: [], updated: 0, loading: false, busy: false, revision: 0, error: '' };
    const current = selector;
    const supported = current.account && isTrack(uri) && !Spicetify.Player.data?.item?.metadata?.is_advertisement;
    if (supported && !current.loading && !current.busy &&
        (!current.updated || (current.error && Date.now() - current.updated > 10000))) {
      current.loading = true;
      current.updated = Date.now();
      const curationAPI = getCurationAPI();
      const revision = current.revision;
      Promise.resolve().then(async () => {
        if (!curationAPI) throw new Error('Playlist picker unavailable');
        const playlists = await loadSelectorPlaylists(uri, curationAPI);
        if (revision !== current.revision) return;
        current.playlists = playlists;
        current.error = '';
      }).catch((error) => { if (revision === current.revision) current.error = error.message || 'Could not load playlists'; })
        .finally(() => {
          current.loading = false;
          window.JshMusic?.mini?.changed?.();
          if (current.error) setTimeout(() => {
            if (selector === current) window.JshMusic?.mini?.changed?.();
          }, 10000);
        });
    }
    return { playlists: supported ? current.playlists.map(({ uri, name, saved, image, recent }) => ({
      uri, name, saved, image: image?.replace('spotify:image:', 'https://i.scdn.co/image/'), recent,
    })) : [],
      ready: Boolean(supported && current.playlists.length && !current.error),
      loading: current.loading, error: current.error };
  }

  async function toggleSelectedPlaylist(expected, validate) {
    const current = selector;
    const curationAPI = getCurationAPI();
    if (!current || current.busy || !curationAPI) throw new Error('Playlist update unavailable');
    const assertSelection = () => {
      validate();
      if (current.account !== account() || current.uri !== Spicetify.Player.data?.item?.uri || selector !== current)
        throw new Error('Track or account changed; try again');
    };
    current.busy = true;
    current.updated = 0;
    current.revision += 1;
    try {
      assertSelection();
      const playlists = await loadWithCurationAPI(current.uri, curationAPI);
      assertSelection();
      const playlist = playlists.find((item) => item.uri === expected.playlist);
      if (!playlist || typeof expected.saved !== 'boolean' || playlist.saved !== expected.saved)
        throw new Error('Playlist membership changed; try again');
      await updatePlaylist(playlist, current.uri, curationAPI, assertSelection);
      const after = await loadSelectorPlaylists(current.uri, curationAPI);
      assertSelection();
      if (after.find((item) => item.uri === playlist.uri)?.saved !== !expected.saved)
        throw new Error('Playlist update unconfirmed; check Spotify before retrying');
      current.playlists = after;
      current.updated = Date.now();
      current.error = '';
      return { ok: true, message: '' };
    } finally {
      current.busy = false;
      invalidateMemberships();
    }
  }

  function spotifyPath(uri) {
    if (!uri) return null;
    try {
      return Spicetify.URI.fromString(uri).toURLPath(true);
    } catch {
      return null;
    }
  }

  function artworkUrl(item) {
    const url =
      item.album?.images?.[0]?.url ||
      item.images?.[0]?.url ||
      item.metadata?.image_xlarge_url ||
      item.metadata?.image_url;
    return url?.replace('spotify:image:', 'https://i.scdn.co/image/');
  }

  function metadataYear(item) {
    const releaseDate =
      item.metadata?.album_release_date ||
      item.metadata?.release_date ||
      item.metadata?.['album.release_date'];
    return /^\d{4}/.test(releaseDate || '') ? releaseDate.slice(0, 4) : '';
  }

  async function loadReleaseYear(trackUri) {
    const trackId = trackUri.split(':')[2];
    if (!trackId) return '';
    const track = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${trackId}`);
    return /^\d{4}/.test(track.album?.release_date || '')
      ? track.album.release_date.slice(0, 4)
      : '';
  }

  function createOverlay(itemUri, item = Spicetify.Player.data.item, followPlayer = true) {
    if (activeOverlay?.root.isConnected) activeOverlay.close();
    let currentItemUri = itemUri;
    let playlistLoadId = 0;
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.innerHTML = `
      <style>
        #${OVERLAY_ID} { --adder-accent: var(--essential-bright-accent, var(--spice-button, #1ed760)); --adder-fill: var(--background-tinted-base, var(--spice-card, #3e3e3e)); --adder-subtext: var(--text-subdued, var(--spice-subtext, #b3b3b3)); --adder-surface: var(--background-elevated-base, var(--spice-main, #282828)); --adder-text: var(--text-base, var(--spice-text, #fff)); align-items: center; background-color: rgb(0 0 0 / 72%); box-sizing: border-box; color: var(--adder-text); display: flex; inset: 0; justify-content: center; padding: 24px; position: fixed; z-index: 1000; }
        #${OVERLAY_ID} * { box-sizing: border-box; }
        #${OVERLAY_ID} .panel { background-color: var(--adder-surface); border: 1px solid rgb(255 255 255 / 8%); border-radius: 8px; box-shadow: 0 20px 64px rgb(0 0 0 / 55%); display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); height: min(620px, calc(100vh - 48px)); min-height: 300px; overflow: hidden; width: min(560px, 100%); }
        #${OVERLAY_ID} .item-card { align-items: center; background-color: var(--adder-fill); border-radius: 6px; display: grid; gap: 16px; grid-template-columns: 112px minmax(0, 1fr); min-height: 136px; margin: 16px; padding: 12px; }
        #${OVERLAY_ID} .artwork-link { border-radius: 4px; display: block; height: 112px; overflow: hidden; width: 112px; }
        #${OVERLAY_ID} .artwork { background-color: var(--adder-surface); display: block; height: 100%; object-fit: cover; width: 100%; }
        #${OVERLAY_ID} .artwork-fallback { align-items: center; color: var(--adder-subtext); display: flex; justify-content: center; }
        #${OVERLAY_ID} .artwork-fallback svg { height: 34px; width: 34px; }
        #${OVERLAY_ID} .track-info { min-width: 0; }
        #${OVERLAY_ID} .track-title { color: var(--adder-text); display: block; font-size: 22px; font-weight: 700; line-height: 27px; margin-bottom: 7px; overflow: hidden; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
        #${OVERLAY_ID} .artists { color: var(--adder-subtext); font-size: 14px; font-weight: 600; line-height: 20px; margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #${OVERLAY_ID} .release { color: var(--adder-subtext); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; white-space: normal; }
        #${OVERLAY_ID} .metadata-link { color: inherit; text-decoration: none; }
        #${OVERLAY_ID} .track-title:hover, #${OVERLAY_ID} .metadata-link:hover { text-decoration: underline; }
        #${OVERLAY_ID} .search { margin: 0 16px 12px; position: relative; }
        #${OVERLAY_ID} .search svg { color: var(--adder-subtext); height: 18px; left: 14px; pointer-events: none; position: absolute; top: 50%; transform: translateY(-50%); width: 18px; }
        #${OVERLAY_ID} input { background-color: var(--adder-fill); border: 1px solid transparent; border-radius: 6px; color: inherit; font: inherit; font-size: 16px; min-height: 44px; outline: none; padding: 10px 14px 10px 42px; transition: border-color 120ms ease, box-shadow 120ms ease; width: 100%; }
        #${OVERLAY_ID} input::placeholder { color: var(--adder-subtext); opacity: 1; }
        #${OVERLAY_ID} input:focus-visible { border-color: var(--adder-accent); box-shadow: inset 0 0 0 1px var(--adder-accent); }
        #${OVERLAY_ID} [role="listbox"] { min-height: 0; overflow: auto; padding: 0 8px 8px; scroll-padding: 4px; scrollbar-gutter: stable; }
        #${OVERLAY_ID} [role="option"] { align-items: center; border-radius: 6px; cursor: pointer; display: grid; gap: 10px; grid-template-columns: 40px minmax(0, 1fr) 28px; min-height: 52px; padding: 6px 8px; transition: background-color 100ms ease; }
        #${OVERLAY_ID} [role="option"]:hover, #${OVERLAY_ID} [role="option"].active { background-color: var(--adder-fill); }
        #${OVERLAY_ID} [role="option"].busy { opacity: 0.7; }
        #${OVERLAY_ID} [role="option"] img, #${OVERLAY_ID} [role="option"] .cover { align-items: center; background-color: var(--adder-fill); border-radius: 4px; display: flex; height: 40px; justify-content: center; object-fit: cover; width: 40px; }
        #${OVERLAY_ID} .cover svg { color: var(--adder-subtext); height: 18px; width: 18px; }
        #${OVERLAY_ID} .details { min-width: 0; }
        #${OVERLAY_ID} .name { font-size: 14px; font-weight: 600; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #${OVERLAY_ID} .meta { color: var(--adder-subtext); font-size: 12px; line-height: 18px; }
        #${OVERLAY_ID} .status { align-items: center; border: 1px solid var(--adder-subtext); border-radius: 50%; color: transparent; display: flex; height: 18px; justify-content: center; width: 18px; }
        #${OVERLAY_ID} .status svg { height: 12px; width: 12px; }
        #${OVERLAY_ID} .status.saved { background: #1ed760; border-color: #1ed760; color: #000; }
        #${OVERLAY_ID} .status.changed { animation: adder-pop 240ms ease-out; }
        #${OVERLAY_ID} .status.busy { animation: adder-spin 700ms linear infinite; border-color: var(--adder-subtext); border-top-color: #1ed760; }
        #${OVERLAY_ID} .empty { color: var(--adder-subtext); padding: 40px 16px; text-align: center; }
        #${OVERLAY_ID} .sr-only { clip: rect(0, 0, 0, 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
        @keyframes adder-pop { 50% { transform: scale(1.28); } }
        @keyframes adder-spin { to { transform: rotate(360deg); } }
        @media (max-width: 480px) { #${OVERLAY_ID} { padding: 12px; } #${OVERLAY_ID} .panel { height: min(620px, calc(100vh - 24px)); } #${OVERLAY_ID} .item-card { gap: 12px; grid-template-columns: 88px minmax(0, 1fr); min-height: 112px; margin: 12px; padding: 12px; } #${OVERLAY_ID} .artwork-link { height: 88px; width: 88px; } #${OVERLAY_ID} .track-title { font-size: 19px; line-height: 24px; } }
        @media (prefers-reduced-motion: reduce) { #${OVERLAY_ID} * { scroll-behavior: auto !important; transition: none !important; } #${OVERLAY_ID} .status { animation: none !important; } }
      </style>
    `;

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('aria-label', `Add ${isAlbum(itemUri) ? 'album' : 'track'} to playlists`);
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('role', 'dialog');

    const header = document.createElement('header');
    header.className = 'item-card';

    function createSpotifyLink(label, uri, className) {
      const path = spotifyPath(uri);
      const element = document.createElement(path ? 'a' : 'span');
      element.className = className;
      element.textContent = label;
      if (path) {
        element.href = path;
        element.addEventListener('click', (event) => {
          event.preventDefault();
          close();
          Spicetify.Platform.History.push(path);
        });
      }
      return element;
    }

    function renderItemCard(targetItem) {
      const renderedItemUri = targetItem.uri;
      const album = isAlbum(renderedItemUri);
      const albumUri = album
        ? renderedItemUri
        : targetItem.album?.uri || targetItem.metadata?.album_uri;
      const artworkLink = createSpotifyLink('', albumUri, 'artwork-link');
      artworkLink.setAttribute(
        'aria-label',
        `Open ${
          targetItem.album?.name || targetItem.metadata?.album_title || targetItem.name || 'album'
        }`,
      );
      const imageUrl = artworkUrl(targetItem);
      if (imageUrl) {
        const artwork = document.createElement('img');
        artwork.className = 'artwork';
        artwork.alt = '';
        artwork.src = imageUrl;
        artworkLink.append(artwork);
      } else {
        const artwork = document.createElement('span');
        artwork.className = 'artwork artwork-fallback';
        artwork.innerHTML =
          '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
        artworkLink.append(artwork);
      }

      const itemInfo = document.createElement('div');
      itemInfo.className = 'track-info';
      const trackTitle = createSpotifyLink(
        targetItem.name || `Current ${album ? 'album' : 'track'}`,
        targetItem.uri,
        'track-title',
      );
      trackTitle.title = targetItem.name || `Current ${album ? 'album' : 'track'}`;

      const artists = document.createElement('div');
      artists.className = 'artists';
      const fallbackArtists = [
        {
          name: targetItem.metadata?.artist_name || 'Unknown artist',
          uri: targetItem.metadata?.artist_uri,
        },
      ];
      const creditedArtists = targetItem.artists?.length ? targetItem.artists : fallbackArtists;
      creditedArtists.forEach((artist, index) => {
        if (index) artists.append(document.createTextNode(', '));
        artists.append(createSpotifyLink(artist.name, artist.uri, 'metadata-link'));
      });

      const release = document.createElement('div');
      release.className = 'release';
      const albumName =
        targetItem.album?.name || targetItem.metadata?.album_title || 'Unknown album';
      if (album) {
        release.append(document.createTextNode('Album'));
      } else {
        release.append(createSpotifyLink(albumName, albumUri, 'metadata-link'));
      }
      const year = document.createElement('span');
      const initialYear = metadataYear(targetItem);
      if (initialYear) {
        year.textContent = ` · ${initialYear}`;
        release.append(year);
      } else if (!album) {
        loadReleaseYear(renderedItemUri)
          .then((loadedYear) => {
            if (!loadedYear || currentItemUri !== renderedItemUri || !release.isConnected) return;
            year.textContent = ` · ${loadedYear}`;
            release.append(year);
          })
          .catch(() => {});
      }
      itemInfo.append(trackTitle, artists, release);
      header.replaceChildren(artworkLink, itemInfo);
    }

    renderItemCard(item);

    const search = document.createElement('div');
    search.className = 'search';
    search.innerHTML =
      '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Find a playlist';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', `${OVERLAY_ID}-results`);
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-label', 'Find a playlist');
    input.setAttribute('role', 'combobox');
    search.append(input);

    const list = document.createElement('div');
    list.id = `${OVERLAY_ID}-results`;
    list.setAttribute('aria-label', 'Playlists');
    list.setAttribute('aria-multiselectable', 'true');
    list.setAttribute('role', 'listbox');
    const live = document.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    panel.append(header, search, list, live);
    root.append(panel);
    document.body.append(root);

    let allPlaylists = [];
    let curationAPI = null;
    let selectedIndex = 0;
    let visiblePlaylists = [];

    function close() {
      playlistLoadId += 1;
      window.removeEventListener('keydown', onKeyDown, true);
      if (followPlayer) Spicetify.Player.removeEventListener('songchange', onSongChange);
      root.remove();
      activeOverlay = null;
    }

    function updateActive(scroll = false) {
      [...list.querySelectorAll('[role="option"]')].forEach((row, index) => {
        row.classList.toggle('active', index === selectedIndex);
      });

      const row = list.querySelectorAll('[role="option"]')[selectedIndex];
      if (!row) {
        input.removeAttribute('aria-activedescendant');
        return;
      }

      input.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }

    function updateRow(playlist, changed = false) {
      if (!playlist.row?.isConnected) return;
      const status = playlist.row.querySelector('.status');
      status.className = `status${playlist.busy ? ' busy' : playlist.saved ? ' saved' : ''}${changed ? ' changed' : ''}`;
      status.innerHTML =
        playlist.saved && !playlist.busy
          ? '<svg aria-hidden="true" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.25"><path d="m3.5 8.2 2.8 2.8 6.2-6.2"></path></svg>'
          : '';
      playlist.row.classList.toggle('busy', playlist.busy);
      playlist.row.setAttribute('aria-disabled', String(playlist.busy));
      playlist.row.setAttribute(
        'aria-label',
        `${playlist.name}, ${playlist.saved ? 'saved' : 'not saved'}`,
      );
      playlist.row.setAttribute('aria-selected', String(playlist.saved));
    }

    async function togglePlaylist(playlist) {
      if (!playlist || playlist.busy) return;

      const targetItemUri = currentItemUri;
      const wasSaved = playlist.saved;
      playlist.busy = true;
      updateRow(playlist);
      try {
        await updatePlaylist(playlist, targetItemUri, curationAPI);
        if (currentItemUri !== targetItemUri) return;
        playlist.saved = !wasSaved;
        const message = `${playlist.saved ? 'Saved to' : 'Removed from'} ${playlist.name}`;
        live.textContent = message;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        live.textContent = `Could not update ${playlist.name}. ${message}`;
        Spicetify.showNotification(`Could not update ${playlist.name}`, true);
      } finally {
        playlist.busy = false;
        invalidateMemberships();
        updateRow(playlist, currentItemUri === targetItemUri && playlist.saved !== wasSaved);
      }
    }

    function render() {
      list.replaceChildren();
      for (const playlist of allPlaylists) playlist.row = null;

      if (!visiblePlaylists.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = allPlaylists.length ? 'No matching playlists' : 'No playlists found';
        list.append(empty);
        input.removeAttribute('aria-activedescendant');
        return;
      }

      visiblePlaylists.forEach((playlist, index) => {
        const row = document.createElement('div');
        row.id = `${OVERLAY_ID}-playlist-${index}`;
        row.setAttribute('role', 'option');
        row.tabIndex = -1;

        const cover = playlist.image
          ? document.createElement('img')
          : document.createElement('span');
        if (playlist.image) {
          cover.alt = '';
          cover.src = playlist.image;
        } else {
          cover.className = 'cover';
          cover.innerHTML =
            '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
        }

        const details = document.createElement('span');
        details.className = 'details';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = playlist.name;
        name.title = playlist.name;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent =
          [
            playlist.folder,
            Number.isFinite(playlist.count) ? `${playlist.count.toLocaleString()} songs` : null,
          ]
            .filter(Boolean)
            .join(' / ') || 'Playlist';
        details.append(name, meta);

        const status = document.createElement('span');
        status.className = 'status';
        status.setAttribute('aria-hidden', 'true');
        row.append(cover, details, status);
        row.addEventListener('mouseenter', () => {
          selectedIndex = visiblePlaylists.indexOf(playlist);
          updateActive();
        });
        row.addEventListener('mousedown', (event) => event.preventDefault());
        row.addEventListener('click', () => togglePlaylist(playlist));
        playlist.row = row;
        list.append(row);
        updateRow(playlist);
      });

      updateActive();
    }

    function filterPlaylists() {
      const query = normalize(input.value.trim());
      visiblePlaylists = allPlaylists
        .map((playlist) => ({ playlist, score: fuzzyScore(query, normalize(playlist.name)) }))
        .filter(({ score }) => Number.isFinite(score))
        .sort(
          (left, right) =>
            left.score - right.score ||
            Number(right.playlist.saved) - Number(left.playlist.saved) ||
            left.playlist.name.localeCompare(right.playlist.name),
        )
        .slice(0, RESULT_LIMIT)
        .map(({ playlist }) => playlist);
      selectedIndex = 0;
      render();
      live.textContent = `${visiblePlaylists.length} matching ${
        visiblePlaylists.length === 1 ? 'playlist' : 'playlists'
      }`;
    }

    async function refreshPlaylists() {
      const loadId = ++playlistLoadId;
      const loading = document.createElement('div');
      loading.className = 'empty';
      loading.textContent = 'Loading playlists...';
      list.replaceChildren(loading);
      input.removeAttribute('aria-activedescendant');

      try {
        const result = await loadPlaylists(currentItemUri);
        if (!root.isConnected || loadId !== playlistLoadId) return;
        curationAPI = result.curationAPI;
        allPlaylists = result.playlists;
        filterPlaylists();
      } catch (error) {
        if (!root.isConnected || loadId !== playlistLoadId) return;
        const message = error instanceof Error ? error.message : String(error);
        list.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Could not load playlists. Try again.';
        list.append(empty);
        live.textContent = `Could not load playlists. ${message}`;
        Spicetify.showNotification('Could not load playlists', true);
      }
    }

    function onSongChange(event) {
      const nextItem = event?.data?.item || Spicetify.Player.data?.item;
      if (!isTrack(nextItem?.uri) || nextItem.uri === currentItemUri) return;
      currentItemUri = nextItem.uri;
      renderItemCard(nextItem);
      refreshPlaylists();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (!root.isConnected || !visiblePlaylists.length) return;
      if (event.target?.closest?.('select, button')) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selectedIndex =
          (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + visiblePlaylists.length) %
          visiblePlaylists.length;
        updateActive(true);
      } else if (event.key === 'Enter' || event.code === 'Space') {
        event.preventDefault();
        togglePlaylist(visiblePlaylists[selectedIndex]);
      } else if (
        document.activeElement !== input &&
        !event.isComposing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete')
      ) {
        input.focus();
      }
    }

    input.addEventListener('input', filterPlaylists);
    root.addEventListener('mousedown', (event) => {
      if (event.target === root) close();
    });
    window.addEventListener('keydown', onKeyDown, true);
    if (followPlayer) Spicetify.Player.addEventListener('songchange', onSongChange);
    activeOverlay = { close, root };

    requestAnimationFrame(() => input.focus());
    refreshPlaylists();
  }

  function toggleOverlay() {
    if (activeOverlay?.root.isConnected) {
      activeOverlay.close();
      return;
    }

    const trackUri = Spicetify.Player.data?.item?.uri;
    if (!isTrack(trackUri)) {
      Spicetify.showNotification('Play a track before adding it to playlists', true);
      return;
    }

    createOverlay(trackUri);
  }

  async function openContextOverlay(uris) {
    const targetUri = uris?.find(isSupportedTarget);
    if (!targetUri) return;

    const playerItem = Spicetify.Player.data?.item;
    if (playerItem?.uri === targetUri) {
      createOverlay(targetUri, playerItem, false);
      return;
    }

    const itemType = isAlbum(targetUri) ? 'album' : 'track';
    const itemId = targetUri.split(':')[2];
    try {
      let item;
      if (itemType === 'album') {
        const response = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.getAlbum, {
          uri: targetUri,
          locale: Spicetify.Locale.getLocale(),
          offset: 0,
          limit: 1,
        });
        const album = response.data?.albumUnion;
        item = {
          artists: (album?.artists?.items || []).map((artist) => ({
            name: artist.profile?.name,
            uri: artist.uri,
          })),
          images: album?.coverArt?.sources,
          metadata: { release_date: album?.date?.isoString },
          name: album?.name,
          uri: album?.uri || targetUri,
        };
      } else {
        item = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${itemId}`);
      }
      createOverlay(targetUri, item, false);
    } catch {
      Spicetify.showNotification(`Could not load ${itemType}`, true);
    }
  }

  function contextUriFromTarget(target) {
    let element = target instanceof Element ? target : target?.parentElement;
    while (element) {
      const fiberKey = Object.getOwnPropertyNames(element).find((key) =>
        key.startsWith('__reactFiber$'),
      );
      let fiber = fiberKey ? element[fiberKey] : null;
      for (let level = 0; fiber && level < 30; level += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        const candidates = [
          props?.item?.uri,
          props?.track?.uri,
          props?.data?.item?.uri,
          props?.data?.uri,
          props?.entity?.uri,
          props?.uri,
          ...(Array.isArray(props?.uris) ? props.uris : []),
        ];
        const uri = candidates.find(isSupportedTarget);
        if (uri) return uri;
      }
      element = element.parentElement;
    }
    return null;
  }

  function curationTarget(button) {
    const fiberKey = Object.getOwnPropertyNames(button).find((key) =>
      key.startsWith('__reactFiber$'),
    );
    let fiber = fiberKey ? button[fiberKey] : null;
    for (let level = 0; fiber && level < 40; level += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (typeof props?.curateDefault === 'function') {
        return isTrack(props.uri) ? { uri: props.uri } : null;
      }
    }
    return null;
  }

  const memberships = new Map();
  let membershipAccount = '';

  function savedState(uri) {
    if (!isTrack(uri) || !account()) return undefined;
    if (membershipAccount !== account()) {
      memberships.clear();
      membershipAccount = account();
    }
    let current = memberships.get(uri);
    if (!current || (!current.loading &&
        (current.dirty || ((current.value === undefined || current.failed) && Date.now() - current.updated > 10000)))) {
      const curationAPI = getCurationAPI();
      if (!curationAPI) return undefined;
      current = { updated: Date.now(), loading: true, value: current?.value };
      memberships.set(uri, current);
      if (memberships.size > 200) memberships.delete(memberships.keys().next().value);
      const request = current;
      loadWithCurationAPI(uri, curationAPI).then(async (playlists) => {
        let loved = null;
        if (playlists.some((item) => item.name === 'Loved Songs' && item.saved !== false)) {
          if (!window.JshMusic?.love?.playlistUri) throw new Error('Loved Songs unavailable');
          loved = await window.JshMusic.love.playlistUri();
        }
        const others = playlists.filter((item) => item.uri !== 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ' && item.uri !== loved);
        const value = others.some((item) => item.saved === true) ? true :
          others.every((item) => item.saved === false) ? false : undefined;
        if (typeof value === 'boolean') request.value = value;
        else request.failed = true;
      }).catch(() => { request.failed = true; }).finally(() => {
        request.loading = false;
        scheduleAddScan();
        if (request.failed) setTimeout(() => {
          if (memberships.get(uri) === request) scheduleAddScan();
        }, 10000);
      });
    }
    return current.value;
  }

  function scanNativeAddButtons() {
    addScanQueued = false;
    for (const button of document.querySelectorAll('button[aria-checked]')) {
      const target = curationTarget(button);
      if (!target) continue;
      savedState(target.uri);
    }
  }

  function scheduleAddScan() {
    window.JshMusic?.mini?.changed?.();
    if (addScanQueued) return;
    addScanQueued = true;
    requestAnimationFrame(scanNativeAddButtons);
  }

  function invalidateMemberships() {
    capabilities = null;
    deferredEntry = null;
    notifyDeferred();
    for (const current of memberships.values()) current.dirty = true;
    if (selector && !selector.busy) {
      selector.updated = 0;
      selector.revision += 1;
    }
    scheduleAddScan();
  }

  for (const api of [Spicetify.Platform?.PlaylistAPI, Spicetify.Platform?.LibraryAPI, Spicetify.Platform?.RootlistAPI, getCurationAPI()]) {
    api?.getEvents?.()?.addListener?.('operation_complete', invalidateMemberships);
  }
  Spicetify.Platform?.LibraryAPI?.getEvents?.()?.addListener?.('update_item', invalidateMemberships);
  new MutationObserver((records) => {
    if (records.some(({ type, target, addedNodes, removedNodes }) =>
      type === 'attributes' || target.closest?.('button[aria-checked]') ||
      [...addedNodes, ...removedNodes].some((node) => node.nodeType === 1 &&
        (node.matches('button[aria-checked]') || node.querySelector('button[aria-checked]')))))
      scheduleAddScan();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
  scheduleAddScan();

  function injectContextItem(targetUri) {
    const nativeLabel = Spicetify.Locale?.get?.('contextmenu.add-to-playlist') || 'Add to playlist';
    const nativeItem = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.getClientRects().length && item.textContent.trim().startsWith(nativeLabel),
    );
    const menu = nativeItem?.closest('[role="menu"]');
    if (!nativeItem || !menu || menu.querySelector('[data-jsh-adder-context-item]')) return false;

    const wrapper = nativeItem.parentElement?.cloneNode(true);
    const button = wrapper?.querySelector('[role="menuitem"]');
    if (!wrapper || !button) return false;

    button.dataset.jshAdderContextItem = '';
    button.removeAttribute('aria-expanded');
    const icon = button.querySelector('svg.e-10451-icon:not(.main-contextMenu-subMenuIcon)');
    if (icon) {
      icon.style.removeProperty('--encore-icon-fill');
      icon.removeAttribute('stroke');
      icon.removeAttribute('stroke-linecap');
      icon.removeAttribute('stroke-linejoin');
      icon.removeAttribute('stroke-width');
      icon.setAttribute('fill', 'currentColor');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.innerHTML =
        '<path d="M11.25 5.75a.75.75 0 0 1-.75.75H6.5v4a.75.75 0 0 1-1.5 0V6.5H1a.75.75 0 0 1 0-1.5h4V1a.75.75 0 0 1 1.5 0v4h4a.75.75 0 0 1 .75.75zM15.75 12.25a.75.75 0 0 1-.75.75H13v2a.75.75 0 0 1-1.5 0v-2H9.5a.75.75 0 0 1 0-1.5h2V9.5a.75.75 0 0 1 1.5 0v2h2a.75.75 0 0 1 .75.75z"></path>';
    }
    button.querySelector('.main-contextMenu-menuItemIconWrapper')?.remove();
    const label = button.querySelector('[data-encore-id="type"]');
    if (label) {
      label.textContent = 'Add to playlists';
    } else {
      button.textContent = 'Add to playlists';
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      openContextOverlay([targetUri]).then(() => {
        const input = document.querySelector(`#${OVERLAY_ID} input`);
        if (!input) return;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          input.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              composed: true,
              pointerId: 1,
              pointerType: 'mouse',
            }),
          );
        }
      });
    });
    nativeItem.parentElement.insertAdjacentElement('afterend', wrapper);
    return true;
  }

  let contextMenuObserver = null;
  document.addEventListener(
    'contextmenu',
    (event) => {
      const targetUri = contextUriFromTarget(event.target);
      contextMenuObserver?.disconnect();
      if (!targetUri) return;

      contextMenuObserver = new MutationObserver(() => {
        if (injectContextItem(targetUri)) contextMenuObserver.disconnect();
      });
      contextMenuObserver.observe(document.body, { childList: true, subtree: true });
      requestAnimationFrame(() => injectContextItem(targetUri));
      setTimeout(() => contextMenuObserver?.disconnect(), 2000);
    },
    true,
  );

  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const shortcut = { key: 'p', meta: isMac, ctrl: !isMac, shift: true };
  const handledEvents = new WeakSet();
  const handleShortcut = (event) => {
    if (handledEvents.has(event)) return;
    const key = event.key?.toLocaleLowerCase();
    const modifier = event.metaKey || event.ctrlKey;
    if (key !== 'p' || !event.shiftKey || !modifier || event.altKey) return;

    handledEvents.add(event);
    event.preventDefault();
    event.stopPropagation();
    toggleOverlay();
  };

  // Keep Spicetify's shortcut registration for compatibility with its keymap,
  // and also listen at the window level for current desktop Spotify builds
  // where Mousetrap may not receive modified key events.
  try {
    Spicetify.Keyboard?.registerShortcut(shortcut, handleShortcut);
    if (isMac) {
      Spicetify.Keyboard?.registerShortcut({ key: 'p', ctrl: true, shift: true }, handleShortcut);
    }
  } catch {
    // The native listener below remains the portable fallback.
  }
  window.addEventListener('keydown', handleShortcut, true);
  window.JshMusic ||= {};
  window.JshMusic.add = { toggle: toggleOverlay, state: savedState, removalState, changePlayingPlaylist,
    playlistSelection, toggleSelectedPlaylist, deferredState, toggleDeferred,
    onDeferredChange: (listener) => { deferredListeners.add(listener); return () => deferredListeners.delete(listener); } };
  Spicetify.Player.addEventListener?.('songchange', deferredSongChange);
  // Spotify can publish songchange before the entry UID arrives; subsequent player
  // updates must refresh eligibility even when the track URI is unchanged.
  Spicetify.Player.origin?._events?.addListener?.('update', () => {
    Promise.resolve().then(deferredSongChange);
  });
})();
