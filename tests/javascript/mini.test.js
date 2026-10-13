const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(`${__dirname}/../../src/spicetify/mini.js`, 'utf8');

function harness() {
  const calls = [];
  const reports = [];
  let resync;
  const Spicetify = {
    Player: {
      data: { item: { uri: 'spotify:track:first', name: 'First', artists: [], metadata: {} } },
    },
    Platform: { LocalStorageAPI: { namespace: 'account' } },
  };
  const window = {
    JshMiniBridge: { token: 'a'.repeat(64), port: 47683 },
    JshMusic: {
      like: {
        state: () => undefined,
        toggle: async (uri) => {
          calls.push(uri);
          return { ok: true, message: 'Liked' };
        },
      },
      love: { state: () => false, toggle: async () => ({ ok: true }) },
      add: {
        removalState: () => ({
          enabled: true,
          action: 'remove',
          context: 'spotify:playlist:one',
          itemUid: 'playing',
          provider: 'context',
          id: '',
        }),
        changePlayingPlaylist: async (action, selection) => {
          calls.push({ action, selection });
          return { ok: true };
        },
        toggle: () => calls.push('add'),
      },
    },
    addEventListener() {},
  };
  vm.runInNewContext(source, {
    window,
    Spicetify,
    setTimeout(callback) {
      resync = callback;
    },
    clearTimeout() {},
    AbortSignal, AbortController,
    fetch: async (_, options) => {
      if (!options.body) return new Promise(() => {});
      reports.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ commands: [] }) };
    },
  });
  const command = (id, action = 'like') => ({
    id,
    action,
    uri: 'spotify:track:first',
    account: 'account',
    expires: Date.now() + 5000,
  });
  return {
    api: window.JshMusic.mini,
    window,
    Spicetify,
    calls,
    command,
    reports,
    resync: () => resync(),
  };
}

test('mini exposes track metadata and curation state without requesting removed audio or genre metadata', () => {
  const h = harness();
  const state = h.api.state();
  assert.equal(state.title, 'First');
  assert.equal(state.artist, 'Artist unavailable');
  assert.equal(state.album, 'Album unavailable');
  assert.equal(state.queueCount, null);
  h.window.JshMusic.play = { queueCount: () => 60 };
  assert.equal(h.api.state().queueCount, 60);
  h.window.JshMusic.play.queueCount = () => 0;
  assert.equal(h.api.state().queueCount, 0);
  assert.equal(state.position, null);
  assert.equal(state.duration, null);
  assert.equal(state.canSeek, false);
  for (const field of ['key', 'bpm', 'genres']) assert.equal(field in state, false);
  h.Spicetify.getAudioData = () => assert.fail('Removed audio metadata must not be requested');
  h.Spicetify.CosmosAsync = {
    get: () => assert.fail('Removed artist genres must not be requested'),
  };
  h.Spicetify.Player.data.item = {
    uri: 'spotify:track:second',
    artists: [{ uri: 'spotify:artist:one', name: 'Artist' }],
  };
  assert.equal(h.api.state().artist, 'Artist');
  assert.equal(state.liked, null);
  assert.equal(state.loved, false);
  assert.equal(state.added, null);
});

test('mini sends the native playlist checkmark independently of Like', () => {
  const h = harness();
  h.window.JshMusic.add.state = () => true;
  assert.equal(h.api.state().added, true);
  assert.equal(h.api.state().liked, null);
  h.window.JshMusic.add.state = () => false;
  assert.equal(h.api.state().added, false);
  h.Spicetify.Player.data.item.metadata.is_advertisement = true;
  assert.equal(h.api.state().added, null);
});

test('mini rejects expired, account changed, track changed, and retired playlist shortcut commands', async () => {
  const h = harness();
  await h.api.execute({ ...h.command('expired'), expires: Date.now() - 1 });
  await h.api.execute({ ...h.command('account'), account: 'other' });
  await h.api.execute({ ...h.command('track'), uri: 'spotify:track:other' });
  await h.api.execute({ ...h.command('slot', 'quick-add'), slot: 2 });
  await h.api.execute(h.command('unknown', 'eval'));
  assert.equal(h.calls.length, 0);
});

