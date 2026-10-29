import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function harness({ adder = false, rootItems, createError, uploadError, pinError } = {}) {
  const liked = new Set();
  const loved = new Set();
  const writes = [];
  const notifications = [];
  const controls = [];
  const nativeButtons = [];
  const scans = [];
  const animations = [];
  const setupCalls = [];
  const domWrites = [];
  const observers = [];
  let scansRun = 0;
  const pinned = new Set();
  const ownedPlaylist = {
    type: 'playlist', name: 'Loved Songs', uri: 'spotify:playlist:loved', isOwnedBySelf: true,
  };
  let items = rootItems || [ownedPlaylist];
  let reduceMotion = false;
  function element() {
    const attributes = new Map();
    const styles = new Map();
    const node = {
      disabled: false,
      offsetWidth: 16,
      offsetHeight: 16,
      dataset: new Proxy({}, { set(target, key, value) {
        domWrites.push({ key, value }); target[key] = value; return true;
      } }),
      style: {
        getPropertyValue: (key) => styles.get(key)?.value || '',
        getPropertyPriority: (key) => styles.get(key)?.priority || '',
        setProperty(key, value, priority = '') { domWrites.push({ key, value }); styles.set(key, { value, priority }); },
      },
      isConnected: true,
      getAttribute: (key) => attributes.get(key) ?? null,
      setAttribute: (key, value) => { domWrites.push({ key, value }); attributes.set(key, value); },
      removeAttribute: (key) => attributes.delete(key),
      closest: () => null,
      classList: { contains: (name) => node.className === name },
      matches: (selector) => selector.includes(node.className || 'button[aria-checked]'),
      querySelector: () => ({
        getAnimations: () => [],
        animate: (frames, options) => animations.push({ node, frames, options }),
      }),
      before(custom) {
        custom.previousElementSibling = node.previousElementSibling;
        custom.nextElementSibling = node;
        if (node.previousElementSibling) node.previousElementSibling.nextElementSibling = custom;
        node.previousElementSibling = custom;
        controls.push(custom);
      },
    };
    return node;
  }
  const library = {
    async pin(uri, location) {
      setupCalls.push({ pin: uri, location });
      if (!pinError) pinned.add(uri);
    },
    async getIsPinned(...uris) {
      return uris.map((uri) => pinned.has(uri));
    },
    async contains(uri) {
      return [liked.has(uri)];
    },
    async add({ uris }) {
      writes.push('like');
      uris.forEach((uri) => liked.add(uri));
    },
    async remove({ uris }) {
      writes.push('unlike');
      uris.forEach((uri) => liked.delete(uri));
    },
  };
  const Platform = {
    LibraryAPI: library,
    RootlistAPI: {
      async getContents() {
        return { items };
      },
      async createPlaylist(name, location) {
        setupCalls.push({ create: name, location });
        if (createError) throw new Error('Creation failed');
        items = [...items, ownedPlaylist];
        return ownedPlaylist.uri;
      },
    },
    PlaylistAPI: {
      async uploadImage(cover) {
        setupCalls.push({ upload: cover });
        if (uploadError) throw new Error('Upload failed');
        return 'upload-token';
      },
      async updateDetails(uri, details) {
        setupCalls.push({ update: uri, details });
      },
      async getContents() {
        return { items: [...loved].map((uri) => ({ uri, uid: uri })) };
      },
      async add(_playlist, uris) {
        writes.push('love');
        uris.forEach((uri) => loved.add(uri));
      },
      async remove(_playlist, items) {
        writes.push('unlove');
        items.forEach(({ uri }) => loved.delete(uri));
      },
    },
  };
  const Spicetify = {
    Platform,
    Player: { addEventListener: (_type, callback) => scans.push(callback) },
    Keyboard: { registerShortcut() {} },
    showNotification: (message, error) => notifications.push({ message, error }),
  };
  const window = {
    Spicetify,
    JshLovedCover: 'data:image/jpeg;base64,cover',
    addEventListener() {},
    matchMedia: () => ({ matches: reduceMotion }),
  };
  const context = {
    window,
    Spicetify,
    console: { error() {} },
    fetch: async (url) => {
      assert.equal(url, window.JshLovedCover);
      return { ok: true, blob: async () => 'jpeg-blob' };
    },
    document: {
      addEventListener() {},
      createElement: element,
      head: { append() {} },
      body: {},
      querySelectorAll: (selector) => {
        scansRun += 1;
        return selector === 'button[aria-checked]'
          ? nativeButtons
          : controls.filter((node) => selector === `.${node.className}`);
      },
    },
    navigator: { platform: 'MacIntel' },
    ResizeObserver: class {
      observe() {}
    },
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
    },
    getComputedStyle: () => ({ width: '16px', height: '16px' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout: () => 0,
    clearTimeout() {},
  };
  if (adder) {
    Spicetify.ContextMenu = {};
    Spicetify.Player.data = { item: { uri: 'spotify:track:first' } };
    Platform.LocalStorageAPI = { namespace: 'test' };
    const playlists = (uri) => [
      { uri: 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ', name: 'Liked Songs', hasCuratedItems: liked.has(uri) },
      { uri: 'spotify:playlist:loved', name: 'Loved Songs', hasCuratedItems: loved.has(uri) },
    ];
    Platform.LibraryAPI.getContents = async () => ({ items: playlists('spotify:track:first'), totalLength: 2 });
    Platform.CurationAPI = {
      getCurationContexts: async ({ curatedItemUri }) => ({ items: playlists(curatedItemUri), totalLength: 2 }),
      curateItems: async () => assert.fail('Liked/Loved Songs must use the shared curation actions'),
    };
  }
  for (const name of ['like', 'love', ...(adder ? ['add'] : [])]) {
    vm.runInNewContext(
      readFileSync(new URL(`../../modules/${name === 'add' ? 'library' : 'library-controls'}/${name}.js`, import.meta.url), 'utf8'),
      context,
    );
  }
  return {
    api: window.JshMusic,
    Spicetify,
    Platform,
    library,
    liked,
    loved,
    writes,
    notifications,
    animations,
    setupCalls,
    domWrites,
    mutate: (records) => observers.forEach((callback) => callback(records)),
    scansRun: () => scansRun,
    scan: () => scans.forEach((callback) => callback()),
    reduceMotion: (value = true) => {
      reduceMotion = value;
    },
    mount(uri) {
      const native = element();
      native.__reactFiber$test = { memoizedProps: { uri, curateDefault() {} } };
      nativeButtons.push(native);
      scans.forEach((callback) => callback());
      return {
        native,
        star: controls.find((node) => node.className === 'jsh-like-button'),
        heart: controls.find((node) => node.className === 'jsh-love-button'),
      };
    },
  };
}

test('configuration creates Loved Songs once during concurrent reads and applies its cover without track writes', async () => {
  const h = harness({ rootItems: [] });
  const uris = await Promise.all([h.api.love.playlistUri(), h.api.love.playlistUri()]);
  await new Promise(setImmediate);
  assert.deepEqual(uris, ['spotify:playlist:loved', 'spotify:playlist:loved']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.setupCalls)), [
    { create: 'Loved Songs', location: { after: 'end' } },
    { pin: 'spotify:collection:tracks', location: { before: 'start' } },
    { pin: 'spotify:playlist:loved', location: { after: { uri: 'spotify:collection:tracks' } } },
    { upload: 'jpeg-blob' },
    { update: 'spotify:playlist:loved', details: { imageUploadToken: 'upload-token' } },
  ]);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.notifications, []);
});

