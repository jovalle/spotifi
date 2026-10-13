(function like() {
  if (!window.Spicetify?.Player || !Spicetify.Platform?.LibraryAPI) {
    setTimeout(like, 250);
    return;
  }

  const STAR_CLASS = 'jsh-like-button';
  const STAR_PATH = 'M8 1.5l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3l-3.9 2.2 1-4.4-3.4-3 4.5-.5z';
  const likedTracks = new Map();
  const likeReads = new Map();
  const curationJobs = [];
  let scanQueued = false;

  const starStyle = document.createElement('style');
  starStyle.textContent = `
    .${STAR_CLASS} { align-items: center; align-self: center; background: none; border: 0; color: var(--spice-subtext); cursor: pointer; display: inline-flex; flex-shrink: 0; height: var(--jsh-button-height, 16px); justify-content: center; padding: 0 !important; box-sizing: border-box; position: relative; vertical-align: middle; width: var(--jsh-button-width, 16px); z-index: 1; }
    .${STAR_CLASS}:focus-visible { outline: 2px solid var(--spice-text); outline-offset: 2px; }
    .${STAR_CLASS}:hover { color: var(--spice-text); }
    .${STAR_CLASS}[aria-pressed="true"] { color: #ffc324; }
    .${STAR_CLASS} svg { transform-origin: center; transition: transform 100ms ease-out; flex-shrink: 0; height: var(--jsh-icon-height, 16px); width: var(--jsh-icon-width, 16px); }
    .${STAR_CLASS} path { fill: transparent; stroke: currentColor; stroke-linejoin: round; stroke-width: 1.5; }
    .${STAR_CLASS}[aria-pressed="true"] path { fill: currentColor; }
    .${STAR_CLASS}:hover svg { transform: scale(1.1); }
    .${STAR_CLASS}:active svg { transform: scale(0.92); }
    @media (prefers-reduced-motion: reduce) { .${STAR_CLASS} path, .${STAR_CLASS} svg { transition: none; } .${STAR_CLASS}:hover svg, .${STAR_CLASS}:active svg { transform: none; } }
    .jsh-tooltip { animation: jsh-tooltip-in 0.2s ease-in-out; background-color: var(--spice-card, #282828); border-radius: 4px; box-shadow: 0 16px 24px #0000004d, 0 6px 8px #0003; color: var(--spice-text, #fff); font-size: 14px; max-width: 50ch; padding: 4px 8px; }
    @keyframes jsh-tooltip-in { from { opacity: 0; } }
  `;
  document.head.append(starStyle);

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
    custom.style.setProperty('--jsh-button-width', `${button.offsetWidth}px`);
    custom.style.setProperty('--jsh-button-height', `${button.offsetHeight}px`);
    custom.style.setProperty('--jsh-icon-width', size.width);
    custom.style.setProperty('--jsh-icon-height', size.height);
    const gap = button.closest('.main-trackList-rowSectionEnd') ? 8 : 4;
    custom.style.setProperty(
      'margin-inline-end',
      `${gap - (button.offsetWidth - parseFloat(size.width))}px`,
      'important',
    );
    if (!observedButtons.has(button)) {
      sizeObserver.observe(button);
      observedButtons.add(button);
    }
  }

  function renderCuration() {
    scheduleScan();
    window.JshMusic?.love?.render();
  }

  function curationPreview(uri) {
    const state = { liked: likedState(uri), loved: window.JshMusic?.love?.state(uri) };
    for (const job of curationJobs) {
      if (job.uri !== uri) continue;
      if (typeof job.value !== 'boolean') continue;
      if (job.action === 'like') {
        state.liked = job.value;
        if (!job.value) state.loved = false;
      } else {
        state.loved = job.value;
        if (job.value) state.liked = true;
      }
    }
    return state;
  }

  // Every click has an explicit target; writes run in order without dropping later clicks.
  function enqueueCuration(uri, action, value, apply, validate) {
    const account = Spicetify.Platform.LocalStorageAPI?.namespace;
    const known = curationPreview(uri)[action === 'like' ? 'liked' : 'loved'];
    const jobs = curationJobs;
    return new Promise((resolve) => {
      const job = {
        uri,
        action,
        value: typeof value === 'boolean' ? value : typeof known === 'boolean' ? !known : undefined,
        apply,
        resolve,
        check() {
          if (account !== Spicetify.Platform.LocalStorageAPI?.namespace)
            throw new Error('Spotify account changed');
          validate?.();
        },
      };
      jobs.push(job);
      renderCuration();
      if (jobs.length === 1) drain();
      async function drain() {
        while (jobs.length) {
          const current = jobs[0];
          const result = await current.apply(current);
          jobs.shift();
          renderCuration();
          if (!jobs.length) window.JshMusic?.love?.refresh();
          current.resolve(result);
        }
      }
    });
  }

  async function toggleLiked(uri, value, validate) {
    if (!isTrack(uri)) {
      Spicetify.showNotification('Play a track before toggling Liked Songs', true);
      return { ok: false, message: 'Play a track before toggling Liked Songs' };
    }
    return enqueueCuration(
      uri,
      'like',
      value,
      async (job) => {
        let loveRemoved = false;
        try {
          job.check();
          const library = Spicetify.Platform.LibraryAPI;
          const [liked] = await library.contains(uri);
          job.check();
          likeReads.delete(uri);
          likedTracks.set(uri, Boolean(liked));
          job.value ??= !liked;
          renderCuration();
          if (!job.value) loveRemoved = await window.JshMusic.love.clear(uri, job.check);
          job.check();
          if (Boolean(liked) !== job.value)
            await library[job.value ? 'add' : 'remove']({ silent: true, uris: [uri] });
          likeReads.delete(uri);
          likedTracks.set(uri, job.value);
          return {
            ok: true,
            message: job.value ? 'Added to Liked Songs' : 'Removed from Liked Songs',
          };
        } catch {
          const message = loveRemoved
            ? 'Removed from Loved Songs; could not update Liked Songs. Check Spotify'
            : 'Could not update Liked/Loved Songs';
          Spicetify.showNotification(message, true);
          return { ok: false, message };
        }
      },
      validate,
    );
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

  function likedState(uri) {
    if (!likedTracks.has(uri)) {
      likedTracks.set(uri, undefined);
      const request = Symbol();
      likeReads.set(uri, request);
      Spicetify.Platform.LibraryAPI.contains(uri).then(
        ([liked]) => {
          if (likeReads.get(uri) !== request) return;
          likeReads.delete(uri);
          likedTracks.set(uri, Boolean(liked));
          scheduleScan();
        },
        () => {},
      );
    }
    return likedTracks.get(uri);
  }

  function decorateCurationButton(button) {
    const uri = curationUri(button);
    const previous = button.previousElementSibling;
    let star = previous?.classList.contains(STAR_CLASS) ? previous : null;
    if (!uri) {
      star?.remove();
      return;
    }
    if (!star) {
      star = document.createElement('button');
      star.className = STAR_CLASS;
      star.type = 'button';
      star.innerHTML = `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="${STAR_PATH}"></path></svg>`;
      button.before(star);
    }
    sizeLikeNative(star, button);
    const previousUri = star.dataset.uri;
    star.dataset.uri = uri;
    const value = curationPreview(uri).liked;
    const busy = curationJobs.some((job) => job.uri === uri);
    star.setAttribute('aria-busy', String(busy));
    star.setAttribute('aria-disabled', 'false');
    const liked =
      typeof value === 'boolean'
        ? String(value)
        : previousUri === uri
          ? star.getAttribute('aria-pressed') || 'false'
          : 'false';
    if (star.getAttribute('aria-pressed') !== liked) {
      star.setAttribute('aria-pressed', liked);
      setTooltip(star, liked === 'true' ? 'Remove from Liked Songs' : 'Add to Liked Songs');
    }
  }

  function scanCurationButtons() {
    scanQueued = false;
    for (const button of observedButtons) {
      if (button.isConnected) continue;
      sizeObserver.unobserve(button);
      observedButtons.delete(button);
    }
    for (const star of document.querySelectorAll(`.${STAR_CLASS}`)) {
      if (!star.nextElementSibling?.matches('button[aria-checked]')) star.remove();
    }
    for (const button of document.querySelectorAll('button[aria-checked]')) {
      decorateCurationButton(button);
    }
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scanCurationButtons);
  }

  window.addEventListener(
    'click',
    (event) => {
      const element = event.target instanceof Element ? event.target : null;
      const star = element?.closest(`.${STAR_CLASS}`);
      if (!star) return;
      event.preventDefault();
      event.stopPropagation();
      toggleLiked(star.dataset.uri);
    },
    true,
  );
  for (const type of ['dblclick', 'mousedown', 'pointerdown']) {
    window.addEventListener(
      type,
      (event) => {
        if (event.target instanceof Element && event.target.closest(`.${STAR_CLASS}`)) {
          event.stopPropagation();
        }
      },
      true,
    );
  }

  Spicetify.Platform.LibraryAPI.getEvents?.()?.addListener?.('update_item', ({ data }) => {
    if (!likedTracks.has(data?.uri) || typeof data.isInLibrary !== 'boolean') return;
    likedTracks.set(data.uri, data.isInLibrary);
    likeReads.delete(data.uri);
    scheduleScan();
  });
  Spicetify.Player.addEventListener('songchange', scheduleScan);
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  scheduleScan();

  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const handledEvents = new WeakSet();
  const handleShortcut = (event) => {
    if (handledEvents.has(event)) return;
    const key = event.key?.toLocaleLowerCase();
    const modifier = event.metaKey || event.ctrlKey;
    if (key !== 'l' || !event.shiftKey || !modifier || event.altKey) return;

    handledEvents.add(event);
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleLiked(Spicetify.Player.data?.item?.uri);
  };

  // Mirror add.js: register with Spicetify's keymap and listen natively as a fallback.
  try {
    Spicetify.Keyboard?.registerShortcut(
      { key: 'l', meta: isMac, ctrl: !isMac, shift: true },
      handleShortcut,
    );
    if (isMac) {
      Spicetify.Keyboard?.registerShortcut({ key: 'l', ctrl: true, shift: true }, handleShortcut);
    }
  } catch {
    // The native listener below remains the portable fallback.
  }
  window.addEventListener('keydown', handleShortcut, true);
  function feedback(button) {
    const icon = button.querySelector('svg');
    if (!icon?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    icon.getAnimations().forEach((animation) => animation.cancel());
    const base = button.matches(':hover') ? 1.1 : 1;
    icon.animate([{ transform: `scale(${0.92 * base})` }, { transform: `scale(${base})` }], {
      duration: 100,
      easing: 'ease-out',
    });
  }

  window.JshMusic ||= {};
  window.JshMusic.feedback = feedback;
  window.JshMusic.curation = {
    enqueue: enqueueCuration,
    preview: curationPreview,
    busy: (uri) =>
      uri === undefined ? curationJobs.length > 0 : curationJobs.some((job) => job.uri === uri),
    render: renderCuration,
  };
  window.JshMusic.like = {
    toggle: toggleLiked,
    state: likedState,
    render: scheduleScan,
    refresh: (uri, confirmed) => {
      likeReads.delete(uri);
      if (typeof confirmed === 'boolean') {
        likedTracks.set(uri, confirmed);
        scheduleScan();
        return confirmed;
      }
      likedTracks.delete(uri);
      return likedState(uri);
    },
  };
})();