test('mini reserves command IDs before awaiting and routes each action once', async () => {
  const h = harness();
  let release;
  h.window.JshMusic.like.toggle = (uri) => {
    h.calls.push(uri);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = h.api.execute(h.command('same'));
  await h.api.execute(h.command('same'));
  assert.equal(h.calls.length, 1);
  release({ ok: true });
  await pending;
  await h.api.execute(h.command('same'));
  assert.equal(h.calls.length, 1);
  await h.api.execute(h.command('add', 'add'));
  assert.equal(h.calls[1], 'add');
});

test('mini forwards explicit Like/Love targets and a context check to queued writes', async () => {
  const h = harness();
  const received = [];
  for (const action of ['like', 'love']) {
    h.window.JshMusic[action].toggle = async (uri, value, validate) => {
      received.push({ action, uri, value });
      validate();
      h.Spicetify.Player.data.item.uri = 'spotify:track:other';
      assert.throws(validate, /Track changed/);
      return { ok: true };
    };
    h.Spicetify.Player.data.item.uri = 'spotify:track:first';
    await h.api.execute({ ...h.command(action, action), value: false });
  }
  assert.deepEqual(
    received.map(({ value }) => value),
    [false, false],
  );
  h.Spicetify.Player.data.item.uri = 'spotify:track:first';
  await h.api.execute({ ...h.command('invalid'), value: 'false' });
  assert.equal(received.length, 2);
});

test('mini retries unavailable or invalid bootstrap configuration and then connects', async () => {
  const h = harness();
  delete h.window.JshMiniBridge;
  let retry;
  const delays = [];
  let requests = 0;
  let synced = false;
  vm.runInNewContext(source, {
    window: h.window,
    Spicetify: h.Spicetify,
    navigator: { platform: 'MacIntel' },
    AbortSignal, AbortController,
    setTimeout(callback, delay) {
      delays.push(delay);
      retry = callback;
    },
    clearTimeout() {},
    fetch: async (url) => {
      if (url === '/extensions/mini-bridge.json') {
        requests += 1;
        if (requests === 1) return { ok: false };
        return {
          ok: true,
          json: async () => (requests === 2 ? {} : { token: 'a'.repeat(64), port: 47683 }),
        };
      }
      synced = true;
      return { ok: true, json: async () => ({ commands: [] }) };
    },
  });
  await new Promise(setImmediate);
  assert.equal(typeof retry, 'function');
  retry();
  await new Promise(setImmediate);
  assert.equal(h.window.JshMiniBridge, undefined);
  retry();
  await new Promise(setImmediate);
  assert.equal(requests, 3);
  assert.equal(synced, true);
  assert.equal(h.window.JshMiniBridge.port, 47683);
  assert.deepEqual(delays.slice(0, 2), [5000, 10000]);
});

test('mini bounds and backs off bootstrap retries when the companion is absent', async () => {
  const h = harness();
  delete h.window.JshMiniBridge;
  const pending = [];
  const delays = [];
  let requests = 0;
  vm.runInNewContext(source, {
    window: h.window,
    Spicetify: h.Spicetify,
    navigator: { platform: 'MacIntel' },
    setTimeout(callback, delay) {
      pending.push(callback);
      delays.push(delay);
    },
    fetch: async () => {
      requests += 1;
      return { ok: false };
    },
  });
  await new Promise(setImmediate);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(pending.length, 1);
    pending.shift()();
    await new Promise(setImmediate);
  }
  assert.equal(requests, 6);
  assert.equal(pending.length, 0);
  assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000]);
});

test('mini captures playlist occurrence and Undo identity; rejects stale or unavailable removals', async () => {
  const h = harness();
  const removal = h.api.state().removal;
  await h.api.execute({ ...h.command('remove', 'remove'), removal });
  assert.equal(h.calls[0].action, 'remove');
  await h.api.execute({ ...h.command('remove', 'remove'), removal });
  assert.equal(h.calls.length, 1);
  for (const patch of [
    { context: 'spotify:playlist:other' },
    { itemUid: 'duplicate' },
    { provider: 'queue' },
    { id: 'old' },
  ]) {
    await h.api.execute({
      ...h.command(JSON.stringify(patch), 'remove'),
      removal: { ...removal, ...patch },
    });
  }
  h.window.JshMusic.add.removalState = () => ({ ...removal, action: 'undo', id: 'record' });
  await h.api.execute({ ...h.command('stale', 'remove'), removal });
  await h.api.execute({ ...h.command('undo', 'undo'), removal: h.api.state().removal });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].action, 'undo');
  h.window.JshMusic.add.removalState = () => ({ ...removal, enabled: false });
  await h.api.execute({ ...h.command('disabled', 'remove'), removal });
  assert.equal(h.calls.length, 2);
});

