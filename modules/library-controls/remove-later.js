(function removeLater() {
  if (!window.Spicetify?.Player || !window.JshMusic?.add?.deferredState) {
    setTimeout(removeLater, 250);
    return;
  }

  const api = window.JshMusic.add;
  const style = document.createElement('style');
  style.textContent = `
    .jsh-remove-later { align-items: center; background: none; border: 0; border-radius: 50%; box-sizing: border-box; color: var(--spice-subtext, #b3b3b3); cursor: pointer; display: flex; height: 16px; justify-content: center; padding: 0; position: fixed; transform: translateX(-50%); width: 16px; z-index: 100; }
    .jsh-remove-later:hover { color: var(--spice-text, #fff); }
    .jsh-remove-later[aria-pressed="true"] { background: #f15e6c; color: #121212; }
    .jsh-remove-later:focus-visible { outline: 2px solid var(--spice-text, #fff); outline-offset: 2px; }
    .jsh-remove-later svg { width: 16px; height: 16px; transition: transform 100ms ease-out; }
    .jsh-remove-later:hover svg { transform: scale(1.1); }
    .jsh-remove-later:active svg { transform: scale(.92); }
    .jsh-remove-later-tooltip { animation: jsh-remove-later-tooltip-in .2s ease-in-out; background: var(--spice-card, #282828); border-radius: 4px; box-shadow: 0 16px 24px #0000004d, 0 6px 8px #0003; color: var(--spice-text, #fff); font-size: 14px; max-width: 50ch; padding: 4px 8px; }
    @keyframes jsh-remove-later-tooltip-in { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .jsh-remove-later svg { transition: none; } .jsh-remove-later:hover svg, .jsh-remove-later:active svg { transform: none; } .jsh-remove-later-tooltip { animation: none; } }
  `;
  document.head.append(style);

  let queued = false;
  let button = null;
  let observedNative = null;
  const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  function scan() {
    queued = false;
    const state = api.deferredState();
    const native = [...document.querySelectorAll('[data-testid="now-playing-widget"] button[aria-checked], [data-testid="now-playing-widget-v2"] button[aria-checked], .main-nowPlayingBar-left button[aria-checked]')]
      .find((button) => {
        const key = Object.getOwnPropertyNames(button).find((name) => name.startsWith('__reactFiber$'));
        for (let fiber = key && button[key], level = 0; fiber && level < 40; fiber = fiber.return, level++) {
          const props = fiber.memoizedProps;
          if (typeof props?.curateDefault === 'function') return props.uri === state.uri;
        }
        return false;
      });
    if (!native || !state.mode) {
      button?._tippy?.destroy();
      button?.remove();
      button = null;
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.className = 'jsh-remove-later';
      button.type = 'button';
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/></svg>';
      button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); api.toggleDeferred(); });
      document.body.append(button);
    }
    if (native !== observedNative) {
      if (observedNative) sizeObserver?.unobserve(observedNative);
      observedNative = native;
      sizeObserver?.observe(native);
    }
    const rect = native.getBoundingClientRect();
    button.style.left = `${rect.left + rect.width / 2}px`;
    button.style.top = `${rect.bottom + 4}px`;
    const action = state.mode === 'hide' ? 'Hide' : 'Remove';
    const label = state.selected ? `Cancel ${action.toLowerCase()} after this track` : `${action} from this playlist after this track`;
    button.setAttribute('aria-pressed', String(state.selected));
    button.setAttribute('aria-label', label);
    if (button._tippy) button._tippy.setContent(label);
    else if (Spicetify.Tippy) {
      Spicetify.Tippy(button, {
        animation: false, delay: [200, 0], offset: [0, 8], placement: 'top', content: label,
        render(instance) {
          const popper = document.createElement('div');
          const box = document.createElement('div');
          box.className = 'jsh-remove-later-tooltip';
          box.textContent = instance.props.content;
          popper.append(box);
          return { popper, onUpdate: (_, next) => { box.textContent = next.content; } };
        },
      });
    } else button.title = label;
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
  }
  api.onDeferredChange(schedule);
  Spicetify.Player.addEventListener?.('songchange', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  new MutationObserver((records) => {
    if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
      node.nodeType === 1 && (node.matches?.('button[aria-checked], .main-nowPlayingBar-left') ||
        node.querySelector?.('button[aria-checked], .main-nowPlayingBar-left'))))) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
