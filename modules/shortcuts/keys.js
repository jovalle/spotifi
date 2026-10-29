(function keys() {
  if (!window.Spicetify?.Player?.skipBack) {
    setTimeout(keys, 250);
    return;
  }

  const OVERLAY_ID = 'jsh-keys';
  const SEEK_MS = 10000;
  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const names = isMac
    ? { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
    : { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  Object.assign(names, { left: '←', right: '→', up: '↑', down: '↓' });
  const k = (combo) => combo.split(' ').map((part) => names[part] || part);
  let overlay = null;
  let lastSeek = 0;

  function sections() {
    const list = [
      [
        'Playback',
        [
          ['Play or pause', k('Space')],
          ['Rewind 10 seconds', k('shift left')],
          ['Fast-forward 10 seconds', k('shift right')],
          ['Previous or next track', k('mod left'), k('mod right')],
          ['Volume down or up', k('mod down'), k('mod up')],
          ['Shuffle', k('mod S')],
          ['Repeat', k('mod R')],
        ],
      ],
      [
        'Playing track',
        [
          ['Add to playlists', k('mod shift P')],
          ['Like', k('mod shift L')],
          ['Love', k('mod alt shift L')],
          ['Lyrics window', k('mod alt L')],
        ],
      ],
      [
        'Add to playlists',
        [
          ['Choose a playlist', k('up'), k('down')],
          ['Add or remove', k('Enter'), k('Space')],
          ['Close', k('Esc')],
        ],
        'Type to filter playlists.',
      ],
      [
        'Lyrics window',
        [
          ['Resume following', k('S')],
          ['Smaller or larger text', k('alt −'), k('alt +')],
          ['Reset text size', k('alt 0')],
          ['Close', k('Esc')],
        ],
        'Right-click the lyrics to sync them.',
      ],
      [
        'Spotify',
        [
          ['Search', k('mod K')],
          ['Spotify shortcuts', k('mod /')],
          ['These shortcuts', isMac ? k('ctrl alt mod /') : k('ctrl alt /')],
        ],
      ],
    ];
    if (isMac && window.JshMiniBridge) {
      const config = window.JshMusic?.mini?.shortcuts;
      const mods = typeof config?.modifiers === 'string' ? config.modifiers : '⌃⌥⌘';
      const keys = Array.isArray(config?.keys) ? config.keys : ['m', 'h', 'l', 'p', 'r'];
      const m = (key) => [...mods, String(key).toUpperCase()];
      list.push([
        'Mini player · any app',
        [
          ['Show or hide', m(keys[0])],
          ['Love', m(keys[1])],
          ['Like', m(keys[2])],
          ['Add to playlists', m(keys[3])],
          ['Remove or undo', m(keys[4])],
          ['Previous or next track', m('←'), m('→')],
          ['Rewind or fast-forward 10 seconds', m('<'), m('>')],
          ['These shortcuts', m('/')],
        ],
        'Track actions work while the mini player is visible.',
      ]);
    }
    return list;
  }

  function close() {
    if (!overlay) return;
    overlay.root.remove();
    overlay.restore?.focus?.();
    overlay = null;
  }

  function open() {
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.innerHTML = `
      <style>
        #${OVERLAY_ID} { --keys-fill: var(--background-tinted-base, var(--spice-card, #3e3e3e)); --keys-subtext: var(--text-subdued, var(--spice-subtext, #b3b3b3)); --keys-surface: var(--background-elevated-base, var(--spice-main, #282828)); --keys-text: var(--text-base, var(--spice-text, #fff)); align-items: center; background-color: rgb(0 0 0 / 72%); box-sizing: border-box; color: var(--keys-text); display: flex; inset: 0; justify-content: center; padding: 24px; position: fixed; z-index: 1000; }
        #${OVERLAY_ID} * { box-sizing: border-box; }
        #${OVERLAY_ID} .panel { background-color: var(--keys-surface); border: 1px solid rgb(255 255 255 / 8%); border-radius: 8px; box-shadow: 0 20px 64px rgb(0 0 0 / 55%); display: flex; flex-direction: column; max-height: calc(100vh - 48px); outline: none; overflow: hidden; width: min(780px, 100%); }
        #${OVERLAY_ID} header { align-items: baseline; display: flex; gap: 16px; justify-content: space-between; padding: 20px 20px 12px; }
        #${OVERLAY_ID} h2 { font-size: 22px; font-weight: 700; line-height: 27px; margin: 0; }
        #${OVERLAY_ID} .hint, #${OVERLAY_ID} .note, #${OVERLAY_ID} .sep { color: var(--keys-subtext); font-size: 12px; line-height: 18px; }
        #${OVERLAY_ID} .groups { column-gap: 12px; columns: 2 320px; overflow: auto; padding: 0 16px 16px; }
        #${OVERLAY_ID} .group { background-color: var(--keys-fill); border-radius: 6px; break-inside: avoid; margin-bottom: 12px; padding: 12px; }
        #${OVERLAY_ID} h3 { color: var(--keys-subtext); font-size: 11px; font-weight: 700; letter-spacing: 0.1em; line-height: 16px; margin: 0 0 4px; text-transform: uppercase; }
        #${OVERLAY_ID} .row { align-items: center; display: flex; gap: 12px; justify-content: space-between; min-height: 32px; }
        #${OVERLAY_ID} .label { font-size: 14px; line-height: 20px; }
        #${OVERLAY_ID} .keys { align-items: center; display: flex; flex-shrink: 0; gap: 4px; }
        #${OVERLAY_ID} .combo { display: inline-flex; gap: 2px; }
        #${OVERLAY_ID} kbd { background-color: var(--keys-surface); border: 1px solid rgb(255 255 255 / 12%); border-bottom-width: 2px; border-radius: 4px; color: var(--keys-text); font: inherit; font-size: 12px; font-weight: 600; line-height: 18px; min-width: 24px; padding: 1px 6px; text-align: center; }
        #${OVERLAY_ID} .note { margin: 6px 0 0; }
        @media (max-width: 480px) { #${OVERLAY_ID} { padding: 12px; } #${OVERLAY_ID} .panel { max-height: calc(100vh - 24px); } }
      </style>
    `;

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.tabIndex = -1;
    panel.setAttribute('aria-labelledby', `${OVERLAY_ID}-title`);
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('role', 'dialog');
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.id = `${OVERLAY_ID}-title`;
    title.textContent = 'Keyboard shortcuts';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Esc to close';
    header.append(title, hint);

    const groups = document.createElement('div');
    groups.className = 'groups';
    for (const [name, rows, note] of sections()) {
      const group = document.createElement('div');
      group.className = 'group';
      const heading = document.createElement('h3');
      heading.textContent = name;
      group.append(heading);
      for (const [label, ...combos] of rows) {
        const row = document.createElement('div');
        row.className = 'row';
        const text = document.createElement('span');
        text.className = 'label';
        text.textContent = label;
        const keysCell = document.createElement('span');
        keysCell.className = 'keys';
        combos.forEach((combo, index) => {
          if (index) {
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.textContent = '/';
            keysCell.append(sep);
          }
          const chips = document.createElement('span');
          chips.className = 'combo';
          for (const cap of combo) {
            const kbd = document.createElement('kbd');
            kbd.textContent = cap;
            chips.append(kbd);
          }
          keysCell.append(chips);
        });
        row.append(text, keysCell);
        group.append(row);
      }
      if (note) {
        const paragraph = document.createElement('p');
        paragraph.className = 'note';
        paragraph.textContent = note;
        group.append(paragraph);
      }
      groups.append(group);
    }

    panel.append(header, groups);
    root.append(panel);
    root.addEventListener('mousedown', (event) => {
      if (event.target === root) close();
    });
    overlay = { root, restore: document.activeElement };
    document.body.append(root);
    requestAnimationFrame(() => panel.focus());
  }

  function toggle() {
    if (overlay?.root.isConnected) close();
    else open();
  }

  function editable(target) {
    return Boolean(
      target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"]'),
    );
  }

  function handleKeyDown(event) {
    if (overlay && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    // Option changes event.key on macOS, so match the physical slash key.
    if (
      event.code === 'Slash' &&
      event.ctrlKey &&
      event.altKey &&
      !event.shiftKey &&
      event.metaKey === isMac
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
      return;
    }
    // Replace Spotify's native Shift+Arrow seek step (5s for tracks) with 10s.
    const direction = { ArrowLeft: 'skipBack', ArrowRight: 'skipForward' }[event.key];
    if (
      !direction ||
      !event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      editable(event.target)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - lastSeek < 150) return;
    lastSeek = Date.now();
    Spicetify.Player[direction](SEEK_MS);
  }

  window.addEventListener('keydown', handleKeyDown, true);
  window.JshMusic ||= {};
  window.JshMusic.keys = { toggle };
})();
