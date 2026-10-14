// Integration tests: boots the real server against a real MongoDB-compatible database.
// Run with:  MONGO_URI=mongodb://127.0.0.1:27017/ichat_test npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { api, signup, client, connected, waitFor, expectNothing, sleep } = require('./helpers');

process.env.JWT_SECRET = 'test-secret';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ichat_test';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.API_RATE_LIMIT = '10000';

let app, base, stopServer;
const sockets = [];
const open = async (token) => { const s = client(base, token); sockets.push(s); await connected(s); s.emit('join'); await waitFor(s, 'previousMessages'); return s; };

before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  app = require('../index');
  const running = await app.start(0);
  stopServer = running.stop;
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  sockets.forEach(s => s.close());
  await stopServer();
});

// ---------------------------------------------------------------------------
test('accounts: register, duplicate names, generic login errors', async () => {
  assert.equal((await api(base, 'POST', '/api/auth/register', { username: 'Alice', password: 'secret123' })).status, 200);
  // "alice" differs only by case — must be refused
  assert.equal((await api(base, 'POST', '/api/auth/register', { username: 'alice', password: 'secret123' })).status, 409);
  assert.equal((await api(base, 'POST', '/api/auth/register', { username: 'ab', password: 'secret123' })).status, 400);

  const noUser = await api(base, 'POST', '/api/auth/login', { username: 'ghost', password: 'whatever1' });
  const badPass = await api(base, 'POST', '/api/auth/login', { username: 'Alice', password: 'wrongwrong' });
  assert.equal(noUser.status, 401);
  assert.equal(badPass.status, 401);
  assert.equal(noUser.body.message, badPass.body.message, 'must not reveal whether the username exists');

  const ok = await api(base, 'POST', '/api/auth/login', { username: 'Alice', password: 'secret123' });
  assert.ok(ok.body.token);
});

test('profiles: only you can edit yourself, and the password hash never leaks', async () => {
  const tA = await signup(base, 'pro_a');
  const tB = await signup(base, 'pro_b');

  const other = await api(base, 'PUT', '/api/profile/pro_b', { bio: 'hacked' }, tA);
  assert.equal(other.status, 403);
  const pw = await api(base, 'PUT', '/api/profile/pro_b/password', { currentPassword: 'secret123', newPassword: 'newsecret1' }, tA);
  assert.equal(pw.status, 403);

  const own = await api(base, 'PUT', '/api/profile/pro_b', { bio: 'hi there', status: 'busy' }, tB);
  assert.equal(own.status, 200);
  assert.equal(own.body.user.bio, 'hi there');
  assert.equal(own.body.user.password, undefined, 'password hash must not be returned');
  assert.equal(JSON.stringify(own.body).includes('$2'), false);

  assert.equal((await api(base, 'PUT', '/api/profile/pro_b', { status: 'god-mode' }, tB)).status, 400);
  assert.equal((await api(base, 'PUT', '/api/profile/pro_b', { bio: 'x'.repeat(500) }, tB)).status, 400);
  assert.equal((await api(base, 'PUT', '/api/profile/pro_b/password', { currentPassword: 'secret123', newPassword: '123' }, tB)).status, 400);
  assert.equal((await api(base, 'PUT', '/api/profile/pro_b', { bio: 'no token' })).status, 401);
});

test('uploads: avatars must be real images; stickers belong to the logged-in user', async () => {
  const token = await signup(base, 'up1');
  const other = await signup(base, 'up2');

  const form = new FormData();
  form.append('avatar', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
  let res = await fetch(`${base}/api/profile/up1/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(res.status, 400, 'html pretending to be an avatar is refused');

  // image header lie: claims PNG but the bytes are text
  const fake = new FormData();
  fake.append('avatar', new Blob(['not really a png'], { type: 'image/png' }), 'a.png');
  res = await fetch(`${base}/api/profile/up1/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fake });
  assert.equal(res.status, 400);

  // a genuine 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const good = new FormData();
  good.append('sticker', new Blob([png], { type: 'image/png' }), 's.png');
  good.append('owner', 'up2'); // trying to upload as someone else
  res = await fetch(`${base}/api/stickers`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: good });
  assert.equal(res.status, 200);
  const sticker = await res.json();
  assert.equal(sticker.owner, 'up1', 'owner comes from the login token, not the request body');

  const del = await api(base, 'DELETE', `/api/stickers/${sticker._id}`, { owner: 'up1' }, other);
  assert.equal(del.status, 403, 'another user cannot delete it even by claiming to be the owner');
  assert.equal((await api(base, 'DELETE', `/api/stickers/${sticker._id}`, {}, token)).status, 200);
  assert.equal((await api(base, 'DELETE', '/api/stickers/not-an-id', {}, token)).status, 404);
});

