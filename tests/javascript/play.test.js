const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'spicetify', 'play.js'), 'utf8');
const document = {
  head: { append() {} },
  createElement: () => ({}),
  querySelector: () => null,
};
const setInterval = () => {};

test('quality text is hidden before the playback API is ready', () => {
  const styles = [];
  const startupDocument = { ...document, head: { append: (style) => styles.push(style) } };
  vm.runInNewContext(source, { document: startupDocument, window: {}, setTimeout() {} });
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.main-trackInfo-overlay:has\(button\) \{ display: none !important; \}/);
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

  vm.runInNewContext(source, { console, document, setInterval, Spicetify, Uint32Array, URLSearchParams, window });
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
  const Spicetify = {
    Platform: {
      History: {
        listen() {},
        location: { pathname: '/' },
        push(value) {
          pushed.push(typeof value === 'string' ? value : { pathname: value.pathname, search: value.search });
        },
      },
    },
    Player: { data: playerData, playUri() {} },
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
  vm.runInNewContext(source, { console, document, setInterval, Element, Spicetify, URLSearchParams, window, ...environment });

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
  return { event, pushed, Spicetify, play: window.JshMusic.play };
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
    setInterval: (callback) => { refresh = callback; },
    MutationObserver: class { observe() {} },
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, '');
  assert.ok(classes.has('jsh-queue-button'));
  assert.equal(attributes['aria-describedby'], children[0].id);

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
        '?uid=row1&uri=spotify%3Atrack%3At1&page=2&pageUri=spotify%3Aplaylist%3Aabc%3Apage%3A2&index=37',
    },
  ]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

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
