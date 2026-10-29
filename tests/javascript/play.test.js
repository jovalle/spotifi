const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'modules', 'playback', 'play.js'), 'utf8');
const document = {
  head: { append() {} },
  createElement: () => ({}),
  querySelector: () => null,
};
const setInterval = () => {};

test('quality text is hidden before the playback API is ready', () => {
  const styles = [];
  const startupDocument = { ...document, head: { append: (style) => styles.push(style) } };
  vm.runInNewContext(source, { MutationObserver: class { observe() {} }, document: startupDocument, window: {}, setTimeout() {} });
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.main-trackInfo-overlay:has\(button\) \{ display: none !important; \}/);
});

for (const modern of [false, true]) test(`seek controls stay between wrapped Spotify controls after a re-render (${modern ? 'current' : 'legacy'} layout)`, () => {
  class Node {
    constructor(name) { this.name = name; this.children = []; this.className = ''; }
    append(child) {
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      child.parentElement = this;
      this.children.push(child);
    }
    get previousElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1]; }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1]; }
    insert(node, offset) {
      const parent = this.parentElement;
      if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1);
      parent.children.splice(parent.children.indexOf(this) + offset, 0, node);
      node.parentElement = parent;
    }
    before(node) { this.insert(node, 0); }
    after(node) { this.insert(node, 1); }
    closest(selector) {
      let node = this;
      while (node && node.name !== (selector === '[data-testid="general-controls"]' ? 'general-controls' : selector.slice(1))) node = node.parentElement;
      return node;
    }
  }
  const controls = new Node('general-controls');
  const left = new Node(modern ? 'left' : 'player-controls__left');
  const right = new Node(modern ? 'right' : 'player-controls__right');
  controls.append(left); controls.append(new Node('play')); controls.append(right);
  const wrap = (parent, name) => { const wrapper = new Node(name); const button = new Node(name + '-button'); parent.append(wrapper); wrapper.append(button); return button; };
  wrap(left, 'shuffle');
  let previous = wrap(left, 'previous');
  const next = wrap(right, 'next');
  wrap(right, 'repeat');
  const seek = (direction) => [...left.children, ...right.children].find((node) => node.className.includes(`jsh-seek-${direction}`));
  const bar = {
    querySelector(selector) {
      if (selector.includes('skip-back')) return previous;
      if (selector.includes('skip-forward')) return next;
      if (selector === '.jsh-seek-back') return seek('back');
      if (selector === '.jsh-seek-forward') return seek('forward');
      return null;
    },
    querySelectorAll: () => [seek('back'), seek('forward')].filter(Boolean),
  };
  let decorate;
  const Spicetify = {
    Player: { data: {}, playUri() {}, addEventListener: (_, listener) => { decorate = listener; } },
    Platform: { History: { location: { pathname: '/' }, listen() {} } },
  };
  const playerDocument = { ...document, body: {}, createElement: () => new Node('seek'), querySelector: (selector) => modern ? (selector.includes('[data-testid="now-playing-bar"]') ? bar : null) : (selector.includes('.main-nowPlayingBar-nowPlayingBar') ? bar : null) };
  vm.runInNewContext(source, { document: playerDocument, window: { Spicetify, addEventListener() {} }, Spicetify, MutationObserver: class { observe() {} } });
  const names = (group) => group.children.map((node) => node.className.includes('jsh-seek-') ? node.className.split(' ').at(-1) : node.name);
  assert.deepEqual(names(left), ['shuffle', 'jsh-seek-back', 'previous']);
  assert.deepEqual(names(right), ['next', 'jsh-seek-forward', 'repeat']);
  left.children.pop();
  previous = wrap(left, 'previous');
  decorate();
  assert.deepEqual(names(left), ['shuffle', 'jsh-seek-back', 'previous']);
});

