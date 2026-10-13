const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'spicetify', 'settings.js'),
  'utf8',
);

test('macOS reserves space for window controls', () => {
  const styles = [];
  const setting = { getValue: async () => -100, setValue: async () => {} };
  const settings = {
    quality: Object.fromEntries(
      [
        'streamingQuality',
        'downloadAudioQuality',
        'autoAdjustQuality',
        'normalizeVolume',
        'volumeLevel',
      ].map((key) => [key, setting]),
    ),
    playback: { audioCrossfade: setting, audioCrossfadeMs: setting },
    viewportZoom: setting,
  };
  vm.runInNewContext(source, {
    document: {
      createElement: () => ({}),
      head: { append: (style) => styles.push(style.textContent) },
    },
    localStorage: {},
    navigator: { userAgentData: { platform: 'macOS' }, platform: 'MacIntel' },
    window: { Spicetify: { Platform: { SettingsAPI: settings } } },
  });
  assert.match(styles[0], /main-globalNav-historyButtonsSpacer/);
});