test('uploaded files that could run scripts are served as downloads', async () => {
  const token = await signup(base, 'fileguy');
  const form = new FormData();
  form.append('file', new Blob(['<h1>hi</h1><script>1</script>'], { type: 'text/plain' }), 'page.html');
  const up = await fetch(`${base}/api/upload/file`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(up.status, 200);
  const { fileUrl } = await up.json();
  const got = await fetch(fileUrl.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(got.headers.get('content-disposition'), 'attachment');
  assert.match(got.headers.get('content-security-policy') || '', /sandbox/);
});

// ---------------------------------------------------------------------------
test('sockets: login token required, identity comes from the token', async () => {
  await assert.rejects(connected(client(base, undefined)), /unauthorized/);
  await assert.rejects(connected(client(base, 'garbage.token.here')), /unauthorized/);

  const tA = await signup(base, 'soc_a');
  const tB = await signup(base, 'soc_b');
  const a = await open(tA);
  const b = await open(tB);

  // A tries to speak as B — the server must ignore the forged name
  const got = waitFor(b, 'message', m => m.text === 'hello room');
  a.emit('message', { username: 'soc_b', text: 'hello room', targetRoom: 'general' });
  const msg = await got;
  assert.equal(msg.username, 'soc_a');

  // Garbage payloads are ignored; the server stays alive
  a.emit('message', null);
  a.emit('message', { text: 12345, targetRoom: { $ne: 1 } });
  a.emit('reaction', { messageId: 'nope', emoji: 'x' });
  a.emit('votePoll', { pollId: {}, optionIndex: 'x' });
  a.emit('searchMessages', 42);
  const again = waitFor(b, 'message', m => m.text === 'still alive');
  a.emit('message', { text: 'still alive', targetRoom: 'general' });
  await again;

  // unsafe URLs are stripped
  const urlMsg = waitFor(b, 'message', m => m.text === 'link test');
  a.emit('message', { text: 'link test', fileUrl: 'javascript:alert(1)', imageUrl: 'data:text/html,hi' });
  const clean = await urlMsg;
  assert.equal(clean.fileUrl, '');
  assert.equal(clean.imageUrl, '');
});

test('direct messages: delivered to both people only, ids cannot collide', async () => {
  const tx = await signup(base, 'dmx');
  const ty = await signup(base, 'dmy');
  const tz = await signup(base, 'dmz');
  const x = await open(tx), y = await open(ty), z = await open(tz);

  const gotY = waitFor(y, 'dmMessage', m => m.text === 'secret hello');
  const gotX = waitFor(x, 'dmMessage', m => m.text === 'secret hello');
  const spy = expectNothing(z, 'dmMessage');
  x.emit('dmMessage', { fromUser: 'dmz', toUser: 'dmy', text: 'secret hello' }); // fromUser is ignored
  const [m] = await Promise.all([gotY, gotX]);
  assert.equal(m.username, 'dmx');
  await spy;

  // z tries to read the x<->y conversation by claiming to be x
  z.emit('openDM', { fromUser: 'dmx', toUser: 'dmy' });
  const mine = await waitFor(z, 'dmMessages');
  assert.equal(mine.dmId, 'dmy:dmz');
  assert.equal(mine.messages.length, 0);

  // z can't pin/star/react to a DM message between x and y
  const spy2 = expectNothing(x, 'messagePinned');
  z.emit('pinMessage', { messageId: m._id });
  await spy2;
  z.emit('toggleStar', { messageId: m._id });
  await expectNothing(z, 'starUpdated');

  // Usernames with underscores no longer collide: (ppp_qqq, rrr) vs (ppp, qqq_rrr) — the old format gave both "ppp_qqq_rrr"
  const t1 = await signup(base, 'ppp_qqq'), t2 = await signup(base, 'rrr'), t3 = await signup(base, 'ppp'), t4 = await signup(base, 'qqq_rrr');
  const s1 = await open(t1), s2 = await open(t2), s3 = await open(t3), s4 = await open(t4);
  const d1 = waitFor(s2, 'dmMessage', m2 => m2.text === 'pair one');
  const leak = expectNothing(s4, 'dmMessage');
  s1.emit('dmMessage', { toUser: 'rrr', text: 'pair one' });
  const first = await d1;
  await leak;
  s3.emit('dmMessage', { toUser: 'qqq_rrr', text: 'pair two' });
  const second = await waitFor(s4, 'dmMessage', m2 => m2.text === 'pair two');
  assert.notEqual(first.dmId, second.dmId);
});

test('edit and delete are limited to the author', async () => {
  const a = await open(await signup(base, 'ed1'));
  const b = await open(await signup(base, 'ed2'));
  const posted = waitFor(b, 'message', m => m.text === 'original');
  a.emit('message', { text: 'original', targetRoom: 'general' });
  const m = await posted;

  b.emit('editMessage', { messageId: m._id, newText: 'defaced' });
  await expectNothing(a, 'messageEdited');
  b.emit('deleteMessage', { messageId: m._id });
  await expectNothing(a, 'messageDeleted');

  const edited = waitFor(b, 'messageEdited');
  a.emit('editMessage', { messageId: m._id, newText: 'updated' });
  assert.equal((await edited).newText, 'updated');
  const deleted = waitFor(b, 'messageDeleted');
  a.emit('deleteMessage', { messageId: m._id });
  assert.equal((await deleted).messageId, m._id);
});

test('rooms: persisted, validated, and only the creator can rename or delete', async () => {
  const a = await open(await signup(base, 'rm1'));
  const b = await open(await signup(base, 'rm2'));

  const listed = waitFor(b, 'roomsList', l => l.includes('project x'));
  a.emit('createRoom', 'Project X');
  assert.ok((await listed).includes('project x'));

  const bad = waitFor(a, 'roomError');
  a.emit('createRoom', '<img src=x onerror=1>');
  await bad;

  // post something, then rename: history must follow the room
  const posted = waitFor(a, 'message', m => m.text === 'in project x');
  a.emit('message', { text: 'in project x', targetRoom: 'project x' });
  await posted;

  b.emit('renameRoom', { oldName: 'project x', newName: 'hijacked' });
  b.emit('deleteRoom', 'project x');
  await expectNothing(a, 'roomRenamed');

  const renamed = waitFor(b, 'roomRenamed');
  a.emit('renameRoom', { oldName: 'project x', newName: 'project y' });
  assert.equal((await renamed).newName, 'project y');
  a.emit('joinRoom', 'project y');
  const history = await waitFor(a, 'previousMessages');
  assert.ok(history.some(m => m.text === 'in project x'), 'messages move with the renamed room');

  // built-in rooms are protected
  a.emit('deleteRoom', 'general');
  a.emit('renameRoom', { oldName: 'general', newName: 'lobby' });
  await expectNothing(b, 'roomRenamed');

  const gone = waitFor(b, 'roomDeleted');
  a.emit('deleteRoom', 'project y');
  await gone;

  // rooms survive in the database (a server restart reloads them)
  const { loadRooms, roomNames } = require('../sockets');
  await loadRooms();
  assert.ok(roomNames().includes('general'));
  assert.ok(!roomNames().includes('project y'));
});

test('search: finds old messages across the whole history, respects privacy', async () => {
  const a = await open(await signup(base, 'se1'));
  const b = await open(await signup(base, 'se2'));
  const c = await open(await signup(base, 'se3'));

  // an old message followed by 60 newer ones (more than the 50 the screen loads)
  const Message = require('../models/Message');
  await Message.create({ username: 'se1', text: 'needle in the haystack', room: 'random', createdAt: new Date(Date.now() - 86400e3) });
  await Message.insertMany(Array.from({ length: 60 }, (_, i) => ({ username: 'se1', text: `filler ${i}`, room: 'random' })));
  a.emit('searchMessages', { query: 'needle', room: 'random' });
  const found = await waitFor(a, 'searchResults');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].text, 'needle in the haystack');

  // regex characters are treated as plain text
  a.emit('searchMessages', { query: '.*', room: 'random' });
  assert.equal((await waitFor(a, 'searchResults')).results.length, 0);

  // DM search only sees conversations you are in
  const sent = waitFor(b, 'dmMessage', m => m.text === 'private pineapple');
  a.emit('dmMessage', { toUser: 'se2', text: 'private pineapple' });
  await sent;
  c.emit('searchMessages', { query: 'pineapple', scope: 'all' });
  assert.equal((await waitFor(c, 'searchResults')).results.length, 0);
  c.emit('searchMessages', { query: 'pineapple', dmId: 'se1:se2' });
  await expectNothing(c, 'searchResults');
  b.emit('searchMessages', { query: 'pineapple', scope: 'all' });
  assert.equal((await waitFor(b, 'searchResults')).results.length, 1);
});

