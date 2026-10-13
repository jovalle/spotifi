const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(`${__dirname}/../../src/streamdeck/plugin.js`, 'utf8');

function setup() {
  const sent = [];
  const requests = [];
  const exits = [];
  const opened = [];
  let config = { token: 'a'.repeat(64), port: 47683 };
  let data = { connected: true, busy: false,
    state: { uri: 'spotify:track:one', account: 'one', supported: true, loved: false, liked: false, added: false }, results: [] };
  let postOK = true;
  let losePost = false;
  let offline = false;
  let timer;
  let cleared = false;
  const timeouts = new Map();
  let timeoutId = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map();
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send(message) { sent.push(JSON.parse(message)); }
  }
  const context = vm.createContext({
    require(name) {
      if (name === 'node:fs/promises') return { readFile: async () => JSON.stringify(config) };
      if (name === 'node:child_process') return { execFile: (...args) => { opened.push(JSON.parse(JSON.stringify(args.slice(0, 2)))); args[2](null); } };
      return require(name);
    },
    WebSocket: Socket, AbortSignal, Date, URL, Buffer,
    process: { argv: ['node', 'plugin.js', '-port', '12345', '-pluginUUID', 'com.jovalle.spotifi',
      '-registerEvent', 'registerPlugin'], exit: (code) => exits.push(code) },
    fetch: async (url, options) => {
      requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      if (offline) throw new Error('Disconnected');
      if (losePost && options.method === 'POST') throw new Error('Lost reply');
      return { ok: options.method === 'GET' || postOK,
        json: async () => structuredClone(options.method === 'GET' ? data : { id: 'command-one' }) };
    },
    setInterval(callback) { timer = callback; return 1; },
    clearInterval() { cleared = true; },
    setTimeout(callback, delay) { const id = ++timeoutId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  });
  vm.runInContext(source, context);
  vm.runInContext("contexts.set('key-one', { action: 'love' }); contexts.set('key-two', { action: 'love' })", context);
  return {
    sent, requests, exits, opened, run: (code) => vm.runInContext(code, context),
    replaceFetch: (next) => { context.fetch = next; },
    event: (event, extra = {}) => vm.runInContext('socket', context).listeners.get('message')({
      data: JSON.stringify({ event, action: 'com.jovalle.spotifi.love', context: 'key-one', ...extra }) }),
    socketEvent: (name) => vm.runInContext('socket', context).listeners.get(name)(),
    data: (next) => { data = next; }, current: () => data,
    config: (next) => { config = next; }, failPost: () => { postOK = false; },
    losePost: () => { losePost = true; },
    offline: () => { offline = true; }, tick: () => timer(), cleared: () => cleared,
    async clicks() {
      for (const [id, timeout] of [...timeouts]) {
        if (timeout.delay === 300) { timeouts.delete(id); timeout.callback(); }
      }
      await new Promise(setImmediate);
    },
  };
}

test('registers with Stream Deck and keeps all visible hearts in sync', async () => {
  const app = setup();
  app.socketEvent('open');
  assert.equal(app.sent[0].event, 'registerPlugin');
  assert.equal(app.sent[0].uuid, 'com.jovalle.spotifi');
  await app.run('poll()');
  assert.equal(app.sent.filter((event) => event.event === 'setState' && event.payload.state === 0).length, 2);
  app.current().state.loved = true;
  await app.tick();
  assert.equal(app.sent.filter((event) => event.event === 'setState' && event.payload.state === 1).length, 2);
  const count = app.sent.length;
  await app.tick();
  assert.equal(app.sent.length, count, 'unchanged state must not redraw keys');
  assert.equal(app.requests[0].url, 'http://127.0.0.1:47683/love');
  assert.equal(app.requests[0].headers.Authorization, `Bearer ${'a'.repeat(64)}`);
});