test('Add toggles the picker silently and retired playlist shortcuts cannot mutate', async () => {
  const h = harness();
  await h.api.execute(h.command('add-silent', 'add'));
  await h.api.execute({ ...h.command('retired-slot', 'quick-add'), slot: 0 });
  await h.resync();
  const results = h.reports.at(-1).results;
  assert.equal(results.find((r) => r.id === 'add-silent').message, '');
  assert.equal(results.find((r) => r.id === 'retired-slot').ok, false);
  assert.deepEqual(h.calls, ['add']);
});

test('Previous/Next skip tracks even after the playing track changed', async () => {
  const h = harness();
  h.Spicetify.Player.next = () => h.calls.push('next');
  h.Spicetify.Player.back = () => h.calls.push('back');
  await h.api.execute(h.command('next-1', 'next'));
  h.Spicetify.Player.data.item.uri = 'spotify:track:second';
  await h.api.execute(h.command('next-2', 'next'));
  await h.api.execute(h.command('previous', 'previous'));
  await h.api.execute({ ...h.command('expired', 'next'), expires: Date.now() - 1 });
  await h.api.execute({ ...h.command('account', 'previous'), account: 'other' });
  assert.deepEqual(h.calls, ['next', 'next', 'back']);
});

test('Seek jumps 10 seconds within the playing track only', async () => {
  const h = harness();
  h.Spicetify.Player.skipBack = (ms) => h.calls.push(-ms);
  h.Spicetify.Player.skipForward = (ms) => h.calls.push(ms);
  await h.api.execute(h.command('back', 'seek-back'));
  await h.api.execute(h.command('forward', 'seek-forward'));
  await h.api.execute({ ...h.command('stale', 'seek-forward'), uri: 'spotify:track:other' });
  assert.deepEqual(h.calls, [-10000, 10000]);
});

test('Shortcuts overlay toggles after a track change and reports a missing overlay', async () => {
  const h = harness();
  h.window.JshMusic.keys = { toggle: () => h.calls.push('keys') };
  await h.api.execute({ ...h.command('keys', 'keys'), uri: 'spotify:track:other' });
  delete h.window.JshMusic.keys;
  await h.api.execute(h.command('keys-missing', 'keys'));
  await h.resync();
  const results = h.reports.at(-1).results;
  assert.deepEqual(h.calls, ['keys']);
  assert.equal(
    results.find((r) => r.id === 'keys-missing').message,
    'Shortcuts overlay unavailable',
  );
});

test('mini opens Queue across track changes and rejects stale or unavailable commands', async () => {
  const h = harness();
  h.window.JshMusic.play = { openQueue: () => h.calls.push('queue') };
  h.Spicetify.Player.data.item.uri = 'spotify:track:second';
  await h.api.execute(h.command('queue', 'queue'));
  await h.api.execute(h.command('queue', 'queue'));
  await h.api.execute({ ...h.command('queue-expired', 'queue'), expires: Date.now() - 1 });
  await h.api.execute({ ...h.command('queue-account', 'queue'), account: 'other' });
  delete h.window.JshMusic.play;
  await h.api.execute(h.command('queue-missing', 'queue'));
  assert.deepEqual(h.calls, ['queue']);
  await h.resync();
  const results = h.reports.at(-1).results;
  assert.equal(results.find((r) => r.id === 'queue').ok, true);
  for (const id of ['queue-expired', 'queue-account', 'queue-missing'])
    assert.equal(results.find((r) => r.id === id).ok, false);
});

test('mini toggles Queue once and rejects expired or changed-account commands', async () => {
  const h = harness();
  h.window.JshMusic.play = { queueCount: () => 0, openQueue: (toggle) => h.calls.push(toggle) };
  h.Spicetify.Player.data.item.uri = 'spotify:track:second';
  await h.api.execute(h.command('queue-toggle', 'queue-toggle'));
  await h.api.execute(h.command('queue-toggle', 'queue-toggle'));
  await h.api.execute({ ...h.command('queue-expired', 'queue-toggle'), expires: Date.now() - 1 });
  await h.api.execute({ ...h.command('queue-account', 'queue-toggle'), account: 'other' });
  assert.deepEqual(h.calls, [true]);
  await h.resync();
  const results = h.reports.at(-1).results;
  assert.equal(results.find((r) => r.id === 'queue-toggle').ok, true);
  for (const id of ['queue-expired', 'queue-account'])
    assert.equal(results.find((r) => r.id === id).ok, false);
});