test('history paging: older pages and jump-to-message', async () => {
  const Message = require('../models/Message');
  const a = await open(await signup(base, 'pg1'));
  const c = await open(await signup(base, 'pg3'));
  const start = Date.now() - 200 * 60000;
  await Message.insertMany(Array.from({ length: 120 }, (_, i) => ({
    username: 'pg1', text: `page msg ${i}`, room: 'tech', createdAt: new Date(start + i * 60000)
  })));

  a.emit('joinRoom', 'tech');
  const latest = await waitFor(a, 'previousMessages');
  assert.equal(latest.length, 50);
  assert.equal(latest[0].text, 'page msg 70');

  a.emit('loadOlder', { room: 'tech', before: latest[0].createdAt });
  const older = await waitFor(a, 'olderMessages');
  assert.equal(older.messages.length, 50);
  assert.equal(older.messages[0].text, 'page msg 20');
  assert.equal(older.messages[49].text, 'page msg 69');
  assert.equal(older.hasMore, true);

  a.emit('loadOlder', { room: 'tech', before: older.messages[0].createdAt });
  const oldest = await waitFor(a, 'olderMessages');
  assert.equal(oldest.messages.length, 20);
  assert.equal(oldest.hasMore, false);

  const target = oldest.messages[5];
  a.emit('loadAround', { messageId: target._id });
  const around = await waitFor(a, 'messagesAround');
  assert.ok(around.messages.some(m => m._id === target._id));
  assert.ok(around.messages.length >= 25);

  // other people's private conversations stay private
  const dmId = 'pg1:pg2';
  const dm = await Message.create({ username: 'pg1', text: 'dm secret', isDM: true, dmId });
  c.emit('loadAround', { messageId: String(dm._id) });
  await expectNothing(c, 'messagesAround');
  c.emit('loadOlder', { dmId, before: new Date().toISOString() });
  await expectNothing(c, 'olderMessages');
});