test('configuration reuses an owned playlist inside a folder and skips another owner’s namesake', async () => {
  const h = harness({ rootItems: [
    { type: 'playlist', name: 'Loved Songs', uri: 'spotify:playlist:other', isOwnedBySelf: false },
    { type: 'folder', items: [
      { type: 'playlist', name: 'Loved Songs', uri: 'spotify:playlist:nested', ownedBySelf: true },
    ] },
  ] });
  await new Promise(setImmediate);
  assert.equal(h.setupCalls.some((call) => call.create), false);
  assert.equal(h.setupCalls.at(-1).update, 'spotify:playlist:nested');
  assert.deepEqual(h.writes, []);
});

test('configuration reports creation, pinning and cover failures without changing tracks', async () => {
  for (const options of [{ rootItems: [], createError: true }, { pinError: true }, { uploadError: true }]) {
    const h = harness(options);
    await new Promise(setImmediate);
    assert.equal(h.setupCalls.some((call) => call.update), false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.notifications.at(-1).error, true);
  }
});

test('the bundled cover is a JPEG and fits Spotify’s upload limit', () => {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../../modules/library-controls/loved-cover.js', import.meta.url), 'utf8'), { window });
  assert.ok(window.JshLovedCover.startsWith('data:image/jpeg;base64,'));
  const payload = window.JshLovedCover.split(',')[1];
  assert.ok(payload.length < 256 * 1024);
  assert.equal(Buffer.from(payload, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
});

test('curation buttons switch immediately, keep the new fill through confirmation, and show no success toast or delayed pop', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  await Promise.resolve();
  const { star, heart, native } = h.mount(uri);
  await new Promise(setImmediate);
  assert.equal(h.api.love.state(uri), false);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  const pending = h.api.love.toggle(uri);
  assert.equal(
    heart.getAttribute('aria-pressed'),
    'true',
    'heart fills before the first lookup resolves',
  );
  assert.equal(star.getAttribute('aria-pressed'), 'true', 'Love previews Like immediately too');
  assert.equal(h.api.love.state(uri), false, 'bridge state remains confirmed');
  assert.equal(heart.disabled, false);
  assert.equal(heart.getAttribute('aria-busy'), 'true');
  assert.equal(star.getAttribute('aria-disabled'), 'false');
  assert.equal((await pending).ok, true);
  assert.equal(heart.getAttribute('aria-busy'), 'false');
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  const unlove = h.api.love.toggle(uri);
  assert.equal(heart.getAttribute('aria-pressed'), 'false', 'heart empties immediately');
  assert.equal(star.getAttribute('aria-pressed'), 'true', 'removing Love retains Like');
  await unlove;
  h.scan();
  assert.deepEqual(h.animations, [], 'confirmation does not replay a celebration animation');
  assert.deepEqual(h.notifications, []);
  h.api.feedback(star);
  assert.equal(h.animations.length, 1, 'Add/shortcut press feedback remains brief');
  assert.equal(h.animations[0].options.duration, 100);
  h.reduceMotion();
  h.api.feedback(star);
  assert.equal(h.animations.length, 1, 'Reduce Motion suppresses press motion');
  const unlike = h.api.like.toggle(uri);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  await unlike;
  native.__reactFiber$test.memoizedProps.uri = 'spotify:track:second';
  h.liked.add('spotify:track:second');
  h.scan();
  await Promise.resolve();
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'false');
});