async function runRoute(pathname, randomValues, options = {}) {
  const playlistItems = options.rootItems || [
    { name: 'First', uri: 'spotify:playlist:first', type: 'playlist' },
    {
      items: [{ name: 'Second', uri: 'spotify:playlist:second', type: 'playlist' }],
      type: 'folder',
    },
  ];
  const calls = {
    contextualShuffle: null,
    history: [],
    library: null,
    notifications: [],
    play: null,
    playlist: [],
    rootlist: 0,
    shuffle: [],
  };
  const Spicetify = {
    Platform: {
      LibraryAPI: {
        async getTracks(options) {
          calls.library = options;
          return { items: Array.from({ length: 5 }, (_, index) => ({ uri: `track:${index}` })) };
        },
      },
      History: {
        listen() {},
        location: { pathname },
        replace(value) {
          calls.history.push(value);
          calls.replace = value;
        },
      },
      PlaylistAPI: {
        async getContents(uri, requestOptions) {
          calls.playlist.push({ options: requestOptions, uri });
          return options.playlists?.[uri] || { items: [], totalLength: 7 };
        },
      },
      RootlistAPI: {
        async getContents() {
          calls.rootlist += 1;
          return { items: playlistItems };
        },
      },
    },
    Player: {
      data: { context: { uri: 'spotify:playlist:current' } },
      origin: {
        _contextualShuffle: {
          async setContextualShuffleMode(uri, mode) {
            calls.contextualShuffle = { mode, uri };
          },
        },
      },
      async playUri(...args) {
        calls.play = args;
      },
      getShuffle: () => options.shuffle ?? false,
      setShuffle(value) {
        calls.shuffle.push(value);
      },
    },
    URI: {
      fromString(uri) {
        return { toURLPath: () => `/context/${uri}` };
      },
    },
    showNotification(message) {
      calls.notifications.push(message);
    },
  };
  const window = {
    Spicetify,
    addEventListener() {},
    crypto: {
      getRandomValues(value) {
        value[0] = randomValues.shift();
        return value;
      },
    },
  };

  vm.runInNewContext(source, { MutationObserver: class { observe() {} }, console, document, setInterval, Spicetify, Uint32Array, URLSearchParams, window });
  if (options.randomize) await window.JshMusic.play.randomize(options.validate);
  for (let attempt = 0; attempt < 20 && !calls.play; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(calls.play, 'shuffle route did not start playback');
  assert.deepEqual(calls.notifications, []);
  return calls;
}

test('default play starts sequentially from a random Liked Songs position', async () => {
  const calls = await runRoute('/search/spotifi-play-library-sequential-test', [0, 3]);

  assert.deepEqual(calls.shuffle, [false, false]);
  assert.equal(
    JSON.stringify(calls.play),
    JSON.stringify(['spotify:collection:tracks', {}, { skipTo: { index: 3 } }]),
  );
  assert.equal(JSON.stringify(calls.library), JSON.stringify({ offset: 0, limit: 50000 }));
});

test('default play starts sequentially from a random playlist position', async () => {
  const calls = await runRoute('/search/spotifi-play-library-sequential-test', [1, 4]);

  assert.deepEqual(calls.shuffle, [false, false]);
  assert.equal(
    JSON.stringify(calls.play),
    JSON.stringify(['spotify:playlist:first', {}, { skipTo: { index: 4 } }]),
  );
  assert.equal(
    JSON.stringify(calls.playlist[0]),
    JSON.stringify({
      options: { offset: 0, limit: 1 },
      uri: 'spotify:playlist:first',
    }),
  );
});

test('liked selector starts at a random Liked Songs position', async () => {
  const calls = await runRoute('/search/spotifi-play-liked-sequential-test', [0, 2]);

  assert.equal(
    JSON.stringify(calls.play),
    JSON.stringify(['spotify:collection:tracks', {}, { skipTo: { index: 2 } }]),
  );
});

test('playlist selector starts a random saved playlist from the beginning', async () => {
  const calls = await runRoute('/search/spotifi-play-playlist-sequential-test', [1]);

  assert.equal(calls.rootlist, 1);
  assert.deepEqual(calls.play, ['spotify:playlist:second']);
});

test('180g selector deduplicates albums and plays one from the beginning', async () => {
  const calls = await runRoute('/search/spotifi-play-180g-sequential-test', [1], {
    rootItems: [{ name: '180g', type: 'playlist', uri: 'spotify:playlist:180g' }],
    playlists: {
      'spotify:playlist:180g': {
        items: [
          { album: { uri: 'spotify:album:first' } },
          { album: { uri: 'spotify:album:first' } },
          { album: { uri: 'spotify:album:second' } },
        ],
        totalLength: 3,
      },
    },
  });

  assert.equal(calls.history[0], '/');
  assert.deepEqual(calls.play, ['spotify:album:second']);
  assert.equal(calls.history.at(-1), '/context/spotify:album:second');
});

test('shuffle modifier enables normal shuffle after selecting playback', async () => {
  const calls = await runRoute('/search/spotifi-play-liked-shuffle-test', [0, 2]);

  assert.deepEqual(calls.shuffle, [false, true]);
  assert.equal(calls.contextualShuffle, null);
});

test('smart-shuffle modifier enables contextual smart shuffle', async () => {
  const calls = await runRoute('/search/spotifi-play-liked-smart-shuffle-test', [0, 2]);

  assert.deepEqual(calls.shuffle, [false]);
  assert.deepEqual(calls.contextualShuffle, { mode: 2, uri: 'spotify:collection:tracks' });
});

class Element {
  constructor(selector) {
    this.selector = selector;
  }

  closest(selector) {
    return selector.split(', ').includes(this.selector) ? this : null;
  }

  getAttribute(name) {
    return name === 'href' ? '/album/actual' : null;
  }
}

const barTitle = '.main-nowPlayingWidget-trackInfo .main-trackInfo-name a';

function clickTitle(playerData, eventOverrides = {}, environment = {}) {
  const pushed = [];
  const listeners = [];
  let onSongChange;
  let onQueueChange;
  const Spicetify = {
    Platform: {
      PlayerAPI: { getEvents: () => ({ addListener(type, callback) { if (type === 'queue_update') onQueueChange = callback; } }) },
      History: {
        listen() {},
        location: { pathname: '/' },
        push(value) {
          pushed.push(typeof value === 'string' ? value : { pathname: value.pathname, search: value.search });
        },
      },
    },
    Player: { data: playerData, playUri() {}, addEventListener(type, callback) { if (type === 'songchange') onSongChange = callback; } },
    URI: {
      fromString(uri) {
        const [, type, id] = uri.split(':');
        return { toURLPath: () => `/${type}/${id}` };
      },
    },
  };
  const window = {
    Spicetify,
    addEventListener(type, listener, capture) {
      listeners.push({ capture, listener, type });
    },
  };
  Object.assign(Spicetify.Platform, environment.platform || {});
  vm.runInNewContext(source, { MutationObserver: class { observe() {} }, console, document, setInterval, setTimeout, Element, Spicetify, URLSearchParams, window, ...environment });

  const event = {
    button: 0,
    defaultPrevented: false,
    propagationStopped: false,
    target: new Element(barTitle),
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...eventOverrides,
  };
  for (const { capture, listener, type } of listeners) {
    if (type === 'click' && capture) listener(event);
  }
  return { event, pushed, Spicetify, onSongChange, onQueueChange, play: window.JshMusic.play };
}

test('Queue embeds a badge for upcoming tracks and hides empty or unavailable queues', () => {
  let refresh;
  const children = [];
  const classes = new Set();
  const attributes = {};
  const queue = {
    classList: { add: (name) => classes.add(name) },
    querySelector: () => children.find((child) => child.className === 'jsh-queue-count'),
    setAttribute: (name, value) => { attributes[name] = value; },
    append: (child) => children.push(child),
  };
  const bar = {
    querySelector: (selector) => selector === '[data-testid="control-button-queue"]' ? queue : null,
    querySelectorAll: () => [],
  };
  const h = clickTitle({}, {}, {
    document: {
      ...document,
      createElement: () => ({ textContent: '' }),
      querySelector: (selector) => selector === '.main-nowPlayingBar-nowPlayingBar' ? bar : null,
    },
    setInterval: () => assert.fail('Player UI must not poll'),
    MutationObserver: class { observe() {} },
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, '');
  assert.ok(classes.has('jsh-queue-button'));
  assert.equal(attributes['aria-describedby'], children[0].id);

  refresh = h.onQueueChange;
  h.Spicetify.Queue = {
    track: { uri: 'spotify:track:current' },
    prevTracks: [{ uri: 'spotify:track:previous' }],
    nextTracks: [
      { contextTrack: { uri: 'spotify:track:manual' }, provider: 'queue' },
      { contextTrack: { uri: 'spotify:track:next' }, provider: 'context' },
      { contextTrack: { metadata: { hidden: 'true' } }, removed: ['context/delimiter'] },
      { contextTrack: { uri: 'spotify:track:prefetched', metadata: { hidden: 'true' } }, provider: 'context' },
    ],
  };
  refresh();
  assert.equal(children[0].textContent, '2');
  assert.equal(children[0].ariaLabel, '2 tracks remaining in queue');
  h.Spicetify.Queue.nextTracks.splice(1, 1);
  refresh();
  assert.equal(children[0].textContent, '1');
  assert.equal(children[0].ariaLabel, '1 track remaining in queue');
  h.Spicetify.Queue.nextTracks = Array.from({ length: 123 }, () => ({ uri: 'spotify:track:next' }));
  refresh();
  assert.equal(children[0].textContent, '123');
  h.Spicetify.Queue.nextTracks = [];
  refresh();
  assert.equal(children[0].textContent, '');
  assert.equal(children[0].ariaLabel, '');
  delete h.Spicetify.Queue;
  refresh();
  assert.equal(children[0].textContent, '');
  assert.equal(children.length, 1);
});

test('Queue opens the native sidebar without closing an already open queue', () => {
  let open = false;
  let clicks = 0;
  const button = {
    disabled: false,
    getAttribute: () => String(open),
    click() { clicks++; open = true; },
  };
  const h = clickTitle({}, {}, {
    document: { ...document, querySelector: (selector) => selector.includes('control-button-queue') ? button : null },
  });
  h.play.openQueue();
  h.play.openQueue();
  assert.equal(clicks, 1);
  button.disabled = true;
  assert.throws(() => h.play.openQueue(), /Queue unavailable/);
  assert.throws(() => clickTitle({}).play.openQueue(), /Queue unavailable/);
});

test('Queue toggles in both directions when explicitly requested', () => {
  let open = false;
  const button = {
    disabled: false,
    getAttribute: () => String(open),
    click() { open = !open; },
  };
  const h = clickTitle({}, {}, {
    document: { ...document, querySelector: (selector) => selector.includes('control-button-queue') ? button : null },
  });
  h.play.openQueue(true);
  assert.equal(open, true);
  h.play.openQueue(true);
  assert.equal(open, false);
  button.disabled = true;
  assert.throws(() => h.play.openQueue(true), /Queue unavailable/);
});

test('now-playing title highlights the playing row in its playlist', () => {
  const { event, pushed } = clickTitle({
    context: { uri: 'spotify:playlist:abc' },
    item: { uid: 'row1', uri: 'spotify:track:t1' },
    index: { pageIndex: 2, pageURI: 'spotify:playlist:abc:page:2', itemIndex: 37 },
  });

  assert.deepEqual(pushed, [
    {
      pathname: '/playlist/abc',
      search:
        '?uri=spotify%3Atrack%3At1&page=2&pageUri=spotify%3Aplaylist%3Aabc%3Apage%3A2&index=37',
    },
  ]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test('playlist navigation is immediate and reads only the current position', async () => {
  const reads = [];
  const calls = [];
  const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: {
    scrollToIndex: (index) => calls.push(index),
  } } } } };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const env = { platform: { History: history, PlaylistAPI: { getContents: async (uri, options) => {
    reads.push({ uri, ...options });
    return { items: [{ uri: 'spotify:track:t1', uid: 'playlist-row' }] };
  } } }, document: { ...document, querySelector: (selector) => selector === '.main-trackList-trackList' ? list : null } };
  const h = clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uid: 'queue-id', uri: 'spotify:track:t1', provider: 'queue' }, index: { itemIndex: 37 } }, {}, env);
  assert.equal(history.location.pathname, '/playlist/abc');
  assert.doesNotMatch(history.location.search, /uid=/);
  assert.equal(h.event.defaultPrevented, true);
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(reads)), [{ uri: 'spotify:playlist:abc', offset: 37, limit: 1 }]);
  assert.deepEqual(calls, [37]);
});