test('block and mute', async () => {
  const a = await open(await signup(base, 'bl1'));
  const b = await open(await signup(base, 'bl2'));

  const blocked = waitFor(a, 'userSettings', s => s.blockedUsers.includes('bl2'));
  a.emit('blockUser', { username: 'bl2' });
  await blocked;

  // both directions are refused, but the blocked person is not told they were blocked
  const refusedB = waitFor(b, 'dmBlocked');
  b.emit('dmMessage', { toUser: 'bl1', text: 'hi?' });
  assert.equal((await refusedB).message, 'This message could not be delivered.');
  const refusedA = waitFor(a, 'dmBlocked');
  a.emit('dmMessage', { toUser: 'bl2', text: 'hi?' });
  assert.match((await refusedA).message, /You blocked/);
  await expectNothing(a, 'dmMessage');

  // no calls either
  const failed = waitFor(b, 'callFailed');
  b.emit('callUser', { to: 'bl1', signal: { sdp: 'x' }, callType: 'audio' });
  await failed;

  const unblocked = waitFor(a, 'userSettings', s => s.blockedUsers.length === 0);
  a.emit('unblockUser', { username: 'bl2' });
  await unblocked;
  const delivered = waitFor(a, 'dmMessage', m => m.text === 'friends again');
  b.emit('dmMessage', { toUser: 'bl1', text: 'friends again' });
  await delivered;

  // muting is remembered across sessions
  // one at a time: the test database (FerretDB) can lose two simultaneous updates to one document,
  // which real MongoDB does not
  let step = waitFor(a, 'userSettings', s => s.mutedChats.length === 1);
  a.emit('muteChat', { chat: 'room:random' });
  await step;
  a.emit('muteChat', { chat: 'bad value with spaces' }); // refused, nothing changes
  step = waitFor(a, 'userSettings', s => s.mutedChats.length === 2);
  a.emit('muteChat', { chat: 'dm:bl1:bl2' });
  const muted = await step;
  assert.deepEqual(muted.mutedChats.sort(), ['dm:bl1:bl2', 'room:random']);
  const a2 = await open(await signup(base, 'bl1'));
  a2.emit('join');
  const again = await waitFor(a2, 'userSettings');
  assert.equal(again.mutedChats.length, 2);
});