test('unchanged curation buttons perform no DOM writes, and unrelated mutations do not rescan them', async () => {
  const h = harness();
  const { native, star, heart } = h.mount('spotify:track:first');
  await new Promise(setImmediate);
  h.domWrites.length = 0;
  for (let i = 0; i < 10; i++) h.scan();
  assert.deepEqual(h.domWrites, [], 'repeat renders leave attributes and sizing untouched');
  const scans = h.scansRun();
  h.mutate([{ target: {}, addedNodes: [{ nodeType: 3 }], removedNodes: [] }]);
  assert.equal(h.scansRun(), scans);
  assert.deepEqual(h.domWrites, []);
  native.offsetWidth = 24;
  h.scan();
  assert.equal(star.style.getPropertyValue('--jsh-button-width'), '24px');
  assert.equal(heart.style.getPropertyValue('--jsh-button-width'), '24px');
  assert.ok(h.domWrites.length, 'real layout changes still resize the existing buttons');
});

test('unknown refreshes retain fill; pending toggles are immediate and failed writes restore the confirmed state', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  h.liked.add(uri);
  await Promise.resolve();
  const { star } = h.mount(uri);
  await Promise.resolve();
  let release;
  h.library.contains = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  h.api.like.refresh(uri);
  h.scan();
  assert.equal(star.getAttribute('aria-pressed'), 'true', 'unknown read preserves the filled icon');
  release([true]);
  await Promise.resolve();
  const pending = h.api.like.toggle(uri);
  assert.equal(star.disabled, false);
  assert.equal(star.getAttribute('aria-busy'), 'true');
  assert.equal(star.getAttribute('aria-pressed'), 'false', 'pending Unlike empties instantly');
  h.scan();
  assert.equal(star.getAttribute('aria-pressed'), 'false', 'rescan does not undo the preview');
  assert.deepEqual(h.writes, []);
  h.library.remove = async () => {
    throw new Error('offline');
  };
  release([true]);
  assert.equal((await pending).ok, false);
  assert.equal(star.getAttribute('aria-pressed'), 'true', 'failure restores the confirmed fill');
  assert.equal(star.getAttribute('aria-busy'), 'false');
  assert.equal(h.notifications.at(-1).error, true);
  h.library.contains = async () => [true];
  h.library.remove = async () => {
    h.writes.push('unlike');
    h.liked.delete(uri);
  };
  assert.equal((await h.api.like.toggle(uri)).ok, true);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.writes, ['unlike']);
});