test('sends one guarded toggle and uses only the heart state for success', async () => {
  const app = setup();
  await Promise.all([app.run("press('key-one')"), app.run("press('key-one')")]);
  assert.equal(app.requests.filter((request) => request.method === 'POST').length, 1);
  assert.deepEqual(app.requests.find((request) => request.body).body,
    { action: 'love', uri: 'spotify:track:one', account: 'one', loved: false });
  assert.equal(app.sent.filter((event) => event.event === 'showOk').length, 0);
  await app.run("press('key-two')");
  assert.equal(app.requests.filter((request) => request.method === 'POST').length, 1);
  app.current().state.loved = true;
  app.current().results = [{ id: 'command-one', ok: true }];
  await app.tick();
  assert.equal(app.sent.filter((event) => event.event === 'showOk').length, 0);
  assert.ok(app.sent.some((event) => event.event === 'setState' && event.payload.state === 1));
  await app.run("press('key-one')");
  assert.equal(app.requests.filter((request) => request.method === 'POST').at(-1).body.loved, true);
});

test('Like toggles independently, using the yellow star state and no success flash', async () => {
  const app = setup();
  app.run("contexts.set('key-like', { action: 'like' }); contexts.set('key-add', { action: 'add' })");
  app.current().state.loved = false;
  app.current().state.liked = true;
  await app.tick();
  assert.equal(app.sent.find((event) => event.event === 'setState' && event.context === 'key-one').payload.state, 0);
  assert.equal(app.sent.find((event) => event.event === 'setState' && event.context === 'key-like').payload.state, 1);
  assert.equal(app.sent.find((event) => event.event === 'setState' && event.context === 'key-add').payload.state, 0);
  await app.run("press('key-like')");
  assert.deepEqual(app.requests.find((request) => request.body).body,
    { action: 'like', uri: 'spotify:track:one', account: 'one', liked: true });
  app.current().state.liked = false;
  app.current().results = [{ id: 'command-one', ok: true }];
  await app.tick();
  assert.equal(app.sent.filter((event) => event.event === 'setState' && event.context === 'key-like').at(-1).payload.state, 0);
  assert.ok(!app.sent.some((event) => event.event === 'showOk'));
});

test('Add opens the existing playlist picker without requiring Like or Love to load', async () => {
  const app = setup();
  app.run("contexts.set('key-add', { action: 'add' })");
  app.current().state.liked = null;
  app.current().state.loved = null;
  await app.run("press('key-add')");
  assert.deepEqual(app.requests.find((request) => request.body).body,
    { action: 'add', uri: 'spotify:track:one', account: 'one' });
  app.current().results = [{ id: 'command-one', ok: true }];
  await app.tick();
  assert.ok(!app.sent.some((event) => event.event === 'showOk'));
  assert.equal(app.sent.find((event) => event.event === 'setTitle' && event.context === 'key-add').payload.title, '');
});

test('shows failed or expired confirmation without retrying the toggle', async () => {
  for (const expired of [false, true]) {
    const app = setup();
    await app.run("press('key-one')");
    if (expired) app.run('pending.expires = 0');
    else app.current().results = [{ id: 'command-one', ok: false }];
    await app.tick();
    assert.equal(app.sent.filter((event) => event.event === 'showAlert').length, 1);
    assert.equal(app.requests.filter((request) => request.method === 'POST').length, 1);
    await app.tick();
    assert.equal(app.sent.filter((event) => event.event === 'setState' && event.context === 'key-one').at(-1).payload.state, 0);
  }
});

test('rejects unavailable, loading, unsupported and busy playback', async () => {
  for (const change of [{ connected: false }, { busy: true },
    { state: { supported: false } }, { state: { supported: true, loved: null } }]) {
    const app = setup();
    app.data({ ...app.current(), ...change });
    await app.run("press('key-one')");
    assert.equal(app.requests.filter((request) => request.method === 'POST').length, 0);
    assert.equal(app.sent.filter((event) => event.event === 'showAlert').length, 1);
  }
});

test('rejects invalid local credentials and recovers the display after disconnection', async () => {
  const app = setup();
  app.config({ token: 'bad', port: 80 });
  await app.run("press('key-one')");
  assert.equal(app.requests.length, 0);
  assert.ok(app.sent.some((event) => event.event === 'setTitle' && event.payload.title === 'Offline'));
  app.config({ token: 'a'.repeat(64), port: 47683 });
  await app.tick();
  assert.ok(app.sent.some((event) => event.event === 'setTitle' && event.payload.title === ''));
  app.offline();
  await app.tick();
  assert.equal(app.sent.at(-1).payload.title, '', 'brief failures must not flash Offline');
  app.run('received = Date.now() - 4001');
  await app.tick();
  assert.equal(app.sent.at(-1).payload.title, 'Offline');
});

