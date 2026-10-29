(function love() {
  const { LibraryAPI, PlaylistAPI, RootlistAPI } = window.Spicetify?.Platform || {};
  if (
    !window.Spicetify?.Player ||
    !LibraryAPI ||
    !PlaylistAPI ||
    !RootlistAPI ||
    !window.JshMusic?.curation
  ) {
    setTimeout(love, 250);
    return;
  }

  const LOVE_CLASS = 'jsh-love-button';
  const STAR_CLASS = 'jsh-like-button';
  const PLAYLIST_NAME = 'Loved Songs';
  const HEART_PATH = 'M8 13.6 2.7 8.4a3.3 3.3 0 0 1 4.7-4.7l.6.6.6-.6a3.3 3.3 0 0 1 4.7 4.7z';
  const lovedUids = new Map();
  let playlistUri = null;
  let refreshTimer = null;
  let scanQueued = false;
  let loaded = false;
  let loveRead = 0;
  let playlistLookup = null;

  const loveStyle = document.createElement('style');
  loveStyle.textContent = `
    .${LOVE_CLASS} { align-items: center; align-self: center; background: none; border: 0; color: var(--spice-subtext); cursor: pointer; display: inline-flex; flex-shrink: 0; height: var(--jsh-button-height, 16px); justify-content: center; padding: 0 !important; box-sizing: border-box; position: relative; vertical-align: middle; width: var(--jsh-button-width, 16px); z-index: 1; }
    .main-trackList-rowSectionEnd:has([role="switch"]) .${LOVE_CLASS} { margin-inline-start: 8px; }
    .${LOVE_CLASS}:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
    .${LOVE_CLASS}:hover { color: var(--spice-text); }
    .${LOVE_CLASS}[aria-pressed="true"] { color: #e22134; }
    .${LOVE_CLASS} svg { transform-origin: center; transition: transform 100ms ease-out; flex-shrink: 0; height: var(--jsh-icon-height, 16px); width: var(--jsh-icon-width, 16px); }
    .${LOVE_CLASS} path { fill: transparent; stroke: currentColor; stroke-linejoin: round; stroke-width: 1.5; }
    .${LOVE_CLASS}[aria-pressed="true"] path { fill: currentColor; }
    .${LOVE_CLASS}:hover svg { transform: scale(1.1); }
    .${LOVE_CLASS}:active svg { transform: scale(0.92); }
    @media (prefers-reduced-motion: reduce) { .${LOVE_CLASS} path, .${LOVE_CLASS} svg { transition: none; } .${LOVE_CLASS}:hover svg, .${LOVE_CLASS}:active svg { transform: none; } }
    .jsh-tooltip { animation: jsh-tooltip-in 0.2s ease-in-out; background-color: var(--spice-card, #282828); border-radius: 4px; box-shadow: 0 16px 24px #0000004d, 0 6px 8px #0003; color: var(--spice-text, #fff); font-size: 14px; max-width: 50ch; padding: 4px 8px; }
    @keyframes jsh-tooltip-in { from { opacity: 0; } }
  `;
  document.head.append(loveStyle);

  function isTrack(uri) {
    return typeof uri === 'string' && uri.startsWith('spotify:track:');
  }

  // Mirrors Spotify's hover tooltip (200ms delay, same box) instead of Spicetify's menu-styled one.
  const tooltipProps = {
    // Headless Tippy never unmounts when animation is on; the CSS keyframe handles fade-in.
    animation: false,
    delay: [200, 0],
    offset: [0, 8],
    placement: 'top',
    render(instance) {
      const popper = document.createElement('div');
      const box = document.createElement('div');
      box.className = 'jsh-tooltip';
      box.textContent = instance.props.content;
      popper.append(box);
      return {
        onUpdate(_, next) {
          box.textContent = next.content;
        },
        popper,
      };
    },
  };

  function setTooltip(button, label) {
    button.setAttribute('aria-label', label);
    if (button._tippy) {
      button._tippy.setContent(label);
    } else if (Spicetify.Tippy) {
      button.removeAttribute('title');
      Spicetify.Tippy(button, { ...tooltipProps, content: label });
    } else {
      button.title = label;
    }
  }

  // Match the adjacent native button in every surface, including after resizing.
  const observedButtons = new Set();
  const sizeObserver = new ResizeObserver(scheduleScan);
  function sizeLikeNative(custom, button) {
    const icon = button.querySelector('svg');
    if (!icon || !button.offsetWidth || !button.offsetHeight) return;
    const size = getComputedStyle(icon);
    const gap = button.closest('.main-trackList-rowSectionEnd') ? 8 : 4;
    for (const [property, value, priority] of [
      ['--jsh-button-width', `${button.offsetWidth}px`, ''],
      ['--jsh-button-height', `${button.offsetHeight}px`, ''],
      ['--jsh-icon-width', size.width, ''],
      ['--jsh-icon-height', size.height, ''],
      [
        'margin-inline-end',
        `${gap - (button.offsetWidth - parseFloat(size.width))}px`,
        'important',
      ],
    ]) {
      if (
        custom.style.getPropertyValue(property) !== value ||
        custom.style.getPropertyPriority(property) !== priority
      )
        custom.style.setProperty(property, value, priority);
    }
    if (!observedButtons.has(button)) {
      sizeObserver.observe(button);
      observedButtons.add(button);
    }
  }

  // Spotify strips data-testid, so recognize its curation button by the React props above it.
  function curationUri(button) {
    const fiberKey = Object.getOwnPropertyNames(button).find((key) =>
      key.startsWith('__reactFiber$'),
    );
    let fiber = fiberKey ? button[fiberKey] : null;
    for (let level = 0; fiber && level < 40; level += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (typeof props?.curateDefault === 'function') {
        return isTrack(props.uri) ? props.uri : null;
      }
    }
    return null;
  }

  function findPlaylist(items) {
    for (const item of items || []) {
      if (
        item?.type === 'playlist' &&
        item.name === PLAYLIST_NAME &&
        (item.isOwnedBySelf ?? item.ownedBySelf) === true &&
        item.uri?.startsWith('spotify:playlist:')
      ) {
        return item.uri;
      }
      const nested = findPlaylist(item?.items || item?.rows);
      if (nested) return nested;
    }
    return null;
  }

  function ensurePlaylist() {
    playlistLookup ||= (async () => {
      const root = await RootlistAPI.getContents();
      const items = root?.items || root?.rows;
      if (!Array.isArray(items)) throw new Error('Could not read the Spotify library');
      const uri =
        findPlaylist(items) || (await RootlistAPI.createPlaylist(PLAYLIST_NAME, { after: 'end' }));
      if (!uri?.startsWith('spotify:playlist:'))
        throw new Error(`Could not create ${PLAYLIST_NAME}`);
      return uri;
    })().finally(() => {
      playlistLookup = null;
    });
    return playlistLookup;
  }

  async function loadLoved() {
    const request = ++loveRead;
    const uri = await ensurePlaylist();
    const uids = new Map();
    if (uri) {
      const contents = await PlaylistAPI.getContents(uri, { limit: 10000, offset: 0 });
      for (const item of contents?.items || []) {
        if (!isTrack(item?.uri)) continue;
        uids.set(item.uri, [...(uids.get(item.uri) || []), item.uid]);
      }
    }
    if (request !== loveRead) return uri;
    playlistUri = uri;
    lovedUids.clear();
    for (const [trackUri, trackUids] of uids) lovedUids.set(trackUri, trackUids);
    loaded = true;
    scheduleScan();
    return uri;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (window.JshMusic.curation.busy()) return;
    refreshTimer = setTimeout(() => {
      if (!window.JshMusic.curation.busy()) loadLoved().catch(() => {});
    }, 250);
  }

  async function removeLoadedLove(uri, check) {
    if (!lovedUids.has(uri)) return false;
    check();
    const items = lovedUids.get(uri).map((uid) => ({ uid, uri }));
    await PlaylistAPI.remove(playlistUri, items);
    loveRead += 1;
    lovedUids.delete(uri);
    scheduleScan();
    return true;
  }

  async function clearLoved(uri, check) {
    check();
    await loadLoved();
    check();
    return removeLoadedLove(uri, check);
  }

  async function toggleLoved(uri, value, validate, expectedPlaylist) {
    if (!isTrack(uri)) return { ok: false, message: 'Play a track before toggling Love' };
    return window.JshMusic.curation.enqueue(
      uri,
      'love',
      value,
      async (job) => {
        let likedAdded = false;
        try {
          job.check();
          await loadLoved();
          job.check();
          if (expectedPlaylist && playlistUri !== expectedPlaylist)
            throw new Error('Loved Songs playlist changed');
          job.value ??= !lovedUids.has(uri);
          window.JshMusic.curation.render();
          if (!job.value) {
            await removeLoadedLove(uri, job.check);
            return { ok: true, message: `Removed from ${PLAYLIST_NAME}` };
          }
          const [liked] = await LibraryAPI.contains(uri);
          job.check();
          if (!liked) {
            await LibraryAPI.add({ silent: true, uris: [uri] });
            likedAdded = true;
          }
          window.JshMusic.like.refresh(uri, true);
          job.check();
          if (!lovedUids.has(uri)) {
            await PlaylistAPI.add(playlistUri, [uri], { after: 'end' });
            // Read actual UIDs before the next queued click can remove this entry.
            await loadLoved();
            if (!lovedUids.has(uri)) throw new Error(`Could not confirm ${PLAYLIST_NAME}`);
          }
          return { ok: true, message: `Added to ${PLAYLIST_NAME}` };
        } catch {
          const message = likedAdded
            ? `Added to Liked Songs; could not update ${PLAYLIST_NAME}. Check Spotify`
            : `Could not update ${PLAYLIST_NAME}; check Spotify`;
          Spicetify.showNotification(message, true);
          return { ok: false, message };
        } finally {
          scheduleRefresh();
        }
      },
      validate,
    );
  }

  function decorateCurationButton(button) {
    const uri = curationUri(button);
    const star = button.previousElementSibling?.classList.contains(STAR_CLASS)
      ? button.previousElementSibling
      : null;
    const anchor = star || button;
    const previous = anchor.previousElementSibling;
    let heart = previous?.classList.contains(LOVE_CLASS) ? previous : null;
    if (!uri) {
      heart?.remove();
      return;
    }
    if (!heart) {
      heart = document.createElement('button');
      heart.className = LOVE_CLASS;
      heart.type = 'button';
      heart.innerHTML = `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="${HEART_PATH}"></path></svg>`;
      anchor.before(heart);
    }
    sizeLikeNative(heart, button);
    const previousUri = heart.dataset.uri;
    if (previousUri !== uri) heart.dataset.uri = uri;
    const value = window.JshMusic.curation.preview(uri).loved;
    const busy = window.JshMusic.curation.busy(uri);
    if (heart.getAttribute('aria-busy') !== String(busy))
      heart.setAttribute('aria-busy', String(busy));
    if (heart.getAttribute('aria-disabled') !== 'false')
      heart.setAttribute('aria-disabled', 'false');
    const loved =
      typeof value === 'boolean'
        ? String(value)
        : previousUri === uri
          ? heart.getAttribute('aria-pressed') || 'false'
          : 'false';
    if (heart.getAttribute('aria-pressed') !== loved) {
      heart.setAttribute('aria-pressed', loved);
      setTooltip(
        heart,
        loved === 'true' ? `Remove from ${PLAYLIST_NAME}` : `Add to ${PLAYLIST_NAME}`,
      );
    }
  }

  function scanCurationButtons() {
    scanQueued = false;
    for (const button of observedButtons) {
      if (button.isConnected) continue;
      sizeObserver.unobserve(button);
      observedButtons.delete(button);
    }
    for (const heart of document.querySelectorAll(`.${LOVE_CLASS}`)) {
      const next = heart.nextElementSibling;
      if (!next?.matches(`.${STAR_CLASS}, button[aria-checked]`)) heart.remove();
    }
    for (const button of document.querySelectorAll('button[aria-checked]')) {
      decorateCurationButton(button);
    }
  }

  function scheduleScan() {
    window.JshMusic?.mini?.changed?.();
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scanCurationButtons);
    window.JshMusic?.like?.render();
  }

  window.addEventListener(
    'click',
    (event) => {
      const heart = event.target instanceof Element && event.target.closest(`.${LOVE_CLASS}`);
      if (!heart) return;
      event.preventDefault();
      event.stopPropagation();
      toggleLoved(heart.dataset.uri);
    },
    true,
  );
  for (const type of ['dblclick', 'mousedown', 'pointerdown']) {
    window.addEventListener(
      type,
      (event) => {
        if (event.target instanceof Element && event.target.closest(`.${LOVE_CLASS}`)) {
          event.stopPropagation();
        }
      },
      true,
    );
  }

  for (const api of [PlaylistAPI, RootlistAPI]) {
    api.getEvents?.()?.addListener?.('operation_complete', scheduleRefresh);
  }
  Spicetify.Player.addEventListener('songchange', scheduleScan);
  new MutationObserver((records) => {
    if (
      records.some(
        ({ target, addedNodes, removedNodes }) =>
          target.closest?.('button[aria-checked]') ||
          [...addedNodes, ...removedNodes].some(
            (node) =>
              node.nodeType === 1 &&
              (node.matches('button[aria-checked], .jsh-love-button') ||
                node.querySelector('button[aria-checked], .jsh-love-button')),
          ),
      )
    )
      scheduleScan();
  }).observe(document.body, { childList: true, subtree: true });
  loadLoved()
    .then(async (uri) => {
      const likedUri = 'spotify:collection:tracks';
      await LibraryAPI.pin(likedUri, { before: 'start' });
      await LibraryAPI.pin(uri, { after: { uri: likedUri } });
      const pinned = await LibraryAPI.getIsPinned(likedUri, uri);
      // Spotify 1.3.6 returns [] for every URI, so only an explicit false is a failure.
      if (pinned.includes(false)) throw new Error('Could not pin Liked Songs and Loved Songs');
      if (!window.JshLovedCover?.startsWith('data:image/jpeg;base64,'))
        throw new Error('Loved Songs cover is missing');
      const response = await fetch(window.JshLovedCover);
      if (!response.ok) throw new Error('Could not load Loved Songs cover');
      const cover = await response.blob();
      const imageUploadToken = await PlaylistAPI.uploadImage(cover);
      if (!imageUploadToken) throw new Error('Could not upload Loved Songs cover');
      await PlaylistAPI.updateDetails(uri, { imageUploadToken });
    })
    .catch((error) => {
      console.error('[love] Failed to configure Loved Songs', error);
      Spicetify.showNotification('Could not configure Loved Songs; check Spotify', true);
      scheduleScan();
    });

  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const handledEvents = new WeakSet();
  const handleShortcut = (event) => {
    if (handledEvents.has(event)) return;
    // Option+Shift changes event.key on macOS (L becomes Ò), so match the physical key.
    const isL = event.code === 'KeyL' || event.key?.toLocaleLowerCase() === 'l';
    const modifier = event.metaKey || event.ctrlKey;
    if (!isL || !event.shiftKey || !event.altKey || !modifier) return;

    handledEvents.add(event);
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const uri = Spicetify.Player.data?.item?.uri;
    if (!isTrack(uri)) {
      Spicetify.showNotification(`Play a track before toggling ${PLAYLIST_NAME}`, true);
      return;
    }
    toggleLoved(uri);
  };

  try {
    Spicetify.Keyboard?.registerShortcut(
      { key: 'l', meta: isMac, ctrl: !isMac, alt: true, shift: true },
      handleShortcut,
    );
    if (isMac) {
      Spicetify.Keyboard?.registerShortcut(
        { key: 'l', ctrl: true, alt: true, shift: true },
        handleShortcut,
      );
    }
  } catch {
    // The native listener below remains the portable fallback.
  }
  window.addEventListener('keydown', handleShortcut, true);
  window.JshMusic ||= {};
  window.JshMusic.love = {
    playlistUri: async () => {
      await loadLoved();
      return playlistUri;
    },
    toggle: toggleLoved,
    clear: clearLoved,
    render: scheduleScan,
    refresh: scheduleRefresh,
    state: (uri) => (loaded ? lovedUids.has(uri) : undefined),
  };
})();