test('Love also likes; removing Love leaves the track liked', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  assert.equal((await h.api.love.toggle(uri)).ok, true);
  assert.equal(h.liked.has(uri), true);
  assert.equal(h.loved.has(uri), true);
  assert.equal(h.api.love.state(uri), true);
  assert.equal((await h.api.love.toggle(uri)).ok, true);
  assert.equal(h.liked.has(uri), true);
  assert.equal(h.loved.has(uri), false);
  assert.deepEqual(h.writes, ['like', 'love', 'unlove']);
});

test('rapid clicks all update the preview and serialize explicit targets instead of being dropped', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  const { star, heart } = h.mount(uri);
  await new Promise(setImmediate);
  const contains = h.library.contains;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.library.contains = async (track) => {
    await gate;
    return contains(track);
  };
  const first = h.api.love.toggle(uri);
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  const second = h.api.like.toggle(uri);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.equal(heart.getAttribute('aria-pressed'), 'false', 'Unlike immediately clears Love too');
  const third = h.api.love.toggle(uri);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  assert.equal(star.getAttribute('aria-disabled'), 'false');
  await new Promise(setImmediate);
  assert.deepEqual(h.writes, [], 'later writes cannot race the pending one');
  release();
  const results = await Promise.all([first, second, third]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(h.writes, ['like', 'love', 'unlove', 'unlike', 'like', 'love']);
  assert.equal(h.api.like.state(uri), true);
  assert.equal(h.api.love.state(uri), true);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  assert.equal(star.getAttribute('aria-busy'), 'false');
  h.library.contains = async () => {
    throw new Error('offline');
  };
  assert.equal((await h.api.like.toggle(uri)).ok, false);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  h.library.contains = contains;
  assert.equal((await h.api.like.toggle(uri)).ok, true);
  assert.equal(h.api.like.state(uri), false);
  assert.equal(h.api.love.state(uri), false);
});

test('unliking removes Love before Like, restores confirmed states on failure, and explicit retries are idempotent', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  h.liked.add(uri);
  h.loved.add(uri);
  const { star, heart } = h.mount(uri);
  await new Promise(setImmediate);
  const remove = h.Platform.PlaylistAPI.remove;
  h.Platform.PlaylistAPI.remove = async () => {
    throw new Error('playlist offline');
  };
  const failed = h.api.like.toggle(uri, false);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.equal(heart.getAttribute('aria-pressed'), 'false');
  assert.equal((await failed).ok, false);
  assert.deepEqual(h.writes, [], 'Like stays checked when Love removal fails');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  h.Platform.PlaylistAPI.remove = remove;
  h.library.remove = async () => {
    throw new Error('library offline');
  };
  assert.equal((await h.api.like.toggle(uri, false)).ok, false);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(
    heart.getAttribute('aria-pressed'),
    'false',
    'successful Love removal survives a Like failure',
  );
  h.library.remove = async ({ uris }) => {
    h.writes.push('unlike');
    uris.forEach((track) => h.liked.delete(track));
  };
  assert.equal((await h.api.like.toggle(uri, false)).ok, true);
  assert.equal((await h.api.like.toggle(uri, false)).ok, true);
  assert.deepEqual(h.writes, ['unlove', 'unlike']);
  assert.equal(h.liked.has(uri), false);
  assert.equal(h.loved.has(uri), false);
});