test('polls and scheduling use the logged-in identity', async () => {
  const a = await open(await signup(base, 'pl1'));
  const b = await open(await signup(base, 'pl2'));

  const made = waitFor(b, 'newPoll');
  a.emit('createPoll', { question: 'Pizza?', options: ['yes', 'no'], room: 'general' });
  const poll = await made;
  assert.equal(poll.createdBy, 'pl1');

  const voted = waitFor(a, 'pollUpdated');
  b.emit('votePoll', { pollId: poll._id, optionIndex: 0, username: 'pl1' }); // forged voter is ignored
  const upd = await voted;
  assert.deepEqual(upd.options[0].votes, ['pl2']);

  a.emit('createPoll', { question: 'x', options: ['only one'], room: 'general' });
  await expectNothing(b, 'newPoll');

  // scheduled message in the past is refused, a future one is stored for its owner only
  const err = waitFor(a, 'scheduleError');
  a.emit('scheduleMessage', { text: 'late', room: 'general', scheduledFor: new Date(Date.now() - 1000).toISOString() });
  await err;
  const created = waitFor(a, 'scheduledMessageCreated');
  a.emit('scheduleMessage', { username: 'pl2', text: 'later', room: 'general', scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal((await created).username, 'pl1');
  b.emit('getScheduledMessages', { username: 'pl1' });
  assert.equal((await waitFor(b, 'scheduledMessages')).length, 0);
});

test('scheduled messages are delivered by the scheduler', async () => {
  const ScheduledMessage = require('../models/ScheduledMessage');
  const a = await open(await signup(base, 'sc1'));
  const b = await open(await signup(base, 'sc2'));
  // put one that is already due straight into the database
  await ScheduledMessage.create({ username: 'sc1', text: 'on time', room: 'general', scheduledFor: new Date(Date.now() - 1000) });
  const got = waitFor(b, 'message', m => m.text === 'on time');
  await app.deliverDueMessages();
  await got;
  assert.equal(await ScheduledMessage.countDocuments({ text: 'on time', sent: true }), 1);
});

test('calls: signalling, hang up on disconnect, no strangers', async () => {
  const a = await open(await signup(base, 'ca1'));
  const b = await open(await signup(base, 'ca2'));
  const c = await open(await signup(base, 'ca3'));

  const offline = waitFor(a, 'callFailed');
  a.emit('callUser', { to: 'nobody_here', signal: { sdp: '1' }, callType: 'video' });
  await offline;

  const ring = waitFor(b, 'incomingCall');
  a.emit('callUser', { to: 'ca2', from: 'ca3', signal: { sdp: '1' }, callType: 'video' }); // forged "from" is ignored
  assert.equal((await ring).from, 'ca1');

  // a stranger cannot inject ICE candidates into someone else's call
  const spy = expectNothing(b, 'iceCandidate');
  c.emit('iceCandidate', { to: 'ca2', candidate: { x: 1 } });
  await spy;
  const ice = waitFor(b, 'iceCandidate');
  a.emit('iceCandidate', { to: 'ca2', candidate: { x: 2 } });
  assert.deepEqual((await ice).candidate, { x: 2 });

  const accepted = waitFor(a, 'callAccepted');
  b.emit('answerCall', { to: 'ca1', signal: { sdp: '2' } });
  await accepted;

  const ended = waitFor(b, 'callEnded');
  a.close(); // caller drops off: the other side must be hung up
  await ended;
  await sleep(200);
  const CallLog = require('../models/CallLog');
  const log = await CallLog.findOne({ caller: 'ca1', callee: 'ca2' });
  assert.equal(log.status, 'answered');
});

test('several tabs: a user stays online until the last tab closes, all tabs get messages', async () => {
  const token = await signup(base, 'mt1');
  const peer = await open(await signup(base, 'mt2'));
  const tab1 = await open(token);
  const tab2 = await open(token);

  const g1 = waitFor(tab1, 'dmMessage', m => m.text === 'to both tabs');
  const g2 = waitFor(tab2, 'dmMessage', m => m.text === 'to both tabs');
  peer.emit('dmMessage', { toUser: 'mt1', text: 'to both tabs' });
  await Promise.all([g1, g2]);

  tab1.close();
  await sleep(300);
  const stillOnline = await new Promise(resolve => {
    peer.once('onlineUsers', resolve);
    tab2.emit('updateStatus', { status: 'away' });
    peer.emit('join');
  });
  assert.ok(stillOnline.includes('mt1'));
});

test('link previews: need a login and never touch internal addresses', async () => {
  let hits = 0;
  const internal = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'text/html'); res.end('<title>SECRET</title>'); });
  await new Promise(r => internal.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${internal.address().port}/`;
  const token = await signup(base, 'lp1');

  assert.equal((await api(base, 'GET', `/api/link-preview?url=${encodeURIComponent(url)}`)).status, 401);
  const res = await api(base, 'GET', `/api/link-preview?url=${encodeURIComponent(url)}`, null, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.title, null);
  assert.equal(hits, 0, 'the server must not have contacted the internal address');

  for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost/', 'http://[::ffff:7f00:1]/']) {
    const r = await api(base, 'GET', `/api/link-preview?url=${encodeURIComponent(bad)}`, null, token);
    assert.equal(r.body.title, null, bad);
  }
  internal.close();
});

test('old DM ids are migrated to the new format', async () => {
  const User = require('../models/User');
  const Message = require('../models/Message');
  const { migrateDmIds } = require('../utils/migrate');
  await signup(base, 'old_a'); await signup(base, 'old_b'); await signup(base, 'older');
  await Message.create({ username: 'old_a', text: 'legacy', isDM: true, dmId: 'old_a_old_b' });
  await Message.create({ username: 'older', text: 'legacy2', isDM: true, dmId: 'old_a_older' });
  assert.ok(await User.exists({ username: 'old_a' }));
  const n = await migrateDmIds();
  assert.ok(n >= 2);
  assert.equal((await Message.findOne({ text: 'legacy' })).dmId, 'old_a:old_b');
  assert.equal((await Message.findOne({ text: 'legacy2' })).dmId, 'old_a:older');
  assert.equal(await migrateDmIds(), 0, 'running it again changes nothing');
});

test('view-once images can be opened exactly once, only by the recipient', async () => {
  const token = await signup(base, 'vo1');
  const a = await open(token);
  const b = await open(await signup(base, 'vo2'));
  const c = await open(await signup(base, 'vo3'));

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'x.png');
  const up = await (await fetch(`${base}/api/upload/image`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })).json();

  const arrived = waitFor(b, 'dmMessage', m => m.viewOnce);
  a.emit('dmMessage', { toUser: 'vo2', text: '', imageUrl: up.imageUrl, viewOnce: true });
  const m = await arrived;
  assert.equal(m.imageUrl, '', 'the image link is hidden until opened');

  c.emit('viewOnceImage', { messageId: m._id });
  await expectNothing(c, 'viewOnceImageData');

  const data = waitFor(b, 'viewOnceImageData');
  b.emit('viewOnceImage', { messageId: m._id });
  assert.match((await data).imageUrl, /^data:image\/png;base64,/);
  b.emit('viewOnceImage', { messageId: m._id });
  await expectNothing(b, 'viewOnceImageData');
});