test('Add follows the client checkmark and still opens Adder in either state', async () => {
  for (const added of [false, true]) {
    const app = setup();
    app.run("contexts.set('key-add', { action: 'add' })");
    app.current().state.added = added;
    await app.tick();
    assert.equal(app.sent.find((event) => event.event === 'setState' && event.context === 'key-add').payload.state, Number(added));
    await app.run("press('key-add')");
    assert.equal(app.requests.find((request) => request.body).body.action, 'add');
    assert.ok(!app.sent.some((event) => event.event === 'showOk'));
  }
});

test('Like fills immediately before the POST replies and ignores old or unknown snapshots', async () => {
  const app = setup();
  app.run("contexts.set('key-like', { action: 'like' })");
  await app.tick();
  let reply;
  const originalFetch = app.run('fetch');
  const delayedFetch = async (url, options) => {
    if (options.method === 'POST') return new Promise((resolve) => { reply = resolve; });
    return originalFetch(url, options);
  };
  // Delay the network acknowledgement, rather than the optimistic render.
  app.replaceFetch(delayedFetch);
  const press = app.run("press('key-like')");
  await new Promise(setImmediate);
  assert.equal(app.sent.filter((event) => event.event === 'setState' && event.context === 'key-like').at(-1).payload.state, 1);
  const titles = app.sent.filter((event) => event.event === 'setTitle').length;
  await app.tick();
  app.current().state.liked = null;
  await app.tick();
  assert.equal(app.sent.filter((event) => event.event === 'setState' && event.context === 'key-like').length, 2);
  assert.equal(app.sent.filter((event) => event.event === 'setTitle').length, titles);
  reply({ ok: true, json: async () => ({ id: 'command-one' }) });
  await press;
  app.current().results = [{ id: 'command-one', ok: true }];
  await app.tick();
  assert.equal(app.sent.filter((event) => event.event === 'setState' && event.context === 'key-like').at(-1).payload.state, 1);
  app.current().state.liked = true;
  await app.tick();
  assert.equal(app.run('pending'), undefined);
});

test('a rejected or lost POST reply never causes an automatic retry', async () => {
  for (const failure of ['failPost', 'losePost']) {
    const app = setup();
    app[failure]();
    await app.run("press('key-one')");
    await app.tick();
    assert.equal(app.requests.filter((request) => request.method === 'POST').length, 1);
    assert.ok(app.sent.some((event) => event.event === 'showAlert'));
  }
});

test('ignores other actions, stops polling hidden keys and exits when Stream Deck closes', async () => {
  const app = setup();
  app.event('keyDown', { action: 'some.other.action' });
  app.event('willDisappear');
  app.event('willDisappear', { context: 'key-two' });
  await app.tick();
  assert.equal(app.requests.length, 0);
  app.socketEvent('close');
  assert.ok(app.cleared());
  assert.deepEqual(app.exits, [0]);
});

test('bottom row sends guarded seek and shuffle actions and changes dice on each press', async () => {
  const app = setup();
  app.current().state.shuffle = false;
  for (const action of ['seek-forward', 'shuffle', 'randomize']) app.run(`contexts.set('${action}', { action: '${action}' })`);
  await app.run('poll()');
  await app.run("press('seek-forward')");
  assert.equal(app.requests.findLast((r) => r.method === 'POST').body.action, 'seek-forward');
  app.current().results = [{ id: 'command-one', ok: true }];
  await app.run('poll()');
  await app.run("press('shuffle')");
  assert.equal(app.requests.findLast((r) => r.method === 'POST').body.shuffle, false);
  assert.ok(app.sent.some((e) => e.context === 'shuffle' && e.event === 'setState' && e.payload.state === 1));
  app.current().state.shuffle = true;
  await app.run('poll()');
  const faces = [app.run("contexts.get('randomize').state")];
  for (let i = 0; i < 8; i++) {
    await app.run("press('randomize')");
    faces.push(app.run("contexts.get('randomize').state"));
    await app.run('poll()');
  }
  for (let i = 1; i < faces.length; i++) {
    assert.ok(faces[i] >= 0 && faces[i] < 6);
    assert.notEqual(faces[i], faces[i - 1]);
  }
});

