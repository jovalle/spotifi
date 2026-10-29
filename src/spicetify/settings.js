(function applySpotifySettings() {
  const settings = window.Spicetify?.Platform?.SettingsAPI;
  if (!settings?.quality || !settings?.playback || !settings?.viewportZoom) {
    setTimeout(applySpotifySettings, 100);
    return;
  }

  const desiredSettings = [
    [settings.quality.streamingQuality, 5],
    [settings.quality.downloadAudioQuality, 5],
    [settings.quality.autoAdjustQuality, false],
    [settings.quality.normalizeVolume, true],
    [settings.quality.volumeLevel, 1],
    [settings.playback.audioCrossfade, true],
    [settings.playback.audioCrossfadeMs, 3000],
    // Spotify sizes the macOS titlebar only for zoom levels in steps of 50.
    [settings.viewportZoom, -100],
  ];

  Promise.all(
    desiredSettings.map(async ([setting, desiredValue]) => {
      if ((await setting.getValue()) !== desiredValue) await setting.setValue(desiredValue);
    }),
  ).catch((error) => console.error('[settings] Failed to apply Spotify settings', error));

  const libraryStyle = document.createElement('style');
  libraryStyle.textContent =
    '.jsh-your-episodes { display: none !important; }';
  document.head.append(libraryStyle);

  // shortcut: reads Spotify's React libraryItem props; update if the library structure changes.
  function hideEpisodes() {
    for (const row of document.querySelectorAll('[role="row"]')) {
      const key = Object.getOwnPropertyNames(row).find((key) => key.startsWith('__reactFiber$'));
      let isEpisodes = false;
      for (let fiber = row[key], level = 0; fiber && level < 40; fiber = fiber.return, level += 1) {
        const item = fiber.memoizedProps?.libraryItem;
        if (!item) continue;
        isEpisodes = item.type === 'your-episodes';
        break;
      }
      row.classList.toggle('jsh-your-episodes', isEpisodes);
    }
  }
  hideEpisodes();
  new MutationObserver((records) => {
    if (records.some(({ target, addedNodes, removedNodes }) =>
      target.closest?.('[role="row"]') ||
      [...addedNodes, ...removedNodes].some((node) => node.nodeType === 1 &&
        (node.matches('[role="row"]') || node.querySelector('[role="row"]')))))
      hideEpisodes();
  }).observe(document.body, { childList: true, subtree: true });

  // Spicetify maps Spotify's macOS (52px) and Windows/Linux (28px) spacers to one class; 28px wins.
  if (/mac/i.test(navigator.userAgentData?.platform || navigator.platform)) {
    const spacerStyle = document.createElement('style');
    spacerStyle.textContent =
      '.main-globalNav-historyButtonsSpacer { height: calc(12px / (var(--zoom-level, 100) / 100)) !important; width: calc(52px / (var(--zoom-level, 100) / 100)) !important; }';
    document.head.append(spacerStyle);
  }

  for (const key of Object.keys(localStorage).filter((key) => key.endsWith(':items-view'))) {
    if (localStorage.getItem(key) === '2') continue;
    localStorage.setItem(key, '2');
    if (sessionStorage.getItem('settings:compact-reload') !== '1') {
      sessionStorage.setItem('settings:compact-reload', '1');
      location.reload();
    }
  }
})();
