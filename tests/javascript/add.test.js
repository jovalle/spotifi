const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'spicetify', 'add.js'), 'utf8');

test('playlist overlay backgrounds survive missing Spicetify theme variables', () => {
  assert.match(
    source,
    /--adder-surface: var\(--background-elevated-base, var\(--spice-main, #282828\)\)/,
  );
  assert.match(source, /\.panel \{ background-color: var\(--adder-surface\)/);
  assert.match(source, /\.item-card \{[^}]*background-color: var\(--adder-fill\)/);
});

test('native plus opens the playlist menu on macOS', () => {
  const listeners = {};
  const shortcuts = [];
  let menuEvent;
  class Element {
    closest(selector) {
      return selector === 'button[aria-checked="false"]' ? this : null;
    }
  }
  const button = new Element();
  button.isConnected = true;
  button.__reactFiber$test = {
    memoizedProps: {
      curateDefault() {},
      handleContextMenu(event) {
        menuEvent = event;
      },
      uri: 'spotify:track:test',
    },
  };
  button.setAttribute = (name, value) => {
    if (name === 'aria-label') button.ariaLabel = value;
  };
  const Spicetify = {
    ContextMenu: {},
    Keyboard: { registerShortcut: (shortcut) => shortcuts.push(shortcut) },
    Player: {},
  };
  vm.runInNewContext(source, {
    document: {
      addEventListener() {},
      body: {},
      createElement: () => ({}),
      getElementById: () => null,
      head: { append() {} },
      querySelectorAll: () => [button],
    },
    Element,
    MutationObserver: class {
      observe() {}
    },
    navigator: { userAgentData: { platform: 'macOS' }, platform: 'MacIntel' },
    requestAnimationFrame: (callback) => callback(),
    Spicetify,
    window: {
      Spicetify,
      addEventListener: (type, handler) => {
        listeners[type] = handler;
      },
    },
  });

  const event = {
    target: button,
    type: 'click',
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  listeners.click(event);
  assert.equal(button.ariaLabel, 'Add to Playlists');
  assert.equal(menuEvent.currentTarget, button);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(shortcuts[0].meta, true);
});

function addHarness(buttons = []) {
  const Platform = { LocalStorageAPI: { namespace: 'first-account' } };
  const Spicetify = {
    Platform,
    Player: { data: { item: { uri: 'spotify:track:first' } } },
    ContextMenu: {},
    Keyboard: { registerShortcut() {} },
    showNotification() {},
  };
  const window = { Spicetify, addEventListener() {} };
  vm.runInNewContext(source, {
    window,
    Spicetify,
    document: {
      addEventListener() {},
      createElement: () => ({}),
      head: { append() {} },
      body: {},
      querySelectorAll: () => buttons,
    },
    navigator: { platform: 'MacIntel' },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (callback) => callback(),
  });
  return { api: window.JshMusic.add, Platform, Spicetify };
}

test('Add state mirrors the playing native checkbox, without inferring playlist membership from Like', () => {
  const button = (uri, checked, nowPlaying = false) => ({
    ariaLabel: 'Add to Playlists',
    __reactFiber$test: { memoizedProps: { uri, curateDefault() {} } },
    getAttribute: () => checked,
    closest: () => nowPlaying ? {} : null,
  });
  const buttons = [button('spotify:track:first', 'false'), button('spotify:track:first', 'true', true)];
  const h = addHarness(buttons);
  assert.equal(h.api.state('spotify:track:first'), true);
  buttons[1] = button('spotify:track:first', 'false', true);
  assert.equal(h.api.state('spotify:track:first'), false);
  assert.equal(h.api.state('spotify:track:other'), undefined);
  buttons.splice(0);
  assert.equal(h.api.state('spotify:track:first'), undefined);
});

function removalHarness() {
  const h = addHarness();
  const uri = 'spotify:track:first';
  let rows = [
    { uri: 'spotify:track:before', uid: 'before' },
    { uri, uid: 'playing' },
    { uri, uid: 'duplicate' },
    { uri: 'spotify:track:after', uid: 'after' },
  ];
  let sequence = 0;
  const data = h.Spicetify.Player.data;
  data.context = { uri: 'spotify:playlist:one' };
  data.item = { uri, uid: 'playing', provider: 'context' };
  const mutations = [];
  h.Platform.PlaylistAPI = {
    getMetadata: async () => ({ canAdd: true, canRemove: true, name: 'First playlist' }),
    getContents: async (_, { offset, limit }) => ({
      items: rows.slice(offset, offset + limit),
      totalLength: rows.length,
    }),
    remove: async (context, items) => {
      mutations.push({ action: 'remove', context, items: JSON.parse(JSON.stringify(items)) });
      rows = rows.filter((row) => !items.some((item) => item.uid === row.uid));
    },
    add: async (context, items, position) => {
      mutations.push({ action: 'add', context, items, position });
      const anchor = position.before || position.after;
      const index =
        anchor === 'start'
          ? 0
          : anchor === 'end'
            ? rows.length
            : rows.findIndex((row) => row.uid === anchor.uid) + (position.after ? 1 : 0);
      rows.splice(index, 0, { uri: items[0], uid: `restored-${++sequence}` });
    },
  };
  return {
    ...h,
    data,
    mutations,
    get rows() {
      return rows;
    },
    set rows(value) {
      rows = value;
    },
    async selection() {
      h.api.removalState();
      await new Promise(setImmediate);
      return h.api.removalState();
    },
    change: (action, state = h.api.removalState()) => h.api.changePlayingPlaylist(action, state),
  };
}

test('Remove deletes the playing duplicate only; Undo restores its position and repeated Remove uses the new UID', async () => {
  const h = removalHarness();
  assert.equal((await h.selection()).enabled, true);
  assert.equal((await h.change('remove')).ok, true);
  assert.deepEqual(
    h.rows.map((row) => row.uid),
    ['before', 'duplicate', 'after'],
  );
  assert.equal(h.api.removalState().action, 'undo');
  assert.equal((await h.change('undo')).ok, true);
  assert.deepEqual(
    h.rows.map((row) => row.uid),
    ['before', 'restored-1', 'duplicate', 'after'],
  );
  assert.equal((await h.change('remove')).ok, true);
  assert.equal(h.mutations[2].items[0].uid, 'restored-1');
});

test('Undo survives pause; expires on occurrence, context, provider, track or account transition', async () => {
  for (const change of [
    (h) => {
      h.data.item.uid = 'duplicate';
    },
    (h) => {
      h.data.context.uri = 'spotify:playlist:other';
    },
    (h) => {
      h.data.item.provider = 'queue';
    },
    (h) => {
      h.data.item.uri = 'spotify:track:other';
    },
    (h) => {
      h.Platform.LocalStorageAPI.namespace = 'other-account';
    },
  ]) {
    const h = removalHarness();
    await h.selection();
    await h.change('remove');
    h.data.isPaused = true;
    assert.equal(h.api.removalState().action, 'undo');
    change(h);
    assert.equal(h.api.removalState().action, 'remove');
    h.data.item.uid = 'playing';
    assert.equal(h.api.removalState().action, 'remove');
  }
});

test('Remove fails closed for non-playlist, queued, missing UID, unknown permissions and changed selection', async () => {
  for (const change of [
    (h) => {
      h.data.context.uri = 'spotify:album:one';
    },
    (h) => {
      h.data.item.provider = 'queue';
    },
    (h) => {
      h.data.item.provider = 'autoplay';
    },
    (h) => {
      h.data.item.uid = '';
    },
    (h) => {
      h.Platform.PlaylistAPI.getMetadata = async () => ({ canAdd: true });
    },
    (h) => {
      h.Platform.PlaylistAPI.getMetadata = async () => ({ canRemove: true });
    },
  ]) {
    const h = removalHarness();
    change(h);
    assert.equal((await h.selection()).enabled, false);
    assert.equal((await h.change('remove')).ok, false);
    assert.equal(h.mutations.length, 0);
  }
  const h = removalHarness();
  const expected = await h.selection();
  h.Platform.PlaylistAPI.getMetadata = async () => {
    h.data.item.uid = 'duplicate';
    return { canAdd: true, canRemove: true };
  };
  assert.equal((await h.change('remove', expected)).ok, false);
  assert.equal(h.mutations.length, 0);
});

test('Remove serializes repeats, and an intercepted mutation never reports success', async () => {
  const h = removalHarness();
  const expected = await h.selection();
  let release;
  h.Platform.PlaylistAPI.remove = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = h.change('remove', expected);
  await new Promise(setImmediate);
  assert.equal((await h.change('remove', expected)).ok, false);
  release();
  assert.equal((await pending).ok, false);
  assert.equal(h.api.removalState().action, 'remove');
});

test('Undo verifies uncertain writes and external restores without duplicating membership', async () => {
  const h = removalHarness();
  await h.selection();
  const remove = h.Platform.PlaylistAPI.remove;
  h.Platform.PlaylistAPI.remove = async (...args) => {
    await remove(...args);
    throw new Error('Lost response');
  };
  assert.equal((await h.change('remove')).ok, false);
  assert.equal(h.api.removalState().action, 'undo');
  const add = h.Platform.PlaylistAPI.add;
  h.Platform.PlaylistAPI.add = async (...args) => {
    await add(...args);
    throw new Error('Lost add response');
  };
  assert.equal((await h.change('undo')).ok, false);
  assert.equal((await h.change('undo')).ok, true);
  assert.equal(h.mutations.filter((m) => m.action === 'add').length, 1);
  assert.equal(h.api.removalState().action, 'remove');

  const external = removalHarness();
  await external.selection();
  await external.change('remove');
  external.rows.splice(1, 0, { uri: external.data.item.uri, uid: 'external-restore' });
  assert.equal((await external.change('undo')).ok, true);
  assert.equal(external.mutations.length, 1);
});

test('Undo checks fresh permissions and rejects reversed or lost placement anchors', async () => {
  for (const alter of [
    (h) => {
      h.rows.reverse();
    },
    (h) => {
      h.rows = [];
    },
    (h) => {
      h.Platform.PlaylistAPI.getMetadata = async () => ({ canRemove: true });
    },
  ]) {
    const h = removalHarness();
    await h.selection();
    await h.change('remove');
    alter(h);
    assert.equal((await h.change('undo')).ok, false);
    assert.equal(h.mutations.length, 1);
    assert.equal(h.api.removalState().action, 'undo');
  }
});

test('Undo restores boundary and sole entries; Remove reads natural order through multiple pages', async () => {
  for (const index of [0, 1, 2]) {
    const h = removalHarness();
    h.rows = [
      { uri: 'spotify:track:x', uid: 'x' },
      { uri: 'spotify:track:y', uid: 'y' },
    ];
    h.rows.splice(index, 0, { uri: h.data.item.uri, uid: 'playing' });
    await h.selection();
    await h.change('remove');
    assert.equal((await h.change('undo')).ok, true);
    assert.equal(h.rows[index].uid, 'restored-1');
  }
  const sole = removalHarness();
  sole.rows = [{ uri: sole.data.item.uri, uid: 'playing' }];
  await sole.selection();
  await sole.change('remove');
  assert.equal((await sole.change('undo')).ok, true);

  const paged = removalHarness();
  paged.rows = Array.from({ length: 205 }, (_, i) => ({ uri: 'spotify:track:other', uid: `${i}` }));
  paged.rows[150] = { uri: paged.data.item.uri, uid: 'playing' };
  await paged.selection();
  await paged.change('remove');
  assert.equal((await paged.change('undo')).ok, true);
  assert.equal(paged.rows[150].uid, 'restored-1');
});

test('Undo refuses external or uncertain matching entries at the wrong position', async () => {
  for (const lostResponse of [false, true]) {
    const h = removalHarness();
    await h.selection();
    await h.change('remove');
    if (lostResponse) {
      h.Platform.PlaylistAPI.add = async () => {
        h.rows.push({ uri: h.data.item.uri, uid: 'wrong-slot' });
        throw new Error('Lost response');
      };
      assert.equal((await h.change('undo')).ok, false);
    } else h.rows.push({ uri: h.data.item.uri, uid: 'external-wrong-slot' });
    assert.equal((await h.change('undo')).ok, false);
    assert.equal(h.api.removalState().action, 'undo');
    assert.equal(h.rows.filter((row) => row.uri === h.data.item.uri).length, 2);
  }
});

test('Undo rejects a resolved add at the wrong position and cannot remove an unrelated external restore', async () => {
  const h = removalHarness();
  await h.selection();
  await h.change('remove');
  h.Platform.PlaylistAPI.add = async () => {
    h.rows.push({ uri: h.data.item.uri, uid: 'wrong-slot' });
  };
  assert.equal((await h.change('undo')).ok, false);
  assert.equal(h.api.removalState().action, 'undo');
  const external = removalHarness();
  await external.selection();
  await external.change('remove');
  external.rows.splice(1, 0, { uri: external.data.item.uri, uid: 'external-restore' });
  assert.equal((await external.change('undo')).ok, true);
  assert.equal((await external.change('remove')).ok, false);
  assert.equal(external.mutations.length, 1);
});

function selectorHarness(items = []) {
  const h = addHarness();
  const reads = [];
  const writes = [];
  let rows = items;
  h.Platform.LibraryAPI = {
    getContents: async (options) => {
      assert.deepEqual(Array.from(options.filters), ['2', '101']);
      assert.equal(options.sortOrder, '5');
      assert.equal(options.flattenTree, true);
      return { items: structuredClone(rows.slice(options.offset, options.offset + options.limit)), totalLength: rows.length };
    },
  };
  h.Platform.CurationAPI = {
    async getCurationContexts(options) {
      reads.push(options);
      return { items: structuredClone(rows.slice(options.offset, options.offset + options.limit)), totalLength: rows.length };
    },
    async curateItems(uri, add, remove) {
      writes.push({ uri, add, remove });
      for (const item of rows) {
        if (add.includes(item.uri)) item.hasCuratedItems = true;
        if (remove.includes(item.uri)) item.hasCuratedItems = false;
      }
    },
  };
  return { ...h, reads, writes, rows: (next) => { rows = next; },
    async load() { h.api.playlistSelection(); await new Promise(setImmediate); return h.api.playlistSelection(); } };
}
const playlistItem = (id, saved = false) => ({ uri: `spotify:playlist:${id}`, name: id, hasCuratedItems: saved });

test('dial membership comes first, keeps native recent-edit order and caches reads', async () => {
  const h = selectorHarness([playlistItem('recent'), playlistItem('inRecent', true), playlistItem('old'), playlistItem('inOld', true)]);
  const state = await h.load();
  assert.equal(state.ready, true);
  assert.deepEqual(Array.from(state.playlists, (p) => p.name), ['inRecent', 'inOld', 'recent', 'old']);
  for (let i = 0; i < 100; i++) h.api.playlistSelection();
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].sortOrder, 5);
  assert.deepEqual(Array.from(state.playlists, (p) => p.recent), [1, 3, 0, 2]);
  h.Spicetify.Player.data.item.uri = 'spotify:track:next';
  assert.equal(h.api.playlistSelection().ready, false);
  await new Promise(setImmediate);
  assert.equal(h.reads.length, 2);
  h.Platform.LocalStorageAPI.namespace = 'other';
  assert.equal(h.api.playlistSelection().ready, false);
});

test('dial paginates playlists, ignores folders, and preserves recency when no playlist contains the track', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => playlistItem(String(i)));
  rows.splice(3, 0, { uri: 'spotify:folder:one', name: 'Folder' });
  const h = selectorHarness(rows);
  const state = await h.load();
  assert.equal(state.playlists.length, 1001);
  assert.equal(state.playlists[0].uri, 'spotify:playlist:0');
  assert.equal(state.playlists.at(-1).uri, 'spotify:playlist:1000');
  assert.deepEqual(h.reads.map((r) => r.offset), [0, 1000]);
});