test('Queue key sends one toggle without needing a current track and never retries a lost reply', async () => {
  const app = setup();
  Object.assign(app.current().state, { uri: '', supported: false });
  app.event('willAppear', { action: 'com.jovalle.spotifi.queue', context: 'queue-key', payload: {} });
  await new Promise(setImmediate);
  app.losePost();
  app.event('keyDown', { action: 'com.jovalle.spotifi.queue', context: 'queue-key' });
  await new Promise(setImmediate);
  const posts = app.requests.filter((r) => r.body);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { action: 'queue-toggle', uri: '', account: 'one' });
  await app.tick();
  assert.equal(app.requests.filter((r) => r.body).length, 1);
  assert.ok(app.sent.some((event) => event.event === 'showAlert' && event.context === 'queue-key'));
  app.current().state.account = '';
  await app.tick();
  await app.run("press('queue-key')");
  assert.equal(app.requests.filter((r) => r.body).length, 1);
});

test('seek layout puts the step hint above time and a bounded gradient bar at the bottom', async () => {
  const layout = JSON.parse(fs.readFileSync(`${__dirname}/../../conf/streamdeck/com.jovalle.spotifi.sdPlugin/layouts/seek.json`, 'utf8'));
  const hint = layout.items.find((item) => item.key === 'status');
  const time = layout.items.find((item) => item.key === 'position');
  const bar = layout.items.find((item) => item.key === 'progress');
  assert.equal(layout.items.some((item) => item.key === 'title'), false);
  assert.ok(hint.rect[1] + hint.rect[3] <= time.rect[1]);
  assert.ok(time.rect[1] + time.rect[3] <= bar.rect[1]);
  assert.ok(bar.rect[0] + bar.rect[2] <= 200 && bar.rect[1] + bar.rect[3] <= 100);
  assert.equal(bar.type, 'bar');
  assert.match(bar.bar_fill_c, /0:#[a-f0-9]{6},0\.5:#[a-f0-9]{6},1:#[a-f0-9]{6}/i);
  const app = setup();
  Object.assign(app.current().state, { position: 12000, duration: 60000, canSeek: true });
  app.event('willAppear', { action: 'com.jovalle.spotifi.seek', context: 'seek-bar', payload: {} });
  await new Promise(setImmediate);
  const feedback = () => app.sent.filter((e) => e.event === 'setFeedback' && e.context === 'seek-bar').at(-1).payload;
  assert.equal(feedback().progress.value, 20);
  await app.run("seekDial('seek-bar', 3)");
  assert.equal(feedback().progress.value, 25);
  assert.equal(feedback().position, '0:15 / 1:00');
  app.current().state.uri = 'spotify:track:new';
  app.current().state.position = 90000;
  await app.tick();
  assert.equal(feedback().progress.value, 100);
  app.current().state.canSeek = false;
  await app.tick();
  assert.equal(feedback().progress.value, 0);
  assert.equal(feedback().position, '--:--');
});
test('Spotify opens without the companion; Randomize and Shuffle work without a current track', async () => {
  const app = setup();
  app.offline();
  await app.run("press('spotify', 'spotify')");
  assert.deepEqual(app.opened, [['/usr/bin/open', ['-b', 'com.spotify.client']]]);
  assert.equal(app.requests.length, 0);
  const second = setup();
  second.current().state = { uri: '', account: 'one', supported: false, shuffle: false };
  second.run("contexts.set('random', { action: 'randomize' }); contexts.set('shuffle', { action: 'shuffle' })");
  await second.run('poll()');
  await second.run("press('random')");
  assert.equal(second.requests.findLast((r) => r.method === 'POST').body.action, 'randomize');
  second.current().results = [{ id: 'command-one', ok: true }];
  await second.run('poll()');
  await second.run("press('shuffle')");
  assert.equal(second.requests.findLast((r) => r.method === 'POST').body.action, 'shuffle');
});

function dialSetup() {
  const app = setup();
  app.current().state.playlistSelector = { ready: true, playlists: [
    { uri: 'spotify:playlist:one', name: 'First', saved: true, recent: 1 },
    { uri: 'spotify:playlist:two', name: 'Second', saved: false, recent: 0 },
    { uri: 'spotify:playlist:three', name: 'Third', saved: false, recent: 2 },
  ] };
  app.run("contexts.set('dial', { action: 'playlist' })");
  return app;
}

test('dial scrolls locally in both directions using every tick and retains selection across refreshed ordering', async () => {
  const app = dialSetup();
  await app.tick();
  const requests = app.requests.length;
  const count = app.sent.length;
  await app.tick();
  assert.equal(app.sent.length, count);
  app.run("rotate('dial', 2)");
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:three');
  app.run("rotate('dial', 1)");
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:one');
  app.run("rotate('dial', -1)");
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:three');
  assert.equal(app.requests.length, requests + 1, 'rotation itself must not request data');
  app.current().state.playlistSelector.playlists.reverse();
  await app.tick();
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:three');
  assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.name, 'Third');
  app.current().state.uri = 'spotify:track:next';
  await app.tick();
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:one', 'new track adopts fresh sorting');
});

