const { readFile } = require('node:fs/promises');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { randomInt } = require('node:crypto');

const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const socket = new WebSocket(`ws://127.0.0.1:${argument('-port')}`);
const contexts = new Map();
const actions = { __proto__: null,
  'com.jovalle.spotifi.love': 'love',
  'com.jovalle.spotifi.like': 'like',
  'com.jovalle.spotifi.add': 'add',
  'com.jovalle.spotifi.seek-forward': 'seek-forward',
  'com.jovalle.spotifi.queue': 'queue-toggle',
  'com.jovalle.spotifi.spotify': 'spotify',
  'com.jovalle.spotifi.shuffle': 'shuffle',
  'com.jovalle.spotifi.randomize': 'randomize',
  'com.jovalle.spotifi.playlists': 'playlist',
  'com.jovalle.spotifi.seek': 'seek',
};
const stateKeys = { love: 'loved', like: 'liked', add: 'added', shuffle: 'shuffle' };
let polling = false;
let pressing = false;
let pending;
let confirmed;
let received = 0;
const sortModes = ['Track first', 'A–Z', 'Z–A', 'Recent edits', 'Oldest edits'];
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const covers = new Map();
const coverLimit = 256 * 1024;

function coverFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.port ||
        !(parsed.hostname.endsWith('.scdn.co') || parsed.hostname.endsWith('.spotifycdn.com'))) return 'imgs/add-action.png';
  } catch { return 'imgs/add-action.png'; }
  let cover = covers.get(url);
  if (!cover || (!cover.loading && !cover.image && Date.now() >= cover.retryAt)) {
    cover = { loading: true };
    covers.set(url, cover);
    if (covers.size > 64) covers.delete(covers.keys().next().value);
    // Covers never block selection, sorting or curation requests.
    void fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' }).then(async (response) => {
      const type = response.headers.get('content-type')?.split(';')[0];
      if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type) ||
          Number(response.headers.get('content-length')) > coverLimit) {
        await response.body?.cancel?.();
        throw new Error('Invalid cover');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > coverLimit) throw new Error('Invalid cover size');
        chunks.push(chunk);
      }
      if (!size) throw new Error('Empty cover');
      const bytes = Buffer.concat(chunks);
      cover.image = `data:${type};base64,${bytes.toString('base64')}`;
    }).catch(() => { cover.retryAt = Date.now() + 30000; }).finally(() => {
      cover.loading = false;
      render(confirmed);
    });
  }
  return cover.image || 'imgs/add-action.png';
}

function sortPlaylists(entry) {
  const order = [...(entry.items?.values() || [])];
  const mode = entry.sort || 0;
  order.sort((a, b) => {
    const alphabetical = names.compare(a.name, b.name) || a.uri.localeCompare(b.uri);
    if (mode === 1) return alphabetical;
    if (mode === 2) return -alphabetical;
    const recent = (a.recent ?? Infinity) - (b.recent ?? Infinity);
    if (mode === 4) {
      if (a.recent == null || b.recent == null) return Number(a.recent == null) - Number(b.recent == null) || alphabetical;
      return -recent || alphabetical;
    }
    return (mode === 0 ? Number(b.saved) - Number(a.saved) : 0) || recent || alphabetical;
  });
  entry.order = order.map((item) => item.uri);
}

function dialClick(context) {
  const entry = contexts.get(context);
  if (!entry) return;
  if (entry.clickTimer || entry.doubleClick) {
    clearTimeout(entry.clickTimer);
    entry.clickTimer = undefined;
    entry.doubleClick = false;
    entry.sort = ((entry.sort || 0) + 1) % sortModes.length;
    entry.settings = { ...entry.settings, sort: entry.sort };
    sortPlaylists(entry);
    send('setSettings', context, entry.settings);
  } else {
    const selection = { selected: entry.selected, track: entry.track, saved: entry.items?.get(entry.selected)?.saved };
    // Delay a single click so double-click sorting can never also mutate a playlist.
    entry.clickTimer = setTimeout(() => {
      entry.clickTimer = undefined;
      if (contexts.get(context) === entry) void press(context, 'playlist', selection);
    }, 300);
  }
  renderPlaylist(context, entry, confirmed);
}

function cancelClick(entry) {
  clearTimeout(entry.clickTimer);
  entry.clickTimer = undefined;
  entry.doubleClick = false;
  if (entry.down) entry.cancelRelease = true;
}

function send(event, context, payload = {}) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ event, context, payload }));
}

