(function lyrics() {
  if (!window.Spicetify?.Player?.data || !Spicetify.Platform?.RequestBuilder) {
    setTimeout(lyrics, 250);
    return;
  }

  let popup = null;
  let opening = false;
  let timer = null;
  let trackUri = null;
  let generation = 0;
  let lines = [];
  let active = -1;
  let following = true;
  let synced = false;
  let fontSize = 28;
  let viewport, list, status;
  const boundsKey = 'jsh:lyrics-window-bounds';
  let bounds;
  try {
    bounds = JSON.parse(window.localStorage.getItem(boundsKey));
  } catch {
    // Storage can be unavailable or contain an older, invalid value.
  }
  if (
    !bounds ||
    !['width', 'height', 'left', 'top'].every((key) => Number.isFinite(bounds[key])) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    bounds = null;

  function saveBounds() {
    if (!popup || popup.closed || popup.innerWidth <= 0 || popup.innerHeight <= 0) return;
    const next = {
      width: popup.innerWidth,
      height: popup.innerHeight,
      left: popup.screenX,
      top: popup.screenY,
    };
    if (JSON.stringify(next) === JSON.stringify(bounds)) return;
    bounds = next;
    try {
      window.localStorage.setItem(boundsKey, JSON.stringify(bounds));
    } catch {
      // Keep session placement even when persistent storage is unavailable.
    }
  }

  function resync() {
    following = true;
    if (!lines.length) load();
    else {
      tick();
      center();
    }
  }

  function size(delta) {
    fontSize = Math.max(14, Math.min(72, fontSize + delta));
    list.style.fontSize = `${fontSize}px`;
    center();
  }

  function center() {
    const line = list?.children[Math.max(active, 0)];
    if (!line || !following || !synced) return;
    viewport.scrollTo({
      top: line.offsetTop - (viewport.clientHeight - line.offsetHeight) / 2,
      behavior: 'instant',
    });
  }

  function tick() {
    if (!popup || popup.closed) return;
    saveBounds();
    if (Spicetify.Player.data?.item?.uri !== trackUri) {
      load();
      return;
    }
    if (!synced) return;
    const position = Spicetify.Player.getProgress();
    let next = -1;
    while (next + 1 < lines.length && lines[next + 1].start <= position) next += 1;
    if (next === active) return;
    list.children[active]?.removeAttribute('aria-current');
    active = next;
    list.children[active]?.setAttribute('aria-current', 'true');
    center();
  }

  async function load() {
    const item = Spicetify.Player.data?.item;
    trackUri = item?.uri;
    const request = ++generation;
    active = -1;
    lines = [];
    synced = false;
    following = true;
    list.replaceChildren();
    popup.document.getElementById('credit').textContent = '';
    viewport.scrollTop = 0;
    popup.document.title = `${item?.name || item?.metadata?.title || 'Live lyrics'} — Lyrics`;
    status.textContent = 'Loading lyrics…';
    if (!trackUri?.startsWith('spotify:track:')) {
      status.textContent = 'Lyrics are not available for this item.';
      return;
    }
    try {
      const image =
        item.metadata?.image_large_url ||
        item.metadata?.image_url ||
        item.album?.images?.[0]?.url ||
        item.album?.images?.[0] ||
        '';
      const response = (
        await Spicetify.Platform.RequestBuilder.build()
          .withHost('https://spclient.wg.spotify.com/color-lyrics/v2')
          .withPath(
            `/track/${encodeURIComponent(trackUri.split(':')[2])}/image/${encodeURIComponent(image)}`,
          )
          .withHeaders([{ key: 'App-Platform', value: 'WebPlayer' }])
          .withQueryParameters({ format: 'json', vocalRemoval: false })
          .withEndpointIdentifier('/track/{trackId}')
          .send()
      ).body;
      if (request !== generation || !popup || popup.closed) return;
      const lyrics = response?.lyrics;
      if (lyrics?.capStatus === 'CAPPED') {
        status.textContent = 'Spotify’s lyrics limit has been reached.';
        return;
      }
      lines = (lyrics?.lines || []).map((line) => ({
        start: Number(line.startTimeMs),
        text: line.words || '♪',
      }));
      synced =
        ['LINE_SYNCED', 'SYLLABLE_SYNCED'].includes(lyrics?.syncType) &&
        lines.length > 0 &&
        lines.every((line) => Number.isFinite(line.start));
      status.textContent = !lines.length
        ? 'No lyrics available.'
        : synced
          ? ''
          : 'These lyrics are not time-synced.';
      for (const line of lines) {
        const row = popup.document.createElement('p');
        const text = popup.document.createElement('span');
        text.textContent = line.text;
        row.append(text);
        list.append(row);
      }
      const credit = popup.document.getElementById('credit');
      credit.textContent =
        lines.length && lyrics.providerDisplayName
          ? `Lyrics provided by ${lyrics.providerDisplayName}`
          : '';
      tick();
      center();
    } catch (error) {
      if (request !== generation || !popup || popup.closed) return;
      status.textContent = 'Could not load lyrics. Press S to retry.';
      console.error('[lyrics] Failed to load lyrics', error);
    }
  }

  function close() {
    saveBounds();
    generation += 1;
    popup?.clearInterval(timer);
    timer = null;
    popup = null;
    trackUri = null;
    lines = [];
  }

  async function open() {
    if (opening) return;
    if (popup && !popup.closed) {
      popup.close();
      return;
    }
    opening = true;
    try {
      popup = window.documentPictureInPicture
        ? await window.documentPictureInPicture.requestWindow({
            width: bounds?.width || 460,
            height: bounds?.height || 640,
            preferInitialWindowPlacement: false,
          })
        : window.open(
            'about:blank',
            'jsh-live-lyrics',
            `popup=yes,width=${bounds?.width || 460},height=${bounds?.height || 640},resizable=yes,scrollbars=yes` +
              (bounds ? `,left=${bounds.left},top=${bounds.top}` : ''),
          );
    } catch (error) {
      console.error('[lyrics] Failed to open window', error);
    } finally {
      opening = false;
    }
    if (!popup) {
      Spicetify.showNotification('Spotify could not open the lyrics window.', true);
      return;
    }
    if (bounds) {
      try {
        popup.resizeTo(
          bounds.width + popup.outerWidth - popup.innerWidth,
          bounds.height + popup.outerHeight - popup.innerHeight,
        );
        // Spotify permits PiP positioning, unlike standard browser implementations.
        popup.moveTo(bounds.left, bounds.top);
      } catch (error) {
        console.warn('[lyrics] Could not restore window placement', error);
      }
    }
    const doc = popup.document;
    doc.documentElement.lang = document.documentElement.lang || 'en';
    doc.head.replaceChildren();
    doc.body.replaceChildren();
    const style = doc.createElement('style');
    style.textContent = `
      :root { color-scheme: dark; font: 16px system-ui, sans-serif; background: #121212; color: #fff; }
      * { box-sizing: border-box; }
      body { margin: 0; height: 100vh; display: flex; flex-direction: column; }
      body { -webkit-app-region: no-drag; }
      header { flex: 0 0 28px; -webkit-app-region: drag; user-select: none; cursor: grab; }
      span { user-select: text; cursor: text; }

      :focus-visible { outline: 2px solid #767676; outline-offset: -2px; }
      main { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 24px; position: relative; scrollbar-gutter: stable; }
      #lines { padding-block: 50vh; }
      #lines:empty { display: none; }
      p { font-size: inherit; font-weight: 700; line-height: 1.4; margin: 0 0 20px; color: #b3b3b3; overflow-wrap: anywhere; }
      p[aria-current] { color: #fff; text-shadow: 0 0 1px currentColor; }
      #status { font-size: 16px; font-weight: 400; padding-top: 24px; margin: 0; }
      #status:empty { display: none; }
      footer { color: #b3b3b3; font-size: 12px; padding-bottom: 24px; }
    `;
    doc.head.append(style);
    const drag = doc.createElement('header');
    drag.setAttribute('aria-label', 'Drag to move lyrics window');
    viewport = doc.createElement('main');
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'Lyrics');
    status = doc.createElement('p');
    status.id = 'status';
    status.setAttribute('role', 'status');
    list = doc.createElement('div');
    list.id = 'lines';
    list.style.fontSize = `${fontSize}px`;
    const credit = doc.createElement('footer');
    credit.id = 'credit';
    viewport.append(status, list, credit);
    const resize = doc.createElement('button');
    resize.type = 'button';
    resize.setAttribute('aria-label', 'Resize lyrics window');
    resize.title = 'Drag to resize; arrow keys also resize';
    resize.style.cssText =
      'position:fixed;right:0;bottom:0;width:12px;height:12px;padding:0;border:0;background:transparent;cursor:nwse-resize;touch-action:none';
    const resizeBy = (x, y) =>
      popup.resizeTo(Math.max(280, popup.outerWidth + x), Math.max(240, popup.outerHeight + y));
    resize.onpointerdown = (event) => {
      event.preventDefault();
      resize.focus();
      resize.setPointerCapture(event.pointerId);
      let x = event.screenX,
        y = event.screenY;
      resize.onpointermove = (move) => {
        resizeBy(move.screenX - x, move.screenY - y);
        x = move.screenX;
        y = move.screenY;
      };
    };
    resize.onlostpointercapture = () => {
      resize.onpointermove = null;
    };
    resize.onkeydown = (event) => {
      const delta = {
        ArrowLeft: [-20, 0],
        ArrowRight: [20, 0],
        ArrowUp: [0, -20],
        ArrowDown: [0, 20],
      }[event.key];
      if (delta) {
        event.preventDefault();
        resizeBy(...delta);
      }
    };
    doc.body.append(drag, viewport, resize);
    // Only the top strip is a native drag region; lyrics still receive right-clicks.
    popup.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      resync();
    });
    const stopFollowing = () => {
      following = false;
    };
    // User input pauses following; programmatic scrolling never does.
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button === 0 && event.target.closest('span')) stopFollowing();
    });
    viewport.addEventListener('wheel', stopFollowing, { passive: true });
    viewport.addEventListener('touchmove', stopFollowing, { passive: true });
    viewport.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
        stopFollowing();
    });
    popup.addEventListener('resize', () => {
      saveBounds();
      center();
    });
    popup.addEventListener('pagehide', close, { once: true });
    popup.addEventListener(
      'keydown',
      (event) => {
        const sizeKey =
          { Equal: '+', Minus: '-', Digit0: '0', NumpadAdd: '+', NumpadSubtract: '-' }[
            event.code
          ] || event.key;
        if (
          (event.metaKey || event.ctrlKey || event.altKey) &&
          ['-', '=', '+', '0'].includes(sizeKey)
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (sizeKey === '0') fontSize = 28;
          size(sizeKey === '-' ? -2 : sizeKey === '0' ? 0 : 2);
        } else if (
          event.key === 'Escape' ||
          ((event.metaKey || event.ctrlKey) && event.key === 'w')
        ) {
          event.preventDefault();
          popup.close();
        } else if (
          event.key?.toLowerCase() === 's' &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          resync();
        } else handleShortcut(event);
      },
      true,
    );
    load();
    timer = popup.setInterval(tick, 100);
    popup.focus();
  }

  const handled = new WeakSet();
  function handleShortcut(event) {
    if (
      handled.has(event) ||
      event.repeat ||
      (event.code !== 'KeyL' && event.key?.toLowerCase() !== 'l') ||
      !event.altKey ||
      event.shiftKey ||
      !(event.metaKey || event.ctrlKey)
    )
      return;
    handled.add(event);
    event.preventDefault();
    event.stopPropagation();
    open();
  }
  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  try {
    Spicetify.Keyboard?.registerShortcut(
      { key: 'l', meta: isMac, ctrl: !isMac, alt: true },
      handleShortcut,
    );
  } catch {
    // Native listener remains available if Spotify's keymap changes.
  }
  window.addEventListener('keydown', handleShortcut, true);
  window.addEventListener(
    'pagehide',
    () => {
      popup?.close();
      close();
    },
    { once: true },
  );
})();