test('dial captures the pressed playlist, renders optimistic state, allows scrolling while pending, and confirms', async () => {
  const app = dialSetup();
  await app.tick();
  const pressing = app.run("press('dial')");
  const feedback = app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload;
  assert.equal(feedback.status.value, 'Removing…');
  app.run("rotate('dial', 1)");
  await pressing;
  assert.deepEqual(app.requests.find((r) => r.body).body, {
    action: 'playlist', uri: 'spotify:track:one', account: 'one', playlist: 'spotify:playlist:one', saved: true,
  });
  await app.run("press('dial')");
  assert.equal(app.requests.filter((r) => r.body).length, 1);
  app.current().results = [{ id: 'command-one', ok: true }];
  await app.tick();
  assert.ok(app.run('pending'), 'old membership cannot prematurely confirm');
  app.current().state.playlistSelector.playlists[0].saved = false;
  await app.tick();
  assert.equal(app.run('pending'), undefined);
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:two');
});

test('dial initializes its layout, handles rotation and press events and shows failure without automatic retries', async () => {
  const app = dialSetup();
  const event = (name, payload = {}) => app.event(name, { action: 'com.jovalle.spotifi.playlists', context: 'dial', payload });
  event('willAppear');
  await new Promise(setImmediate);
  assert.ok(app.sent.some((e) => e.event === 'setFeedbackLayout' && e.payload.layout === 'layouts/playlists.json'));
  event('dialRotate', { ticks: 1 });
  event('dialDown');
  event('dialUp');
  await app.clicks();
  assert.equal(app.requests.find((r) => r.body).body.playlist, 'spotify:playlist:two');
  app.current().results = [{ id: 'command-one', ok: false }];
  await app.tick();
  assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.status.value, 'Check Spotify');
  await app.tick();
  assert.equal(app.requests.filter((r) => r.body).length, 1);
});

test('track changes clear stale playlists immediately and unsupported or unknown membership cannot toggle', async () => {
  const app = dialSetup();
  await app.tick();
  app.current().state.uri = 'spotify:track:next';
  delete app.current().state.playlistSelector;
  await app.tick();
  assert.equal(app.run("contexts.get('dial').selected"), undefined);
  assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.name, 'Playlists');
  await app.run("press('dial')");
  assert.equal(app.requests.filter((r) => r.body).length, 0);
  for (const unknown of [true, false]) {
    const next = dialSetup();
    if (unknown) for (const playlist of next.current().state.playlistSelector.playlists) playlist.saved = null;
    else next.current().state.supported = false;
    await next.tick();
    if (unknown) assert.equal(next.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.status.value, 'Unavailable');
    await next.run("press('dial')");
    assert.equal(next.requests.filter((r) => r.body).length, 0);
  }
});

test('large playlist lists scroll from the existing cache without transport or rebuilding the list', async () => {
  const app = dialSetup();
  app.current().state.playlistSelector.playlists = Array.from({ length: 1001 }, (_, i) => ({
    uri: `spotify:playlist:${i}`, name: `Playlist ${i}`, saved: i < 4,
  }));
  await app.tick();
  const reads = app.requests.length;
  const cache = app.run("contexts.get('dial').items");
  const start = performance.now();
  app.run("for (let i = 0; i < 1000; i++) rotate('dial', 1)");
  const elapsed = performance.now() - start;
  assert.equal(app.requests.length, reads);
  assert.equal(app.run("contexts.get('dial').items"), cache);
  assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:1000');
  console.info(`1000 dial ticks across 1001 playlists: ${elapsed.toFixed(1)} ms; zero requests`);
});