test('a mismatched playback index never scrolls to a different song', async () => {
  const calls = [];
  const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: { scrollToIndex: (index) => calls.push(index) } } } } };
  const env = { platform: { PlaylistAPI: { getContents: async () => ({ items: [{ uri: 'spotify:track:other' }] }) } },
    document: { ...document, querySelector: (selector) => selector === '.main-trackList-trackList' ? list : null } };
  const h = clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uri: 'spotify:track:t1' }, index: { itemIndex: 4 } }, {}, env);
  assert.equal(h.pushed[0].pathname, '/playlist/abc');
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
});

test('missing playback position finds the track in small batches after immediate navigation', async () => {
  const reads = [];
  const calls = [];
  const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: {
    scrollToIndex: (index) => calls.push(index),
  } } } } };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const env = { platform: { History: history, PlaylistAPI: { getContents: async (_uri, options) => {
    reads.push(options.offset);
    return options.offset === 0
      ? { items: Array.from({ length: 100 }, () => ({ uri: 'spotify:track:other' })), totalLength: 101 }
      : { items: [{ uri: 'spotify:track:t1' }], totalLength: 101 };
  } } }, document: { ...document, querySelector: (selector) => selector === '.main-trackList-trackList' ? list : null } };
  clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uri: 'spotify:track:t1' } }, {}, env);
  assert.equal(history.location.pathname, '/playlist/abc');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reads, [0, 100]);
  assert.deepEqual(calls, [100]);
});