test('dial toggles once, confirms membership, rejects stale state and cannot mutate without membership data', async () => {
  const h = selectorHarness([playlistItem('one')]);
  await h.load();
  const expected = { playlist: 'spotify:playlist:one', saved: false };
  const result = await h.api.toggleSelectedPlaylist(expected, () => {});
  assert.equal(result.ok, true);
  assert.deepEqual(h.writes.map((w) => [w.uri, Array.from(w.add), Array.from(w.remove)]),
    [['spotify:track:first', ['spotify:playlist:one'], []]]);
  assert.equal(h.api.playlistSelection().playlists[0].saved, true);
  await assert.rejects(h.api.toggleSelectedPlaylist(expected, () => {}), /membership changed/);
  await h.api.toggleSelectedPlaylist({ ...expected, saved: true }, () => {});
  assert.equal(h.api.playlistSelection().playlists[0].saved, false);
  assert.equal(h.writes.length, 2);
  h.rows([{ uri: expected.playlist, name: 'Unknown' }]);
  await assert.rejects(h.api.toggleSelectedPlaylist(expected, () => {}), /membership changed/);
  assert.equal(h.writes.length, 2);
  const offline = addHarness();
  offline.api.playlistSelection();
  await new Promise(setImmediate);
  assert.equal(offline.api.playlistSelection().ready, false);
  assert.match(offline.api.playlistSelection().error, /unavailable/);
});