test('mini reports and sets Shuffle, and executes Randomize once across track changes', async () => {
  const h = harness();
  h.Spicetify.Player.getShuffle = () => true;
  h.Spicetify.Player.setShuffle = (value) => h.calls.push(value);
  h.window.JshMusic.play = { queueCount: () => 0, randomize: async (validate) => { validate(); h.calls.push('randomize'); } };
  assert.equal(h.api.state().shuffle, true);
  h.Spicetify.Player.data.item.uri = 'spotify:track:other';
  await h.api.execute({ ...h.command('shuffle', 'shuffle'), value: false });
  await h.api.execute(h.command('random', 'randomize'));
  await h.api.execute(h.command('random', 'randomize'));
  await h.api.execute({ ...h.command('wrong-account', 'randomize'), account: 'other' });
  await h.api.execute({ ...h.command('expired', 'randomize'), expires: Date.now() - 1 });
  await h.api.execute(h.command('missing-target', 'shuffle'));
  assert.deepEqual(h.calls, [false, 'randomize']);
});

test('mini forwards playlist state and guarded commands through the Adder API once', async () => {
  const h = harness();
  h.window.JshMusic.add.playlistSelection = () => ({ ready: true, playlists: [{ uri: 'spotify:playlist:one', saved: false }] });
  h.window.JshMusic.add.toggleSelectedPlaylist = async (command, validate) => {
    validate();
    h.calls.push(command.playlist);
    return { ok: true };
  };
  assert.equal(h.api.state().playlistSelector.ready, true);
  const command = { ...h.command('playlist', 'playlist'), playlist: 'spotify:playlist:one', saved: false };
  await Promise.all([h.api.execute(command), h.api.execute(command)]);
  assert.deepEqual(h.calls, ['spotify:playlist:one']);
  await h.api.execute({ ...command, id: 'stale', uri: 'spotify:track:other' });
  assert.deepEqual(h.calls, ['spotify:playlist:one']);
});

test('seek dial applies absolute targets once, clamps boundaries and rejects stale or unavailable tracks', async () => {
  const h = harness();
  h.Spicetify.Player.getDuration = () => 60000;
  h.Spicetify.Player.getProgress = () => 12000;
  h.Spicetify.Player.seek = (position) => h.calls.push(position);
  assert.equal(h.api.state().canSeek, true);
  for (const [id, position] of [['forward', 18000], ['back', 11000], ['start', 0], ['end', 90000]])
    await h.api.execute({ ...h.command(id, 'seek'), position });
  await h.api.execute({ ...h.command('forward', 'seek'), position: 18000 });
  assert.deepEqual(h.calls, [18000, 11000, 0, 59999]);
  for (const position of [-1, NaN, Infinity, '1000', true])
    await h.api.execute({ ...h.command(String(position), 'seek'), position });
  await h.api.execute({ ...h.command('stale', 'seek'), uri: 'spotify:track:other', position: 3000 });
  await h.api.execute({ ...h.command('expired', 'seek'), expires: Date.now() - 1, position: 3000 });
  h.Spicetify.Player.data.restrictions = { canSeek: false };
  await h.api.execute({ ...h.command('restricted', 'seek'), position: 3000 });
  h.Spicetify.Player.data.restrictions = {};
  h.Spicetify.Player.data.item.metadata.is_advertisement = true;
  await h.api.execute({ ...h.command('ad', 'seek'), position: 3000 });
  assert.deepEqual(h.calls, [18000, 11000, 0, 59999]);
});

test('seek receives commands directly and closes the long poll when Spotify unloads', async () => {
  const h = harness();
  let release, unload, signal;
  const delays = [];
  h.Spicetify.Player.getDuration = () => 60000;
  h.Spicetify.Player.seek = (position) => h.calls.push(position);
  h.window.addEventListener = (_, callback) => { unload = callback; };
  vm.runInNewContext(source, {
    window: h.window, Spicetify: h.Spicetify, AbortSignal, AbortController,
    setTimeout: (_, delay) => delays.push(delay), clearTimeout() {},
    fetch: async (url, options) => {
      if (url.endsWith('/seek')) {
        signal = options.signal;
        return new Promise((resolve) => { release = resolve; });
      }
      return { ok: true, json: async () => ({ commands: [] }) };
    },
  });
  release({ ok: true, json: async () => ({ commands: [{ ...h.command('direct', 'seek'), position: 18000 }] }) });
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, [18000]);
  assert.ok(delays.includes(0), 'seek reconnects immediately, independent of the 250ms status loop');
  unload();
  assert.equal(signal.aborted, true);
});
