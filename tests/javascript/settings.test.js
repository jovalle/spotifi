const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'modules', 'settings', 'settings.js'),
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
    MutationObserver: class { observe() {} },
    document: {
      createElement: () => ({}),
      head: { append: (style) => styles.push(style.textContent) },
      querySelectorAll: () => [],
      body: {},
    },
    localStorage: {},
    navigator: { userAgentData: { platform: 'macOS' }, platform: 'MacIntel' },
    window: { Spicetify: { Platform: { SettingsAPI: settings } } },
  });
  assert.ok(styles.some((style) => /main-globalNav-historyButtonsSpacer/.test(style)));
  assert.ok(styles.some((style) => /\.jsh-your-episodes\s*\{ display: none/.test(style)));
});

test('Your Episodes is hidden without legacy sidebar classes, and recycled rows are restored', () => {
  const setting = { getValue: async () => -100, setValue: async () => {} };
  const settings = {
    quality: Object.fromEntries(['streamingQuality', 'downloadAudioQuality', 'autoAdjustQuality', 'normalizeVolume', 'volumeLevel'].map((key) => [key, setting])),
    playback: { audioCrossfade: setting, audioCrossfadeMs: setting }, viewportZoom: setting,
  };
  const classes = new Set();
  const item = { type: 'your-episodes' };
  const row = {
    closest: () => row,
    __reactFiber$test: { return: { memoizedProps: { libraryItem: item } } },
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
  };
  let observe;
  vm.runInNewContext(source, {
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
    document: {
      createElement: () => ({}), head: { append() {} }, body: {},
      querySelectorAll: (selector) => selector === '[role="row"]' ? [row] : [],
    },
    localStorage: {}, navigator: { platform: 'Linux' },
    window: { Spicetify: { Platform: { SettingsAPI: settings } } },
  });
  assert.ok(classes.has('jsh-your-episodes'));
  item.type = 'playlist';
  observe([{ target: row, addedNodes: [], removedNodes: [] }]);
  assert.equal(classes.has('jsh-your-episodes'), false);
  item.type = 'your-episodes';
  observe([{ target: row, addedNodes: [], removedNodes: [] }]);
  assert.ok(classes.has('jsh-your-episodes'));
  delete row.__reactFiber$test;
  observe([{ target: row, addedNodes: [], removedNodes: [] }]);
  assert.equal(classes.has('jsh-your-episodes'), false);
});
