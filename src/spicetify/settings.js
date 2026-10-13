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