test('large playlist uses lightweight Spotify rows and scrolls the real viewport', async () => {
  const reads = [];
  const scroller = { scrollTop: 0, clientHeight: 600, getBoundingClientRect: () => ({ top: 50 }) };
  const list = { closest: () => scroller, getBoundingClientRect: () => ({ top: 450 }),
    querySelector: () => ({ offsetHeight: 36 }) };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const api = { getContents: async (_uri, options) => {
    assert.equal(options.offset, 2999);
    return { items: [{ uri: 'spotify:track:t1', uid: 'row2999' }] };
  },
    _playlistDataClient: { get: async (request) => {
      reads.push(request);
      return { data: { item: Array.from({ length: 3001 }, (_, i) => ({
        uri: i === 2999 ? 'spotify:track:t1' : 'spotify:track:other', rowId: `row${i}`,
      })) } };
    } } };
  const env = { platform: { History: history, PlaylistAPI: api },
    document: { ...document, querySelector: (selector) => selector.includes('main-trackList-trackList') ? list : null },
    getComputedStyle: () => ({ getPropertyValue: () => '56px' }) };
  clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uid: 'row2999', uri: 'spotify:track:t1' } }, {}, env);
  assert.equal(history.location.pathname, '/playlist/abc');
  await new Promise(setImmediate);
  assert.equal(reads.length, 1);
  assert.equal(scroller.scrollTop, 400 + 36 + 2999 * 56 - 300);
});