test('a queued native intent rechecks the playing context before mutation', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  h.mount(uri);
  await new Promise(setImmediate);
  let current = uri;
  let release;
  h.library.contains = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = h.api.like.toggle(uri, true, () => {
    if (current !== uri) throw new Error('Track changed');
  });
  current = 'spotify:track:other';
  release([false]);
  assert.equal((await pending).ok, false);
  assert.deepEqual(h.writes, []);
});

test('unsupported curation targets produce no library or playlist writes', async () => {
  const h = harness();
  assert.equal((await h.api.like.toggle('spotify:episode:one')).ok, false);
  assert.equal((await h.api.love.toggle('spotify:local:one')).ok, false);
  assert.deepEqual(h.writes, []);
});

test('Love verifies Like before the playlist write and reconciles partial failure on retry', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  await Promise.resolve();
  const { star, heart } = h.mount(uri);
  await Promise.resolve();
  const contains = h.library.contains;
  h.library.contains = async () => {
    throw new Error('offline');
  };
  assert.equal((await h.api.love.toggle(uri)).ok, false);
  assert.deepEqual(h.writes, []);
  h.library.contains = contains;
  const add = h.Platform.PlaylistAPI.add;
  h.Platform.PlaylistAPI.add = async () => {
    throw new Error('playlist offline');
  };
  const partial = h.api.love.toggle(uri);
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  assert.match((await partial).message, /Added to Liked Songs/);
  assert.equal(heart.getAttribute('aria-pressed'), 'false');
  assert.equal(
    star.getAttribute('aria-pressed'),
    'true',
    'partial failure retains the successful Like',
  );
  assert.equal(h.liked.has(uri), true);
  assert.equal(h.loved.has(uri), false);
  h.Platform.PlaylistAPI.add = add;
  assert.equal((await h.api.love.toggle(uri)).ok, true);
  assert.equal(h.liked.has(uri), true);
  assert.equal(h.loved.has(uri), true);
  assert.deepEqual(h.writes, ['like', 'love']);
});

test('Like and Love reject account changes detected during their lookups', async () => {
  for (const action of ['like', 'love']) {
    const h = harness();
    h.Platform.LocalStorageAPI = { namespace: 'first-account' };
    h.library.contains = async () => {
      h.Platform.LocalStorageAPI.namespace = 'second-account';
      return [false];
    };
    assert.equal((await h.api[action].toggle('spotify:track:first')).ok, false);
    assert.deepEqual(h.writes, []);
  }
});

test('an old Like read cannot overwrite the refreshed state after Love', async () => {
  const h = harness();
  const uri = 'spotify:track:first';
  let release;
  const stale = new Promise((resolve) => {
    release = resolve;
  });
  const contains = h.library.contains;
  let calls = 0;
  h.library.contains = (track) => {
    calls += 1;
    return calls === 1 ? stale : contains(track);
  };
  assert.equal(h.api.like.state(uri), undefined);
  assert.equal((await h.api.love.toggle(uri)).ok, true);
  assert.equal(h.api.like.state(uri), true);
  release([false]);
  await Promise.resolve();
  assert.equal(h.api.like.state(uri), true);
});

test('playlist dial Like updates the star; dial Unlike clears both star and Love through the shared actions', async () => {
  const h = harness({ adder: true });
  const uri = 'spotify:track:first';
  const { star, heart } = h.mount(uri);
  await new Promise(setImmediate);
  h.api.add.playlistSelection();
  await new Promise(setImmediate);
  const playlist = 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ';
  await h.api.add.toggleSelectedPlaylist({ playlist, saved: false }, () => {});
  assert.equal(h.api.like.state(uri), true);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  await h.api.love.toggle(uri, true);
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  await h.api.add.toggleSelectedPlaylist({ playlist, saved: true }, () => {});
  assert.equal(h.api.like.state(uri), false);
  assert.equal(h.api.love.state(uri), false);
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.equal(heart.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.writes, ['like', 'love', 'unlove', 'unlike']);
});

