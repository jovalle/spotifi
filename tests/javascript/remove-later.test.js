const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('remove control follows the center of the current Add button without changing its layout', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../modules/library-controls/remove-later.js'), 'utf8');
  const state = { uri: 'spotify:track:one', mode: 'remove', selected: false };
  let render;
  let currentButton;
  let rect = { left: 100, top: 200, bottom: 216, width: 16 };
  const native = { getBoundingClientRect: () => rect,
    __reactFiber$test: { memoizedProps: { uri: state.uri, curateDefault() {} } } };
  const api = { deferredState: () => state, onDeferredChange: (fn) => { render = fn; }, toggleDeferred() {} };
  const Spicetify = { Player: { addEventListener() {} } };
  const document = {
    head: { append() {} }, body: { append: (node) => { currentButton = node; } },
    createElement: () => ({ style: {}, setAttribute(name, value) { this[name] = value; }, addEventListener() {}, remove() {} }),
    querySelectorAll: (selector) => selector.includes('[data-testid="now-playing-widget"]') ? [native] : [],
  };
  vm.runInNewContext(source, { window: { Spicetify, JshMusic: { add: api }, addEventListener() {} },
    Spicetify, document, MutationObserver: class { observe() {} }, requestAnimationFrame: (fn) => fn() });
  assert.equal(currentButton.style.left, '108px');
  assert.equal(currentButton.style.top, '220px');
  rect = { left: 150, top: 250, bottom: 274, width: 24 };
  state.selected = true;
  render();
  assert.equal(currentButton.style.left, '162px');
  assert.equal(currentButton.style.top, '278px');
  assert.equal(currentButton['aria-pressed'], 'true');
});