test('double-click cycles all local sorts, preserves selection and settings, and never mutates membership', async () => {
  const app = dialSetup();
  await app.tick();
  const reads = app.requests.length;
  const modes = [
    ['A–Z', ['spotify:playlist:one', 'spotify:playlist:two', 'spotify:playlist:three']],
    ['Z–A', ['spotify:playlist:three', 'spotify:playlist:two', 'spotify:playlist:one']],
    ['Recent edits', ['spotify:playlist:two', 'spotify:playlist:one', 'spotify:playlist:three']],
    ['Oldest edits', ['spotify:playlist:three', 'spotify:playlist:one', 'spotify:playlist:two']],
    ['Track first', ['spotify:playlist:one', 'spotify:playlist:two', 'spotify:playlist:three']],
  ];
  for (const [label, order] of modes) {
    app.run("dialClick('dial'); dialClick('dial')");
    await app.clicks();
    assert.equal(app.run("contexts.get('dial').selected"), 'spotify:playlist:one');
    assert.deepEqual(Array.from(app.run("contexts.get('dial').order")), order);
    assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.sort, label);
  }
  assert.equal(app.requests.length, reads, 'sorting must not call either HTTP bridge');
  assert.equal(app.sent.filter((e) => e.event === 'setSettings').length, 5);
  app.event('willAppear', { action: 'com.jovalle.spotifi.playlists', context: 'dial', payload: { settings: { sort: 2, other: 'keep' } } });
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(app.run("contexts.get('dial').order")), modes[1][1]);
  app.run("dialClick('dial'); dialClick('dial')");
  assert.deepEqual(app.sent.filter((e) => e.event === 'setSettings').at(-1).payload, { sort: 3, other: 'keep' });
});

test('single click waits for the second-click window and rotation, track changes or hiding cancel it', async () => {
  const app = dialSetup();
  await app.tick();
  app.run("dialClick('dial')");
  assert.equal(app.requests.filter((r) => r.body).length, 0);
  assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.status.value, '2nd click: sort');
  await app.clicks();
  assert.equal(app.requests.filter((r) => r.body).length, 1);
  assert.equal(app.requests.find((r) => r.body).body.playlist, 'spotify:playlist:one');
  for (const cancel of ['rotate', 'track', 'hide']) {
    const next = dialSetup();
    await next.tick();
    next.run("dialClick('dial')");
    if (cancel === 'rotate') next.run("rotate('dial', 1)");
    if (cancel === 'track') { next.current().state.uri = 'spotify:track:next'; await next.tick(); }
    if (cancel === 'hide') next.event('willDisappear', { action: 'com.jovalle.spotifi.playlists', context: 'dial' });
    await next.clicks();
    assert.equal(next.requests.filter((r) => r.body).length, 0);
  }
});

test('sorts unknown recency last and sorts numeric names naturally', async () => {
  const app = dialSetup();
  app.current().state.playlistSelector.playlists = [
    { uri: 'spotify:playlist:a', name: 'Mix 10', recent: null, saved: false },
    { uri: 'spotify:playlist:b', name: 'Mix 2', recent: 0, saved: false },
    { uri: 'spotify:playlist:c', name: 'Mix 1', recent: 1, saved: false },
  ];
  await app.tick();
  app.run("dialClick('dial'); dialClick('dial')");
  assert.deepEqual(Array.from(app.run("contexts.get('dial').order")), ['spotify:playlist:c', 'spotify:playlist:b', 'spotify:playlist:a']);
  app.run("contexts.get('dial').sort = 4; sortPlaylists(contexts.get('dial'))");
  assert.deepEqual(Array.from(app.run("contexts.get('dial').order")), ['spotify:playlist:c', 'spotify:playlist:b', 'spotify:playlist:a']);
});