test('dial rejects track/account changes during lookup, serializes presses and does not retry lost writes', async () => {
  for (const change of ['track', 'account']) {
    const h = selectorHarness([playlistItem('one')]);
    await h.load();
    const read = h.Platform.CurationAPI.getCurationContexts;
    let release;
    h.Platform.CurationAPI.getCurationContexts = async (options) => {
      await new Promise((resolve) => { release = resolve; });
      return read(options);
    };
    const toggle = h.api.toggleSelectedPlaylist({ playlist: 'spotify:playlist:one', saved: false }, () => {});
    await assert.rejects(h.api.toggleSelectedPlaylist({ playlist: 'spotify:playlist:one', saved: false }, () => {}), /unavailable/);
    if (change === 'track') h.Spicetify.Player.data.item.uri = 'spotify:track:next';
    else h.Platform.LocalStorageAPI.namespace = 'other';
    release();
    await assert.rejects(toggle, /changed/);
    assert.equal(h.writes.length, 0);
  }
  const h = selectorHarness([playlistItem('one')]);
  await h.load();
  let attempts = 0;
  h.Platform.CurationAPI.curateItems = async () => { attempts++; throw new Error('Lost response'); };
  await assert.rejects(h.api.toggleSelectedPlaylist({ playlist: 'spotify:playlist:one', saved: false }, () => {}), /Lost response/);
  assert.equal(attempts, 1);
});