test('jump waits for the virtualized playing row and centers that row', async () => {
  const timers = [];
  let revealed = false;
  let centered = false;
  let requestedIndex = null;
  const row = { __reactFiber$test: { memoizedProps: { uri: 'spotify:track:t1' } },
    scrollIntoView: (options) => { centered = options.block === 'center'; } };
  const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: {
    scrollToIndex: (index) => { requestedIndex = index; },
  } } } }, querySelectorAll: () => revealed ? [row] : [] };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const env = { platform: { History: history, PlaylistAPI: { getContents: async () => ({ items: [{ uri: 'spotify:track:t1' }] }) } },
    document: { ...document, querySelector: (selector) => selector.includes('main-trackList-trackList') ? list : null },
    setTimeout: (fn) => { timers.push(fn); } };
  clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uri: 'spotify:track:t1' }, index: { itemIndex: 2999 } }, {}, env);
  await new Promise(setImmediate);
  assert.equal(requestedIndex, 2999);
  assert.equal(centered, false, 'the first scroll is not proof of success');
  revealed = true;
  timers.shift()();
  assert.equal(centered, true);
});

test('a compacted lightweight response falls back to the exact playlist occurrence', async () => {
  const calls = [];
  const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: {
    scrollToIndex: (index) => calls.push(index),
  } } } } };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const api = { _playlistDataClient: { get: async () => ({ data: { item: [
    { uri: 'spotify:track:t1', rowId: 'exact' },
  ] } }) }, getContents: async (_uri, { offset, limit }) => ({ items: limit === 1
    ? [{ uri: 'spotify:track:other' }]
    : [{ uri: 'spotify:track:t1', uid: 'duplicate' }, { uri: 'spotify:track:t1', uid: 'exact' }], totalLength: 2 }) };
  const env = { platform: { History: history, PlaylistAPI: api },
    document: { ...document, querySelector: (selector) => selector.includes('main-trackList-trackList') ? list : null } };
  clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uri: 'spotify:track:t1', uid: 'exact' } }, {}, env);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [1]);
});