test('cover loads in the background, is cached, carries no companion credentials and cannot overwrite another selection', async () => {
  const app = dialSetup();
  app.current().state.playlistSelector.playlists[0].image = 'https://i.scdn.co/image/one';
  app.current().state.playlistSelector.playlists[1].image = 'https://i.scdn.co/image/two';
  const original = app.run('fetch');
  const images = [];
  const replies = new Map();
  app.replaceFetch(async (url, options) => {
    if (!url.startsWith('https://i.scdn.co/')) return original(url, options);
    images.push({ url, options });
    return new Promise((resolve) => { replies.set(url, resolve); });
  });
  const response = (bytes) => ({ ok: true, headers: new Map([['content-type', 'image/jpeg']]), body: (async function* () { yield Buffer.from(bytes); })() });
  await app.tick();
  assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.cover, 'imgs/add-action.png');
  app.run("rotate('dial', 1)");
  replies.get('https://i.scdn.co/image/two')(response('two'));
  await new Promise(setImmediate);
  const cover = app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.cover;
  assert.equal(cover, 'data:image/jpeg;base64,dHdv');
  replies.get('https://i.scdn.co/image/one')(response('one'));
  await new Promise(setImmediate);
  assert.equal(app.sent.filter((e) => e.event === 'setFeedback').at(-1).payload.cover, cover);
  app.run("rotate('dial', -1); rotate('dial', 1)");
  assert.equal(images.length, 2);
  assert.ok(images.every(({ options }) => !options.headers && options.redirect === 'error'));
});

test('missing, untrusted and failed covers retain fallback artwork and failures can recover', async () => {
  const app = dialSetup();
  await app.tick();
  const reads = app.requests.length;
  for (const url of [undefined, 'http://i.scdn.co/image/one', 'https://evil.example/cover', 'https://i.scdn.co.evil.example/cover'])
    assert.equal(app.run(`coverFor(${JSON.stringify(url)})`), 'imgs/add-action.png');
  assert.equal(app.requests.length, reads);
  let imageReads = 0;
  app.replaceFetch(async () => { imageReads++; return { ok: false, headers: new Map() }; });
  app.run("coverFor('https://i.scdn.co/image/failed')");
  await new Promise(setImmediate);
  app.run("coverFor('https://i.scdn.co/image/failed')");
  assert.equal(imageReads, 1);
  app.run("covers.get('https://i.scdn.co/image/failed').retryAt = 0");
  app.replaceFetch(async () => ({ ok: true, headers: new Map([['content-type', 'image/png']]), body: (async function* () { yield Buffer.from('recovered'); })() }));
  app.run("coverFor('https://i.scdn.co/image/failed')");
  await new Promise(setImmediate);
  assert.equal(app.run("coverFor('https://i.scdn.co/image/failed')"), 'data:image/png;base64,cmVjb3ZlcmVk');
});

test('a second dialDown cancels the single-click timer even if the second release arrives late', async () => {
  const app = dialSetup();
  await app.tick();
  const event = (event, payload = {}) => app.event(event, { action: 'com.jovalle.spotifi.playlists', context: 'dial', payload });
  event('dialDown'); event('dialUp');
  event('dialDown');
  await app.clicks();
  assert.equal(app.requests.filter((r) => r.body).length, 0);
  event('dialUp');
  await app.clicks();
  assert.equal(app.requests.filter((r) => r.body).length, 0);
  assert.equal(app.run("contexts.get('dial').sort"), 1);
  event('dialDown'); event('dialUp'); event('dialDown');
  event('dialRotate', { ticks: 1 }); event('dialUp');
  await app.clicks();
  assert.equal(app.requests.filter((r) => r.body).length, 0, 'rotation during a held click must cancel its release');
});

test('a delayed membership click rejects changed membership rather than reversing its original intent', async () => {
  const app = dialSetup();
  await app.tick();
  app.run("dialClick('dial')");
  app.current().state.playlistSelector.playlists[0].saved = false;
  await app.tick();
  await app.clicks();
  assert.equal(app.requests.filter((r) => r.body).length, 0);
  assert.ok(app.sent.some((e) => e.event === 'showAlert'));
});

test('oversized covers without Content-Length stop streaming and use fallback; the cache is bounded', async () => {
  const app = dialSetup();
  await app.tick();
  let chunks = 0;
  let cancelled = false;
  app.replaceFetch(async () => ({ ok: true, headers: new Map([['content-type', 'image/jpeg']]),
    body: (async function* () {
      try { chunks++; yield Buffer.alloc(256 * 1024 + 1); chunks++; yield Buffer.from('unused'); }
      finally { cancelled = true; }
    })(),
  }));
  app.run("coverFor('https://i.scdn.co/image/large')");
  await new Promise(setImmediate);
  assert.equal(chunks, 1);
  assert.equal(cancelled, true);
  assert.equal(app.run("coverFor('https://i.scdn.co/image/large')"), 'imgs/add-action.png');
  app.replaceFetch(async () => ({ ok: false, headers: new Map() }));
  app.run("for (let i = 0; i < 65; i++) coverFor('https://i.scdn.co/image/' + i)");
  await new Promise(setImmediate);
  assert.equal(app.run('covers.size'), 64);
});