test('dial rejects unconfirmed writes and late refreshes cannot overwrite verified membership', async () => {
  const h = selectorHarness([playlistItem('one')]);
  await h.load();
  let release;
  const read = h.Platform.CurationAPI.getCurationContexts;
  h.Spicetify.Player.data.item.uri = 'spotify:track:next';
  h.Platform.CurationAPI.getCurationContexts = async () => new Promise((resolve) => { release = resolve; });
  h.api.playlistSelection();
  await new Promise(setImmediate);
  h.Platform.CurationAPI.getCurationContexts = read;
  await h.api.toggleSelectedPlaylist({ playlist: 'spotify:playlist:one', saved: false }, () => {});
  release({ items: [playlistItem('one', false)], totalLength: 1 });
  await new Promise(setImmediate);
  assert.equal(h.api.playlistSelection().playlists[0].saved, true);
  h.Platform.CurationAPI.curateItems = async () => {};
  await assert.rejects(h.api.toggleSelectedPlaylist({ playlist: 'spotify:playlist:one', saved: true }, () => {}), /unconfirmed/);
});

test('dial exports cover URLs and global recency independently of membership grouping', async () => {
  const rows = [playlistItem('oldSaved', true), playlistItem('newOut'), playlistItem('newSaved', true)];
  rows[0].images = [{ url: 'spotify:image:cover' }];
  const h = selectorHarness(rows);
  h.Platform.LibraryAPI.getContents = async () => ({ items: [rows[1], rows[2], rows[0]], totalLength: 3 });
  const state = await h.load();
  assert.deepEqual(Array.from(state.playlists, (p) => p.name), ['newSaved', 'oldSaved', 'newOut']);
  const old = state.playlists.find((p) => p.name === 'oldSaved');
  assert.equal(old.recent, 2);
  assert.equal(old.image, 'https://i.scdn.co/image/cover');
});