test('playlist dial Love updates the heart and likes; removing Love keeps the star filled', async () => {
  const h = harness({ adder: true });
  const uri = 'spotify:track:first';
  const { star, heart } = h.mount(uri);
  await new Promise(setImmediate);
  h.api.add.playlistSelection();
  await new Promise(setImmediate);
  const playlist = 'spotify:playlist:loved';
  await h.api.add.toggleSelectedPlaylist({ playlist, saved: false }, () => {});
  assert.equal(h.api.like.state(uri), true);
  assert.equal(h.api.love.state(uri), true);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'true');
  await h.api.add.toggleSelectedPlaylist({ playlist, saved: true }, () => {});
  assert.equal(h.api.like.state(uri), true);
  assert.equal(h.api.love.state(uri), false);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.writes, ['like', 'love', 'unlove']);
});

test('dial Unlike preserves confirmed state on partial failure and delegated writes recheck track changes', async () => {
  const h = harness({ adder: true });
  const uri = 'spotify:track:first';
  const { star, heart } = h.mount(uri);
  await h.api.love.toggle(uri, true);
  h.api.add.playlistSelection();
  await new Promise(setImmediate);
  h.library.remove = async () => { throw new Error('Library offline'); };
  await assert.rejects(h.api.add.toggleSelectedPlaylist({ playlist: 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ', saved: true }, () => {}), /could not update Liked Songs/);
  assert.equal(h.api.like.state(uri), true);
  assert.equal(h.api.love.state(uri), false);
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(heart.getAttribute('aria-pressed'), 'false');
  const stale = harness({ adder: true });
  stale.api.add.playlistSelection();
  await new Promise(setImmediate);
  stale.library.contains = async () => { stale.Spicetify.Player.data.item.uri = 'spotify:track:next'; return [false]; };
  await assert.rejects(stale.api.add.toggleSelectedPlaylist({ playlist: 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ', saved: false }, () => {}), /Could not update/);
  assert.deepEqual(stale.writes, []);
});

test('dial curation routing uses playlist identity, including translated Liked Songs and unrelated namesakes', async () => {
  const h = harness({ adder: true });
  await new Promise(setImmediate);
  const curation = h.Platform.CurationAPI;
  const read = curation.getCurationContexts;
  let ordinarySaved = false;
  curation.getCurationContexts = async (options) => {
    const response = await read(options);
    response.items[0].name = 'Titres likés';
    response.items.push({ uri: 'spotify:playlist:otherLiked', name: 'Liked Songs', hasCuratedItems: ordinarySaved },
      { uri: 'spotify:playlist:otherLoved', name: 'Loved Songs', hasCuratedItems: ordinarySaved });
    response.totalLength = response.items.length;
    return response;
  };
  curation.curateItems = async (_uri, add, remove) => {
    h.writes.push('ordinary');
    ordinarySaved = add.length > 0;
  };
  h.api.add.playlistSelection();
  await new Promise(setImmediate);
  await h.api.add.toggleSelectedPlaylist({ playlist: 'spotify:playlist:otherLiked', saved: false }, () => {});
  await h.api.add.toggleSelectedPlaylist({ playlist: 'spotify:playlist:otherLoved', saved: true }, () => {});
  assert.equal(h.liked.size, 0);
  assert.equal(h.loved.size, 0);
  assert.deepEqual(h.writes, ['ordinary', 'ordinary']);
  await h.api.add.toggleSelectedPlaylist({ playlist: 'spotify:playlist:37i9dQZF1F5p3rmiWPIYgZ', saved: false }, () => {});
  assert.equal(h.api.like.state('spotify:track:first'), true);
  assert.deepEqual(h.writes, ['ordinary', 'ordinary', 'like']);
});

test('dial Love rejects a changed managed playlist before touching the library or another playlist', async () => {
  const h = harness({ adder: true });
  await new Promise(setImmediate);
  h.api.add.playlistSelection();
  await new Promise(setImmediate);
  let reads = 0;
  h.Platform.RootlistAPI.getContents = async () => ({ items: [{
    type: 'playlist', name: 'Loved Songs', uri: ++reads === 1 ? 'spotify:playlist:loved' : 'spotify:playlist:replacement', isOwnedBySelf: true,
  }] });
  await assert.rejects(h.api.add.toggleSelectedPlaylist({ playlist: 'spotify:playlist:loved', saved: false }, () => {}), /Could not update Loved Songs/);
  assert.deepEqual(h.writes, []);
});