test('seek renders immediately, preserves rapid turns and reversals, and coalesces in-flight targets', async () => {
  const app = setup();
  Object.assign(app.current().state, { position: 12000, duration: 60000, canSeek: true });
  app.event('willAppear', { action: 'com.jovalle.spotifi.seek', context: 'seek-one', payload: {} });
  await new Promise(setImmediate);
  let release;
  const posts = [];
  app.replaceFetch(async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    if (posts.length === 1) return new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => ({}) };
  });
  const first = app.run("seekDial('seek-one', 3)");
  await new Promise(setImmediate);
  assert.equal(posts[0].body.position, 15000);
  assert.ok(app.sent.some((e) => e.event === 'setFeedback' && e.payload.position === '0:15 / 1:00'));
  await app.run("seekDial('seek-one', 8)");
  await app.run("seekDial('seek-one', -4)");
  assert.equal(posts.length, 1);
  assert.ok(app.sent.some((e) => e.event === 'setFeedback' && e.payload.position === '0:19 / 1:00'));
  release({ ok: true, json: async () => ({}) });
  await first;
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.position, 19000);
  assert.ok(posts.every((p) => p.url.endsWith('/seek')));
  await app.run("seekDial('seek-one', -128)");
  assert.equal(posts.at(-1).body.position, 0);
  await app.run("seekDial('seek-one', 128)");
  assert.equal(posts.at(-1).body.position, 59999);
  assert.equal(app.sent.filter((e) => e.event === 'showAlert').length, 0);
});

test('seek rejects invalid turns and offline/restricted tracks, resets on track changes and never retries a failed POST', async () => {
  const app = setup();
  Object.assign(app.current().state, { position: 12000, duration: 60000, canSeek: true });
  app.event('willAppear', { action: 'com.jovalle.spotifi.seek', context: 'seek-one', payload: {} });
  await new Promise(setImmediate);
  for (const ticks of [0, 129, -129, 1.5, '1', NaN])
    await app.run(`seekDial('seek-one', ${JSON.stringify(ticks)})`);
  assert.equal(app.requests.filter((r) => r.method === 'POST').length, 0);
  app.current().state.canSeek = false;
  await app.tick();
  await app.run("seekDial('seek-one', 1)");
  assert.equal(app.requests.filter((r) => r.method === 'POST').length, 0);
  app.current().state.canSeek = true;
  await app.tick();
  await app.run("seekDial('seek-one', 4)");
  app.current().state.uri = 'spotify:track:next';
  app.current().state.position = 2000;
  await app.tick();
  await app.run("seekDial('seek-one', -1)");
  assert.equal(app.requests.filter((r) => r.body).at(-1).body.position, 1000);
  app.failPost();
  await app.run("seekDial('seek-one', 1)");
  const count = app.requests.filter((r) => r.body).length;
  await app.tick();
  assert.equal(app.requests.filter((r) => r.body).length, count);
  assert.ok(app.sent.some((e) => e.event === 'showAlert'));
});

test('a failed seek does not retry its target or discard newer queued dial turns', async () => {
  const app = setup();
  Object.assign(app.current().state, { position: 12000, duration: 60000, canSeek: true });
  app.event('willAppear', { action: 'com.jovalle.spotifi.seek', context: 'seek-one', payload: {} });
  await new Promise(setImmediate);
  let reject;
  const posts = [];
  app.replaceFetch(async (_, options) => {
    posts.push(JSON.parse(options.body));
    if (posts.length === 1) return new Promise((_, fail) => { reject = fail; });
    return { ok: true, json: async () => ({}) };
  });
  const first = app.run("seekDial('seek-one', 3)");
  await new Promise(setImmediate);
  await app.run("seekDial('seek-one', 8)");
  await app.run("seekDial('seek-one', -4)");
  reject(new Error('Lost reply'));
  await first;
  assert.deepEqual(posts.map((p) => p.position), [15000, 19000]);
  assert.equal(app.sent.filter((e) => e.event === 'showAlert').length, 1);
});