for (const [state, expectedSortBy] of [
  [{ field: 'ADDED_AT', order: 'DESC' }, 14],
  [{ field: 'TITLE', order: 'ASC' }, 11],
  [{ column: 'TITLE_AND_ARTIST', order: 4 }, 10],
]) {
  test(`jump uses Spotify playlist sort ${JSON.stringify(state)}`, async () => {
    const calls = [];
    const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: {
      scrollToIndex: (index) => calls.push(index),
    } } } } };
    const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
    let request;
    const api = { getContents: async (_uri, options) => {
      assert.equal(options.offset, 1);
      return { items: [{ uri: 'spotify:track:t1', uid: 'exact' }] };
    },
      _playlistDataClient: { get: async (value) => {
        request = value;
        return { data: { item: [{ uri: 'spotify:track:other' }, { uri: 'spotify:track:t1', rowId: 'exact' }] } };
      } } };
    const env = { platform: { History: history, PlaylistAPI: api,
      LocalStorageAPI: { getItem: () => ({ 'spotify:playlist:abc': state }) } },
      document: { ...document, querySelector: (selector) => selector === '.main-trackList-trackList' ? list : null } };
    clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uid: 'exact', uri: 'spotify:track:t1' }, index: { itemIndex: 99 } }, {}, env);
    await new Promise(setImmediate);
    assert.equal(request.query.sortBy, expectedSortBy);
    assert.deepEqual(calls, [1]);
  });
}

test('sorted lookup preserves Spotify sort when the lightweight service is unavailable', async () => {
  const reads = [];
  const calls = [];
  const list = { __reactFiber$test: { memoizedState: { memoizedState: { current: {
    scrollToIndex: (index) => calls.push(index),
  } } } } };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const env = { platform: { History: history,
    LocalStorageAPI: { getItem: () => ({ 'spotify:playlist:abc': { field: 'ARTIST', order: 'DESC' } }) },
    PlaylistAPI: { getContents: async (_uri, options) => {
      reads.push(options);
      return { items: [{ uri: 'spotify:track:other' }, { uri: 'spotify:track:t1' }], totalLength: 2 };
    } } }, document: { ...document, querySelector: (selector) => selector === '.main-trackList-trackList' ? list : null } };
  clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uri: 'spotify:track:t1' } }, {}, env);
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(reads)), [{ offset: 0, limit: 100, sort: { field: 'ARTIST', order: 'DESC' } }]);
  assert.deepEqual(calls, [1]);
});