async function request(body, route = 'love') {
  const config = JSON.parse(await readFile(join(homedir(), 'Library/Application Support/spotifi/config.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(config.token) || !Number.isInteger(config.port) ||
      config.port < 1024 || config.port > 65535) throw new Error('Invalid companion configuration');
  const response = await fetch(`http://127.0.0.1:${config.port}/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Spotify companion unavailable or track changed');
  return response.json();
}

function remember(data) {
  data.state = { ...data.state };
  if (confirmed && data.state.uri === confirmed.state.uri && data.state.account === confirmed.state.account) {
    for (const key of ['liked', 'loved', 'added', 'shuffle']) {
      if (typeof data.state[key] !== 'boolean') data.state[key] = confirmed.state[key];
    }
  }
  confirmed = data;
  received = Date.now();
}

function render(data) {
  const track = { ...data?.state };
  if (pending && pending.uri === track.uri && pending.account === track.account) {
    if (pending.action === 'love') {
      track.loved = pending.value;
      if (pending.value) track.liked = true;
    } else if (pending.action === 'like') {
      track.liked = pending.value;
      if (!pending.value) track.loved = false;
    } else if (pending.action === 'shuffle') {
      track.shuffle = pending.value;
    }
  }
  for (const [context, entry] of contexts) {
    if (entry.action === 'seek') {
      renderSeek(context, entry, data);
      continue;
    }
    if (entry.action === 'playlist') {
      renderPlaylist(context, entry, data);
      continue;
    }
    const key = stateKeys[entry.action];
    const available = entry.action === 'spotify' || (['randomize', 'queue-toggle'].includes(entry.action) ? !!track.account :
      entry.action === 'shuffle' ? typeof track.shuffle === 'boolean' :
      track.supported && (!key || entry.action === 'add' || typeof track[key] === 'boolean'));
    const state = entry.action === 'randomize' ? (entry.state ?? 0) : available && track[key] ? 1 : 0;
    const title = entry.action === 'spotify' ? '' : !data?.connected ? 'Offline' : !available ? 'No track' : '';
    if (entry.state !== state) send('setState', context, { state });
    if (entry.title !== title) send('setTitle', context, { title, target: 0 });
    entry.state = state;
    entry.title = title;
  }
}

function renderSeek(context, entry, data) {
  const track = data?.state || {};
  const key = `${track.account}:${track.uri}`;
  if (entry.track !== key) {
    entry.track = key;
    entry.seekTarget = undefined;
    entry.seekQueued = undefined;
  }
  const available = data?.connected && track.supported && track.canSeek &&
    Number.isFinite(track.position) && Number.isFinite(track.duration) && track.duration > 0;
  if (!available || Date.now() > entry.seekUntil) entry.seekTarget = undefined;
  const format = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const position = Math.max(0, Math.min(track.duration, entry.seekTarget ?? track.position));
  const feedback = { progress: { value: available ? position / track.duration * 100 : 0 },
    position: available ? `${format(position)} / ${format(track.duration)}` : '--:--',
    status: !data?.connected ? 'Offline' : !available ? 'Unavailable' : '← 1s · 1s →' };
  const serialized = JSON.stringify(feedback);
  if (entry.feedback !== serialized) send('setFeedback', context, feedback);
  entry.feedback = serialized;
}

async function seekDial(context, ticks) {
  const entry = contexts.get(context);
  if (!entry || !Number.isInteger(ticks) || !ticks || Math.abs(ticks) > 128) return;
  const track = confirmed?.state;
  if (!confirmed?.connected || Date.now() - received > 4000 || !track?.supported || !track.canSeek ||
      !Number.isFinite(track.position) || !Number.isFinite(track.duration) || track.duration <= 0) {
    send('showAlert', context);
    return;
  }
  renderSeek(context, entry, confirmed);
  entry.seekTarget = Math.max(0, Math.min(track.duration - 1, (entry.seekTarget ?? track.position) + ticks * 1000));
  entry.seekUntil = Date.now() + 800;
  entry.seekQueued = { uri: track.uri, account: track.account, position: entry.seekTarget };
  renderSeek(context, entry, confirmed);
  if (entry.seeking) return;
  entry.seeking = true;
  try {
    // Send immediately; turns during an in-flight request replace its next absolute target.
    while (entry.seekQueued && contexts.get(context) === entry) {
      const body = entry.seekQueued;
      entry.seekQueued = undefined;
      try {
        await request(body, 'seek');
      } catch {
        send('showAlert', context);
        if (!entry.seekQueued) {
          entry.seekTarget = undefined;
          renderSeek(context, entry, confirmed);
        }
      }
    }
  } finally {
    entry.seeking = false;
  }
}

function renderPlaylist(context, entry, data) {
  const track = data?.state || {};
  const selector = track.playlistSelector;
  const key = `${track.account}:${track.uri}`;
  const playlists = selector?.playlists || [];
  if (entry.track !== key) {
    cancelClick(entry);
    entry.track = key;
    entry.order = [];
    entry.selector = undefined;
    entry.items = undefined;
    entry.selected = undefined;
    entry.error = '';
  }
  // Freeze browsing order for this track so updates cannot move the dial's target.
  if (entry.selector !== selector || !entry.items) {
    const known = new Set(entry.order);
    entry.items = new Map(playlists.map((item) => [item.uri, item]));
    entry.order = entry.order.filter((uri) => entry.items.has(uri));
    entry.order.push(...playlists.filter((item) => !known.has(item.uri)).map((item) => item.uri));
    if (!known.size) sortPlaylists(entry);
    if (!entry.items.has(entry.selected)) entry.selected = entry.order[0];
    entry.selector = selector;
  }
  const playlist = entry.items.get(entry.selected);
  const updating = pending?.action === 'playlist' && pending.uri === track.uri &&
    pending.account === track.account && pending.playlist === entry.selected;
  const saved = updating ? pending.value : playlist?.saved;
  const status = !data?.connected ? 'Offline' : !track.supported ? 'No track' :
    entry.error || selector?.error ? 'Check Spotify' : !playlist ? (selector?.loading ? 'Loading…' : 'No playlists') :
    typeof saved !== 'boolean' ? 'Unavailable' : entry.clickTimer || entry.doubleClick ? '2nd click: sort' :
    updating ? (saved ? 'Adding…' : 'Removing…') : saved ? 'In playlist' : 'Press to add';
  const feedback = { name: playlist?.name || 'Playlists',
    cover: coverFor(playlist?.image),
    sort: sortModes[entry.sort || 0],
    status: { value: status, color: saved ? '#1ed760' : '#b3b3b3' },
    position: playlist ? `${entry.order.indexOf(entry.selected) + 1} / ${entry.order.length}` : '',
    membership: { value: saved ? 'imgs/added.png' : 'imgs/add.png', enabled: typeof saved === 'boolean' && !!data?.connected && !!track.supported } };
  const serialized = JSON.stringify(feedback);
  if (entry.feedback !== serialized) send('setFeedback', context, feedback);
  entry.feedback = serialized;
}

function rotate(context, ticks) {
  const entry = contexts.get(context);
  if (!entry?.order?.length || !Number.isInteger(ticks)) return;
  cancelClick(entry);
  const index = entry.order.indexOf(entry.selected);
  entry.selected = entry.order[((index + ticks) % entry.order.length + entry.order.length) % entry.order.length];
  entry.error = '';
  renderPlaylist(context, entry, confirmed);
}

async function poll() {
  if (polling || !contexts.size) return;
  polling = true;
  try {
    const data = await request();
    remember(data);
    if (pending) {
      const result = data.results?.find((result) => result.id === pending.id);
      const sameTrack = pending.uri === data.state.uri && pending.account === data.state.account;
      const key = stateKeys[pending.action];
      if (result?.ok === false || Date.now() > pending.expires) {
        send('showAlert', pending.context);
        if (pending.action === 'playlist' && contexts.has(pending.context)) contexts.get(pending.context).error = 'Check Spotify';
        pending = undefined;
      } else if (result?.ok === true && (pending.action === 'playlist' ?
        !sameTrack || data.state.playlistSelector?.playlists?.find((item) => item.uri === pending.playlist)?.saved === pending.value :
        !key || pending.action === 'add' || !sameTrack || data.state[key] === pending.value)) {
        pending = undefined;
      }
    }
    render(data);
  } catch {
    // Brief transport failures must not erase a known fill or the pending target.
    if (Date.now() - received > 4000) render({ ...confirmed, connected: false });
    if (pending && Date.now() > pending.expires) {
      send('showAlert', pending.context);
      pending = undefined;
    }
  } finally {
    polling = false;
  }
}

async function press(context, action = contexts.get(context)?.action, selection) {
  if (action === 'spotify') {
    execFile('/usr/bin/open', ['-b', 'com.spotify.client'], (error) => { if (error) send('showAlert', context); });
    return;
  }
  if (pressing || pending) return;
  const entry = contexts.get(context);
  const selected = selection ? selection.selected : entry?.selected;
  const selectedTrack = selection ? selection.track : entry?.track;
  pressing = true;
  try {
    if (!confirmed || Date.now() - received > 4000) remember(await request());
    const data = confirmed;
    const key = stateKeys[action];
    if (!data.connected || !data.state?.account ||
        (!['shuffle', 'randomize', 'queue-toggle'].includes(action) && !data.state.supported) ||
        (key && action !== 'add' && typeof data.state[key] !== 'boolean') || data.busy)
      throw new Error('Action unavailable');
    const body = { action, uri: data.state.uri, account: data.state.account };
    if (action === 'playlist') {
      const selector = data.state.playlistSelector;
      const playlist = selector?.playlists?.find((item) => item.uri === selected);
      if (selectedTrack !== `${body.account}:${body.uri}` || !selector?.ready || !playlist || typeof playlist.saved !== 'boolean')
        throw new Error('Playlist membership unavailable');
      if (selection && selection.saved !== playlist.saved) throw new Error('Playlist membership changed');
      body.playlist = selected;
      body.saved = playlist.saved;
      entry.error = '';
    }
    if (key && action !== 'add') body[key] = data.state[key];
    pending = { context, action, uri: body.uri, account: body.account,
      playlist: body.playlist,
      value: action === 'playlist' ? !body.saved : key && action !== 'add' ? !body[key] : undefined,
      expires: Date.now() + 17000 };
    if (action === 'randomize') {
      const entry = contexts.get(context);
      entry.state = ((entry.state ?? 0) + 1 + randomInt(5)) % 6;
      send('setState', context, { state: entry.state });
    }
    render(data);
    const result = await request(body);
    if (typeof result.id !== 'string') throw new Error('Missing confirmation');
    pending.id = result.id;
  } catch {
    // A lost reply can follow a successful write; never retry a toggle automatically.
    send('showAlert', context);
    if (action === 'playlist' && entry) entry.error = 'Check Spotify';
    pending = undefined;
    render(confirmed);
  } finally {
    pressing = false;
    await poll();
  }
}

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ event: argument('-registerEvent'), uuid: argument('-pluginUUID') }));
});
socket.addEventListener('message', ({ data }) => {
  let message;
  try { message = JSON.parse(data); } catch { return; }
  const action = actions[message.action];
  if (!action) return;
  if (message.event === 'willAppear') {
    const settings = message.payload?.settings || {};
    clearTimeout(contexts.get(message.context)?.clickTimer);
    contexts.set(message.context, { action, state: message.payload?.state, settings,
      sort: Number.isInteger(settings.sort) && settings.sort >= 0 && settings.sort < sortModes.length ? settings.sort : 0 });
    if (action === 'playlist') send('setFeedbackLayout', message.context, { layout: 'layouts/playlists.json' });
    if (action === 'seek') send('setFeedbackLayout', message.context, { layout: 'layouts/seek.json' });
    void poll();
  } else if (message.event === 'willDisappear') {
    clearTimeout(contexts.get(message.context)?.clickTimer);
    contexts.delete(message.context);
  } else if (message.event === 'keyDown') {
    void press(message.context, action);
  } else if (action === 'seek' && message.event === 'dialRotate') {
    void seekDial(message.context, message.payload?.ticks);
  } else if (action === 'playlist' && message.event === 'dialRotate') {
    rotate(message.context, message.payload?.ticks);
  } else if (action === 'playlist' && message.event === 'dialDown') {
    const entry = contexts.get(message.context);
    if (!entry) return;
    entry.down = true;
    if (entry.clickTimer) {
      clearTimeout(entry.clickTimer);
      entry.clickTimer = undefined;
      entry.doubleClick = true;
    }
  } else if (action === 'playlist' && message.event === 'dialUp') {
    const entry = contexts.get(message.context);
    if (!entry?.down) return;
    entry.down = false;
    if (entry.cancelRelease) {
      entry.cancelRelease = false;
      renderPlaylist(message.context, entry, confirmed);
    } else dialClick(message.context);
  }
});
const timer = setInterval(poll, 250);
socket.addEventListener('close', () => { clearInterval(timer); process.exit(0); });
socket.addEventListener('error', () => { clearInterval(timer); process.exit(1); });