test('the rendered playlist sort takes precedence over stale saved sort', async () => {
  let request;
  let centered = false;
  const row = { __reactFiber$test: { memoizedProps: { uri: 'spotify:track:t1' } },
    scrollIntoView: () => { centered = true; } };
  const provider = { memoizedProps: { value: { sortState: { field: 'ARTIST', order: 'DESC' }, setSortState() {} } } };
  const list = { __reactFiber$test: { return: provider, memoizedState: { memoizedState: { current: {
    scrollToIndex() {},
  } } } }, querySelectorAll: () => [row] };
  const history = { location: { pathname: '/' }, listen() {}, push(location) { this.location = location; } };
  const env = { platform: { History: history,
    LocalStorageAPI: { getItem: () => ({ 'spotify:playlist:abc': { field: 'TITLE', order: 'ASC' } }) },
    PlaylistAPI: { getContents: async () => ({ items: [{ uri: 'spotify:track:t1' }] }), _playlistDataClient: { get: async (value) => {
      request = value; return { data: { item: [{ uri: 'spotify:track:t1', rowId: 'row' }] } };
    } } } }, document: { ...document, querySelector: (selector) => selector.includes('main-trackList-trackList') ? list : null } };
  clickTitle({ context: { uri: 'spotify:playlist:abc' }, item: { uri: 'spotify:track:t1' } }, {}, env);
  await new Promise(setImmediate);
  assert.equal(request.query.sortBy, 10);
  assert.equal(centered, true);
});

test('navigation does not wait for Spotify and a stale result cannot scroll', async () => {
  let release;
  const reads = [];
  const h = clickTitle({ context: { uri: 'spotify:playlist:abc' },
    item: { uri: 'spotify:track:t1' }, index: { itemIndex: 4 } }, {}, {
    platform: { PlaylistAPI: { getContents: (_uri, options) => {
      reads.push(options);
      return new Promise((resolve) => { release = resolve; });
    } } },
  });
  assert.equal(h.pushed[0].pathname, '/playlist/abc');
  assert.equal(reads.length, 1);
  h.Spicetify.Player.data.item.uri = 'spotify:track:other';
  release({ items: [{ uri: 'spotify:track:t1' }] });
  await new Promise(setImmediate);
  assert.equal(h.pushed.length, 1);
  assert.equal(reads.length, 1);
});

for (const selector of [
  '[data-testid="now-playing-widget"] .main-trackInfo-name a',
  '[data-testid="now-playing-widget-v2"] a[href]:not([data-testid="now-playing-widget-v2-byline"] a)',
  '[data-testid="now-playing-widget"] [data-testid="cover-art-button"]',
  '[data-testid="now-playing-widget-v2"] [data-testid="cover-art-button"]',
  '[data-testid="cover-art-slot"] a[href]',
  '[data-testid="track-visual-enhancement"] a[data-testid="context-link"]',
  '[data-testid="NPV_Panel_OpenDiv"] .main-trackInfo-name a',
  '.hvJdEwDFPYnCjweD6tWI > :first-child a',
]) {
  test(`now-playing target opens and highlights its playlist: ${selector}`, () => {
    const data = {
      context: { uri: 'spotify:playlist:abc' },
      item: { uid: 'row1', uri: 'spotify:track:t1', album: { uri: 'spotify:album:actual' } },
      index: { pageIndex: 2, pageURI: 'spotify:playlist:abc:page:2', itemIndex: 37 },
    };
    const { event, pushed } = clickTitle(data, { target: new Element(selector) });
    assert.deepEqual(pushed, [{
      pathname: '/playlist/abc',
      search: '?uri=spotify%3Atrack%3At1&page=2&pageUri=spotify%3Aplaylist%3Aabc%3Apage%3A2&index=37',
    }]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);

    for (const modifier of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      const native = clickTitle(data, { target: new Element(selector), ...modifier });
      assert.deepEqual(native.pushed, []);
      assert.equal(native.event.defaultPrevented, false);
    }
    const unavailable = clickTitle({}, { target: new Element(selector) });
    assert.deepEqual(unavailable.pushed, []);
    assert.equal(unavailable.event.defaultPrevented, false);
  });
}

test('now-playing view title also opens the playing context', () => {
  const { pushed } = clickTitle(
    {
      context: { uri: 'spotify:collection:tracks' },
      item: { uid: 'row2', uri: 'spotify:track:t2' },
      index: { pageIndex: 0, pageURI: 'spotify:collection:tracks:page:0', itemIndex: 41 },
    },
    { target: new Element('.main-nowPlayingView-trackInfo .main-trackInfo-name a') },
  );

  assert.deepEqual(pushed, [
    {
      pathname: '/collection/tracks',
      search:
        '?uid=row2&uri=spotify%3Atrack%3At2&page=0&pageUri=spotify%3Acollection%3Atracks%3Apage%3A0&index=41',
    },
  ]);
});

test('now-playing title uses the playing item index in an album context', () => {
  const { pushed } = clickTitle({
    context: { uri: 'spotify:album:alb' },
    item: { uid: 'row3', uri: 'spotify:track:t3' },
    index: { pageIndex: 0, itemIndex: 12 },
  });

  assert.deepEqual(pushed, [
    {
      pathname: '/album/alb',
      search: '?uid=row3&uri=spotify%3Atrack%3At3&page=0&index=12',
    },
  ]);
});

test('now-playing title opens the album when the track is its own context', () => {
  const { event, pushed } = clickTitle({
    context: { uri: 'spotify:track:t4' },
    item: { uid: 'row4', uri: 'spotify:track:t4', album: { uri: 'spotify:album:alb' } },
    index: { pageIndex: 0, itemIndex: 0 },
  });

  assert.deepEqual(pushed, [
    {
      pathname: '/album/alb',
      search: '?uid=row4&uri=spotify%3Atrack%3At4&page=0&index=0&highlight=spotify%3Atrack%3At4',
    },
  ]);
  assert.equal(event.defaultPrevented, true);
});

test('modified now-playing title clicks keep native behavior', () => {
  const { event, pushed } = clickTitle(
    {
      context: { uri: 'spotify:playlist:abc' },
      item: { uid: 'row1', uri: 'spotify:track:t1' },
    },
    { metaKey: true },
  );

  assert.deepEqual(pushed, []);
  assert.equal(event.defaultPrevented, false);
});

test('clicks outside the now-playing title are ignored', () => {
  const { event, pushed } = clickTitle(
    {
      context: { uri: 'spotify:playlist:abc' },
      item: { uid: 'row1', uri: 'spotify:track:t1' },
    },
    { target: new Element('.main-trackInfo-artists a') },
  );

  assert.deepEqual(pushed, []);
  assert.equal(event.defaultPrevented, false);
});

test('album link opens the actual album independently of the playing playlist', () => {
  const { event, pushed } = clickTitle({
    context: { uri: 'spotify:playlist:abc' },
    item: { uri: 'spotify:track:t1', album: { uri: 'spotify:album:actual' } },
  }, { target: new Element('.jsh-playing-album') });
  assert.deepEqual(pushed, ['/album/actual']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test('Randomize starts at a random saved playlist position and preserves shuffle', async () => {
  for (const shuffle of [false, true]) {
    const calls = await runRoute('/', [1, 4], { randomize: true, shuffle });
    assert.deepEqual(calls.shuffle, [false, shuffle]);
    assert.equal(calls.library, null);
    assert.equal(JSON.stringify(calls.play), JSON.stringify(['spotify:playlist:second', {}, { skipTo: { index: 4 } }]));
  }
});
test('Randomize skips empty playlists and validates after library reads', async () => {
  const calls = await runRoute('/', [0, 0, 2], { randomize: true, playlists: { 'spotify:playlist:first': { totalLength: 0 } } });
  assert.equal(calls.play[0], 'spotify:playlist:second');
  await assert.rejects(runRoute('/', [], { randomize: true, rootItems: [] }), /No tracks found/);
  await assert.rejects(runRoute('/', [0, 2], { randomize: true, validate() { throw new Error('Spotify account changed'); } }), /Spotify account changed/);
});
