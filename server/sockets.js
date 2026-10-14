const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { verifyToken } = require('./middleware/auth');
const Message = require('./models/Message');
const User = require('./models/User');
const Poll = require('./models/Poll');
const ScheduledMessage = require('./models/ScheduledMessage');
const CallLog = require('./models/CallLog');
const Room = require('./models/Room');
const { serializeMessage, escapeRegex, dmIdFor, isDmMember, dmMembers } = require('./utils/messages');
const { DEFAULT_ROOMS } = require('./utils/migrate');

const MAX_TEXT = 4000;
const PAGE_SIZE = 50;
const ROOM_NAME_RE = /^[a-z0-9][a-z0-9 _-]{0,29}$/i;
const STATUSES = ['online', 'away', 'busy', 'invisible'];
const MUTE_KEY_RE = /^(room|dm):[^\s]{1,80}$/;

// ---------------------------------------------------------------------------
// Small validation helpers
// ---------------------------------------------------------------------------
const isStr = (v, max = 200) => typeof v === 'string' && v.length <= max;
const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);
// Only http(s) URLs may be stored — blocks javascript:/data: URLs ending up in href/src.
const safeUrl = (v) => (typeof v === 'string' && v.length <= 500 && /^https?:\/\//i.test(v) ? v : '');

function cleanReplyTo(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    messageId: isStr(r.messageId, 40) ? r.messageId : '',
    username: isStr(r.username, 40) ? r.username : '',
    text: isStr(r.text, 500) ? r.text : '',
    imageUrl: safeUrl(r.imageUrl)
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Rooms live in MongoDB (so they survive restarts); this Map is the in-memory copy.
const rooms = new Map(); // name -> { description, createdBy }

async function loadRooms() {
  rooms.clear();
  const docs = await Room.find({}).sort({ createdAt: 1 }).lean();
  docs.forEach(r => rooms.set(r.name, { description: r.description || '', createdBy: r.createdBy || '' }));
}

const roomNames = () => Array.from(rooms.keys());
const roomDescriptions = () => Object.fromEntries(Array.from(rooms, ([n, r]) => [n, r.description]));
// Who created each room (only the creator may rename, delete or re-describe it)
const roomOwners = () => Object.fromEntries(Array.from(rooms, ([n, r]) => [n, r.createdBy]));
const isBuiltInRoom = (name) => Object.prototype.hasOwnProperty.call(DEFAULT_ROOMS, name);

function setupSockets(io) {
  // username -> number of open connections (a user may have several tabs/devices)
  const onlineCounts = new Map();
  // key (sorted pair) -> { logId, startedAt, users:[a,b] } for calls in progress
  const activeCalls = new Map();

  const userRoom = (username) => `user:${username}`;
  const emitToUser = (username, event, payload) => io.to(userRoom(username)).emit(event, payload);
  // Deliver an event to everyone who can see a message: both people in a DM, or the room.
  const emitToChat = (target, event, payload) => {
    if (target.isDM || target.dmId) {
      const [a, b] = dmMembers(target.dmId);
      io.to(userRoom(a)).to(userRoom(b)).emit(event, payload);
    } else {
      io.to(target.room).emit(event, payload);
    }
  };
  const broadcastRooms = (target = io) => {
    target.emit('roomsList', roomNames());
    target.emit('roomDescriptions', roomDescriptions());
    target.emit('roomOwners', roomOwners());
  };
  const broadcastOnline = () => io.emit('onlineUsers', Array.from(onlineCounts.keys()));

  async function getBlockState(a, b) {
    const users = await User.find({ username: { $in: [a, b] } }, 'username blockedUsers').lean();
    const ua = users.find(u => u.username === a);
    const ub = users.find(u => u.username === b);
    return {
      aBlockedB: !!ua && (ua.blockedUsers || []).includes(b),
      bBlockedA: !!ub && (ub.blockedUsers || []).includes(a)
    };
  }

  async function sendSettings(username) {
    const u = await User.findOne({ username }, 'blockedUsers mutedChats').lean();
    emitToUser(username, 'userSettings', {
      blockedUsers: (u && u.blockedUsers) || [],
      mutedChats: (u && u.mutedChats) || []
    });
  }

  function canAccessMessage(username, m) {
    if (m.isDM) return isDmMember(m.dmId, username);
    return rooms.has(m.room);
  }

  // -------------------------------------------------------------------------
  // Authentication: every socket must present a valid login token.
  // From here on the *only* source of identity is socket.username.
  // -------------------------------------------------------------------------
  io.use(async (socket, next) => {
    const decoded = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!decoded || !decoded.username) return next(new Error('unauthorized'));
    try {
      const exists = await User.exists({ username: decoded.username });
      if (!exists) return next(new Error('unauthorized'));
    } catch {
      return next(new Error('server error'));
    }
    socket.username = decoded.username;
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.username;
    socket.currentRoom = 'general';
    socket.messageTimestamps = [];

    // Wrap every handler so one bad payload or DB hiccup can never crash the server.
    const on = (event, handler, opts = {}) => {
      socket.on(event, async (...args) => {
        try {
          if (opts.limited && !allow(socket)) {
            socket.emit('rateLimitError', { message: 'Sending too fast, slow down.' });
            return;
          }
          await handler(...args);
        } catch (err) {
          console.error(`socket "${event}" failed for ${me}:`, err.message);
        }
      });
    };

    // Join personal channel (all of this user's tabs) and every room.
    socket.join(userRoom(me));
    rooms.forEach((_, name) => socket.join(name));
    onlineCounts.set(me, (onlineCounts.get(me) || 0) + 1);

    // ---- Session start ----------------------------------------------------
    on('join', async () => {
      rooms.forEach((_, name) => socket.join(name));
      socket.currentRoom = rooms.has(socket.currentRoom) ? socket.currentRoom : 'general';
      broadcastOnline();
      broadcastRooms(socket);
      await sendSettings(me);

      const profile = await User.findOne({ username: me }, 'status').lean();
      if (profile) io.emit('userStatus', { username: me, status: profile.status });

      const messages = await Message.find({ room: 'general', isDM: false }).sort({ createdAt: -1 }).limit(50);
      socket.emit('previousMessages', messages.reverse().map(m => serializeMessage(m, me)));
    });

    // ---- Rooms ------------------------------------------------------------
    on('joinRoom', async (room) => {
      if (!isStr(room, 40) || !rooms.has(room)) return;
      socket.join(room);
      socket.currentRoom = room;
      const messages = await Message.find({ room, isDM: false }).sort({ createdAt: -1 }).limit(50);

      const ids = messages.map(m => m._id);
      Message.updateMany({ _id: { $in: ids }, readBy: { $ne: me } }, { $addToSet: { readBy: me } })
        .then(() => io.to(room).emit('roomMessagesRead', { reader: me, room }))
        .catch(() => {});

      socket.emit('previousMessages', messages.reverse().map(m => {
        const out = serializeMessage(m, me);
        out.readBy = Array.from(new Set([...out.readBy, me]));
        return out;
      }));
    });

    on('createRoom', async (roomName) => {
      const name = isStr(roomName, 60) ? roomName.trim().toLowerCase() : '';
      if (!ROOM_NAME_RE.test(name)) {
        socket.emit('roomError', { message: 'Room names use letters, numbers, spaces, - and _ (max 30).' });
        return;
      }
      if (rooms.has(name)) {
        socket.emit('roomError', { message: 'That room already exists.' });
        return;
      }
      await Room.create({ name, description: '', createdBy: me });
      rooms.set(name, { description: '', createdBy: me });
      io.socketsJoin(name);
      broadcastRooms();
    }, { limited: true });

    on('deleteRoom', async (room) => {
      const meta = isStr(room, 40) && rooms.get(room);
      if (!meta || isBuiltInRoom(room) || meta.createdBy !== me) return;
      await Room.deleteOne({ name: room });
      await Message.deleteMany({ room, isDM: false });
      await Poll.deleteMany({ room });
      rooms.delete(room);
      io.to(room).emit('roomDeleted', { room });
      io.in(room).socketsLeave(room);
      broadcastRooms();
    });

    on('renameRoom', async ({ oldName, newName } = {}) => {
      const meta = isStr(oldName, 40) && rooms.get(oldName);
      const next = isStr(newName, 60) ? newName.trim().toLowerCase() : '';
      if (!meta || isBuiltInRoom(oldName) || meta.createdBy !== me) return;
      if (!ROOM_NAME_RE.test(next) || rooms.has(next)) {
        socket.emit('roomError', { message: 'Invalid or already used room name.' });
        return;
      }
      await Room.updateOne({ name: oldName }, { $set: { name: next } });
      await Message.updateMany({ room: oldName, isDM: false }, { $set: { room: next } });
      await Poll.updateMany({ room: oldName }, { $set: { room: next } });
      rooms.delete(oldName);
      rooms.set(next, meta);
      io.in(oldName).socketsJoin(next);
      io.in(oldName).socketsLeave(oldName);
      broadcastRooms();
      io.emit('roomRenamed', { oldName, newName: next });
    });

    on('setRoomDescription', async ({ room, description } = {}) => {
      const meta = isStr(room, 40) && rooms.get(room);
      if (!meta || isBuiltInRoom(room) || meta.createdBy !== me || !isStr(description, 200)) return;
      meta.description = description.trim();
      await Room.updateOne({ name: room }, { $set: { description: meta.description } });
      io.emit('roomDescriptionUpdated', { room, description: meta.description });
    });

    // ---- Presence & typing --------------------------------------------------
    on('updateStatus', async ({ status } = {}) => {
      if (!STATUSES.includes(status)) return;
      await User.updateOne({ username: me }, { $set: { status } });
      io.emit('userStatus', { username: me, status });
    });

    on('typing', () => {
      socket.broadcast.to(socket.currentRoom).emit('typing', me);
    });
    on('stopTyping', () => {
      socket.broadcast.to(socket.currentRoom).emit('stopTyping');
    });
    on('dmTyping', ({ dmId } = {}) => {
      if (!isStr(dmId, 100) || !isDmMember(dmId, me)) return;
      const other = dmMembers(dmId).find(u => u !== me);
      if (other) emitToUser(other, 'dmTyping', { fromUser: me, dmId });
    });
    on('dmStopTyping', ({ dmId } = {}) => {
      if (!isStr(dmId, 100) || !isDmMember(dmId, me)) return;
      const other = dmMembers(dmId).find(u => u !== me);
      if (other) emitToUser(other, 'dmStopTyping', { dmId });
    });

    // ---- Room messages --------------------------------------------------------
    on('message', async (msg = {}) => {
      const targetRoom = isStr(msg.targetRoom, 40) && msg.targetRoom ? msg.targetRoom : socket.currentRoom;
      if (!rooms.has(targetRoom)) return;
      const text = isStr(msg.text, MAX_TEXT) ? msg.text : '';
      const imageUrl = safeUrl(msg.imageUrl);
      const fileUrl = safeUrl(msg.fileUrl);
      const stickerUrl = safeUrl(msg.stickerUrl);
      if (!text.trim() && !imageUrl && !fileUrl && !stickerUrl) return;

      const mentions = await extractMentions(text);
      const doc = await Message.create({
        username: me,
        text,
        imageUrl,
        fileUrl,
        fileName: isStr(msg.fileName, 200) ? msg.fileName : '',
        fileSize: Number.isFinite(msg.fileSize) ? msg.fileSize : 0,
        fileType: isStr(msg.fileType, 100) ? msg.fileType : '',
        duration: Number.isFinite(msg.duration) ? Math.min(msg.duration, 3600) : 0,
        stickerUrl,
        forwardedFrom: isStr(msg.forwardedFrom, 40) ? msg.forwardedFrom : '',
        room: targetRoom,
        replyTo: cleanReplyTo(msg.replyTo),
        viewOnce: !!msg.viewOnce && !!imageUrl,
        mentions,
        readBy: [me]
      });
      io.to(targetRoom).emit('message', serializeMessage(doc, null));

      // Tell mentioned users (unless they've blocked the sender)
      if (mentions.length) {
        const mentioned = await User.find({ username: { $in: mentions } }, 'username blockedUsers').lean();
        mentioned.forEach(u => {
          if (u.username === me || (u.blockedUsers || []).includes(me)) return;
          emitToUser(u.username, 'mentioned', { from: me, room: targetRoom, text });
        });
      }
    }, { limited: true });

    on('reaction', async ({ messageId, emoji } = {}) => {
      if (!isId(messageId) || !isStr(emoji, 16) || !emoji) return;
      const m = await Message.findById(messageId);
      if (!m || !canAccessMessage(me, m)) return;
      const reactions = m.reactions || new Map();
      const users = reactions.get(emoji) || [];
      reactions.set(emoji, users.includes(me) ? users.filter(u => u !== me) : [...users, me]);
      m.reactions = reactions;
      await m.save();
      emitToChat(m, 'reactionUpdate', { messageId, reactions: Object.fromEntries(m.reactions) });
    });

    // ---- Direct messages --------------------------------------------------------
    on('openDM', async ({ toUser } = {}) => {
      if (!isStr(toUser, 40) || toUser === me) return;
      if (!(await User.exists({ username: toUser }))) return;
      const dmId = dmIdFor(me, toUser);
      const messages = await Message.find({ isDM: true, dmId }).sort({ createdAt: -1 }).limit(50);
      socket.emit('dmMessages', { dmId, messages: messages.reverse().map(m => serializeMessage(m, me)) });
    });

    on('dmMessage', async (data = {}) => {
      const toUser = data.toUser;
      if (!isStr(toUser, 40) || toUser === me) return;
      if (!(await User.exists({ username: toUser }))) return;

      const { aBlockedB, bBlockedA } = await getBlockState(me, toUser);
      if (aBlockedB || bBlockedA) {
        socket.emit('dmBlocked', {
          toUser,
          message: aBlockedB
            ? 'You blocked this user. Unblock them to send messages.'
            : 'This message could not be delivered.'
        });
        return;
      }

      const text = isStr(data.text, MAX_TEXT) ? data.text : '';
      const imageUrl = safeUrl(data.imageUrl);
      const fileUrl = safeUrl(data.fileUrl);
      const stickerUrl = safeUrl(data.stickerUrl);
      if (!text.trim() && !imageUrl && !fileUrl && !stickerUrl) return;

      const dmId = dmIdFor(me, toUser);
      const mentions = await extractMentions(text);
      const doc = await Message.create({
        username: me,
        text,
        imageUrl,
        fileUrl,
        fileName: isStr(data.fileName, 200) ? data.fileName : '',
        fileSize: Number.isFinite(data.fileSize) ? data.fileSize : 0,
        fileType: isStr(data.fileType, 100) ? data.fileType : '',
        duration: Number.isFinite(data.duration) ? Math.min(data.duration, 3600) : 0,
        stickerUrl,
        forwardedFrom: isStr(data.forwardedFrom, 40) ? data.forwardedFrom : '',
        isDM: true,
        dmId,
        replyTo: cleanReplyTo(data.replyTo),
        viewOnce: !!data.viewOnce && !!imageUrl,
        mentions
      });
      // Deliver to every open tab of both people
      emitToChat(doc, 'dmMessage', serializeMessage(doc, null));
    }, { limited: true });

    on('markDMRead', async ({ dmId } = {}) => {
      if (!isStr(dmId, 100) || !isDmMember(dmId, me)) return;
      await Message.updateMany(
        { isDM: true, dmId, username: { $ne: me }, readBy: { $ne: me } },
        { $addToSet: { readBy: me } }
      );
      emitToChat({ isDM: true, dmId }, 'dmRead', { dmId, reader: me });
    });

    on('markRoomRead', async ({ room } = {}) => {
      if (!isStr(room, 40) || !rooms.has(room)) return;
      const recent = await Message.find({ room, isDM: false }).sort({ createdAt: -1 }).limit(50).select('_id');
      await Message.updateMany(
        { _id: { $in: recent.map(m => m._id) }, readBy: { $ne: me } },
        { $addToSet: { readBy: me } }
      );
      io.to(room).emit('roomMessagesRead', { reader: me, room });
    });

    // ---- Editing, pinning, starring ----------------------------------------------
    on('editMessage', async ({ messageId, newText } = {}) => {
      if (!isId(messageId) || !isStr(newText, MAX_TEXT) || !newText.trim()) return;
      const m = await Message.findById(messageId);
      if (!m || m.username !== me) return;
      m.text = newText;
      m.edited = true;
      await m.save();
      emitToChat(m, 'messageEdited', { messageId, newText, edited: true });
    });

    on('deleteMessage', async ({ messageId } = {}) => {
      if (!isId(messageId)) return;
      const m = await Message.findById(messageId);
      if (!m || m.username !== me) return;
      await Message.deleteOne({ _id: messageId });
      emitToChat(m, 'messageDeleted', { messageId });
    });

    on('pinMessage', async ({ messageId } = {}) => {
      if (!isId(messageId)) return;
      const m = await Message.findById(messageId);
      if (!m || !canAccessMessage(me, m)) return;
      m.pinned = true;
      await m.save();
      emitToChat(m, 'messagePinned', {
        messageId,
        username: m.username,
        text: m.text,
        imageUrl: m.imageUrl,
        room: m.isDM ? m.dmId : m.room
      });
    });

    on('unpinMessage', async ({ messageId } = {}) => {
      if (!isId(messageId)) return;
      const m = await Message.findById(messageId);
      if (!m || !canAccessMessage(me, m)) return;
      m.pinned = false;
      await m.save();
      emitToChat(m, 'messageUnpinned', { messageId, room: m.isDM ? m.dmId : m.room });
    });

    on('toggleStar', async ({ messageId } = {}) => {
      if (!isId(messageId)) return;
      const m = await Message.findById(messageId);
      if (!m || !canAccessMessage(me, m)) return;
      const idx = (m.starredBy || []).indexOf(me);
      if (idx === -1) m.starredBy.push(me); else m.starredBy.splice(idx, 1);
      await m.save();
      socket.emit('starUpdated', { messageId, starred: m.starredBy.includes(me) });
    });

    on('getStarredMessages', async () => {
      const msgs = await Message.find({ starredBy: me }).sort({ createdAt: -1 }).limit(100);
      socket.emit('starredMessages', msgs.map(m => serializeMessage(m, me)));
    });

    on('getLastMessages', async (dmIds) => {
      if (!Array.isArray(dmIds) || dmIds.length === 0) return;
      const results = {};
      const mine = dmIds.slice(0, 300).filter(id => isStr(id, 100) && isDmMember(id, me));
      await Promise.all(mine.map(async (dmId) => {
        const m = await Message.findOne({ isDM: true, dmId }).sort({ createdAt: -1 });
        if (m) {
          const s = serializeMessage(m, me);
          results[dmId] = {
            username: s.username, text: s.text, imageUrl: s.imageUrl, fileUrl: s.fileUrl,
            fileType: s.fileType, stickerUrl: s.stickerUrl, viewOnce: s.viewOnce, createdAt: s.createdAt
          };
        }
      }));
      socket.emit('lastMessages', results);
    });

    // ---- History paging -----------------------------------------------------------
    // The screen starts with the latest 50 messages; these let the client go further back.
    const chatFilter = (room, dmId) => {
      if (dmId) return isStr(dmId, 100) && isDmMember(dmId, me) ? { isDM: true, dmId } : null;
      return isStr(room, 40) && rooms.has(room) ? { isDM: false, room } : null;
    };

    on('loadOlder', async ({ room, dmId, before } = {}) => {
      const filter = chatFilter(room, dmId);
      const cutoff = new Date(before);
      if (!filter || isNaN(cutoff)) return;
      const found = await Message.find({ ...filter, createdAt: { $lt: cutoff } }).sort({ createdAt: -1 }).limit(PAGE_SIZE + 1);
      socket.emit('olderMessages', {
        room: dmId ? '' : room,
        dmId: dmId || '',
        hasMore: found.length > PAGE_SIZE,
        messages: found.slice(0, PAGE_SIZE).reverse().map(m => serializeMessage(m, me))
      });
    });

    // Used by search: open the conversation around an old message
    on('loadAround', async ({ messageId } = {}) => {
      if (!isId(messageId)) return;
      const target = await Message.findById(messageId);
      if (!target || !canAccessMessage(me, target)) return;
      const filter = target.isDM ? { isDM: true, dmId: target.dmId } : { isDM: false, room: target.room };
      const older = await Message.find({ ...filter, createdAt: { $lte: target.createdAt } }).sort({ createdAt: -1 }).limit(26);
      const newer = await Message.find({ ...filter, createdAt: { $gt: target.createdAt } }).sort({ createdAt: 1 }).limit(25);
      socket.emit('messagesAround', {
        room: target.isDM ? '' : target.room,
        dmId: target.isDM ? target.dmId : '',
        targetId: messageId,
        messages: [...older.reverse(), ...newer].map(m => serializeMessage(m, me))
      });
    });

    on('viewOnceImage', async ({ messageId } = {}) => {
      if (!isId(messageId)) return;
      const m = await Message.findById(messageId);
      if (!m || !m.viewOnce || m.username === me || !canAccessMessage(me, m)) return;

      // Atomically flip the flag so two tabs can never both view it
      const consumed = await Message.findOneAndUpdate(
        { _id: messageId, viewOnce: true, viewOnceExpired: false },
        { $set: { viewOnceExpired: true, imageUrl: '' } },
        { returnDocument: 'before' }
      );
      if (!consumed) return;

      let imageData = consumed.imageUrl;
      let filePath = null;
      if (consumed.imageUrl) {
        const filename = path.basename(consumed.imageUrl);
        filePath = path.join(__dirname, 'uploads', filename);
        try {
          const ext = path.extname(filename).slice(1).toLowerCase();
          const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
          const buffer = await fs.promises.readFile(filePath);
          imageData = `data:${mime};base64,${buffer.toString('base64')}`;
        } catch (err) {
          console.log('view-once read error (falling back to URL):', err.message);
        }
      }
      socket.emit('viewOnceImageData', { messageId, imageUrl: imageData });
      if (filePath) fs.unlink(filePath, () => {});
      emitToChat(m, 'viewOnceExpired', { messageId });
    });

    // ---- Polls --------------------------------------------------------------------
    const pollTargetOk = (room, dmId) => (dmId ? isStr(dmId, 100) && isDmMember(dmId, me) : isStr(room, 40) && rooms.has(room));

    on('createPoll', async ({ question, options, room, dmId } = {}) => {
      if (!isStr(question, 200) || !question.trim()) return;
      if (!Array.isArray(options) || options.length < 2 || options.length > 10) return;
      if (!options.every(o => isStr(o, 100) && o.trim())) return;
      if (!pollTargetOk(room, dmId)) return;
      const poll = await Poll.create({
        question: question.trim(),
        options: options.map(text => ({ text: text.trim(), votes: [] })),
        room: dmId ? '' : room,
        dmId: dmId || '',
        createdBy: me
      });
      emitToChat({ dmId: poll.dmId, room: poll.room }, 'newPoll', poll.toObject());
    }, { limited: true });

    on('votePoll', async ({ pollId, optionIndex } = {}) => {
      if (!isId(pollId) || !Number.isInteger(optionIndex)) return;
      const poll = await Poll.findById(pollId);
      if (!poll || !pollTargetOk(poll.room, poll.dmId)) return;
      const opt = poll.options[optionIndex];
      if (!opt) return;
      const already = opt.votes.includes(me);
      poll.options.forEach(o => { o.votes = o.votes.filter(u => u !== me); }); // one vote per person
      if (!already) poll.options[optionIndex].votes.push(me);                 // same option again = unvote
      await poll.save();
      emitToChat({ dmId: poll.dmId, room: poll.room }, 'pollUpdated', poll.toObject());
    });

    on('getPolls', async ({ room, dmId } = {}) => {
      if (!pollTargetOk(room, dmId)) return;
      const polls = await Poll.find(dmId ? { dmId } : { room }).sort({ createdAt: 1 });
      socket.emit('pollsList', polls.map(p => p.toObject()));
    });

    // ---- Scheduled messages --------------------------------------------------------
    on('scheduleMessage', async ({ text, room, dmId, toUser, scheduledFor } = {}) => {
      if (!isStr(text, MAX_TEXT) || !text.trim() || !scheduledFor) return;
      const sendAt = new Date(scheduledFor);
      if (isNaN(sendAt) || sendAt <= new Date()) {
        socket.emit('scheduleError', { message: 'Scheduled time must be in the future.' });
        return;
      }
      if (sendAt - Date.now() > 366 * 24 * 3600 * 1000) {
        socket.emit('scheduleError', { message: 'Pick a time within the next year.' });
        return;
      }
      let targetDm = '';
      let targetRoom = '';
      if (dmId || toUser) {
        const other = isStr(toUser, 40) && toUser ? toUser : dmMembers(dmId).find(u => u !== me);
        if (!other || other === me || !(await User.exists({ username: other }))) return;
        targetDm = dmIdFor(me, other);
      } else {
        if (!isStr(room, 40) || !rooms.has(room)) return;
        targetRoom = room;
      }
      const sm = await ScheduledMessage.create({
        username: me, text, room: targetRoom, dmId: targetDm,
        toUser: targetDm ? dmMembers(targetDm).find(u => u !== me) : '', scheduledFor: sendAt
      });
      socket.emit('scheduledMessageCreated', sm.toObject());
    }, { limited: true });

    on('getScheduledMessages', async () => {
      const msgs = await ScheduledMessage.find({ username: me, sent: false }).sort({ scheduledFor: 1 });
      socket.emit('scheduledMessages', msgs.map(m => m.toObject()));
    });

    on('cancelScheduledMessage', async ({ scheduledMessageId } = {}) => {
      if (!isId(scheduledMessageId)) return;
      const sm = await ScheduledMessage.findById(scheduledMessageId);
      if (!sm || sm.username !== me) return;
      await ScheduledMessage.deleteOne({ _id: scheduledMessageId });
      socket.emit('scheduledMessageCancelled', { scheduledMessageId });
    });

    // ---- Search (full history, not just what is loaded on screen) ----------------------
    on('searchMessages', async ({ query, room, dmId, scope } = {}) => {
      const q = isStr(query, 100) ? query.trim() : '';
      if (q.length < 2) {
        socket.emit('searchResults', { query: q, results: [] });
        return;
      }
      const textMatch = { $regex: escapeRegex(q), $options: 'i' };
      let filter;
      if (scope === 'all') {
        const mineRe = new RegExp(`(^${escapeRegex(me)}:|:${escapeRegex(me)}$)`);
        filter = { $or: [
          { isDM: false, room: { $in: roomNames() } },
          { isDM: true, dmId: { $regex: mineRe } }
        ] };
      } else if (dmId) {
        if (!isStr(dmId, 100) || !isDmMember(dmId, me)) return;
        filter = { isDM: true, dmId };
      } else {
        const r = isStr(room, 40) && rooms.has(room) ? room : socket.currentRoom;
        filter = { isDM: false, room: r };
      }
      const found = await Message.find({ ...filter, text: textMatch, viewOnce: { $ne: true } })
        .sort({ createdAt: -1 })
        .limit(50);
      const blocked = await User.findOne({ username: me }, 'blockedUsers').lean();
      const hidden = new Set((blocked && blocked.blockedUsers) || []);
      socket.emit('searchResults', {
        query: q,
        results: found.filter(m => !hidden.has(m.username)).map(m => serializeMessage(m, me))
      });
    }, { limited: true });

    // ---- Block & mute -------------------------------------------------------------
    on('blockUser', async ({ username } = {}) => {
      if (!isStr(username, 40) || username === me) return;
      if (!(await User.exists({ username }))) return;
      await User.updateOne({ username: me }, { $addToSet: { blockedUsers: username } });
      await sendSettings(me);
    });
    on('unblockUser', async ({ username } = {}) => {
      if (!isStr(username, 40)) return;
      await User.updateOne({ username: me }, { $pull: { blockedUsers: username } });
      await sendSettings(me);
    });
    on('muteChat', async ({ chat } = {}) => {
      if (!isStr(chat, 90) || !MUTE_KEY_RE.test(chat)) return;
      await User.updateOne({ username: me }, { $addToSet: { mutedChats: chat } });
      await sendSettings(me);
    });
    on('unmuteChat', async ({ chat } = {}) => {
      if (!isStr(chat, 90)) return;
      await User.updateOne({ username: me }, { $pull: { mutedChats: chat } });
      await sendSettings(me);
    });

    // ---- WebRTC signaling ------------------------------------------------------------
    const callKey = (a, b) => [a, b].sort().join('|');

    on('callUser', async ({ to, signal, callType } = {}) => {
      if (!isStr(to, 40) || to === me || !['audio', 'video'].includes(callType) || !signal) return;
      if (!onlineCounts.get(to)) {
        socket.emit('callFailed', { message: `${to} is not online.` });
        return;
      }
      const { aBlockedB, bBlockedA } = await getBlockState(me, to);
      if (aBlockedB || bBlockedA) {
        socket.emit('callFailed', { message: aBlockedB ? 'You blocked this user.' : `${to} is not available.` });
        return;
      }
      const key = callKey(me, to);
      // Register first so ICE candidates that arrive immediately are not dropped
      const entry = { logId: null, startedAt: null, users: [me, to] };
      activeCalls.set(key, entry);
      try {
        const log = await CallLog.create({ caller: me, callee: to, callType, status: 'missed', duration: 0 });
        entry.logId = log._id;
      } catch (err) {
        console.error('call log create failed:', err.message);
      }
      emitToUser(to, 'incomingCall', { from: me, signal, callType });
    });

    on('answerCall', async ({ to, signal } = {}) => {
      const entry = isStr(to, 40) && activeCalls.get(callKey(me, to));
      if (!entry) return;
      emitToUser(to, 'callAccepted', { signal });
      entry.startedAt = new Date();
      if (entry.logId) await CallLog.findByIdAndUpdate(entry.logId, { status: 'answered' }).catch(() => {});
    });

    on('rejectCall', async ({ to } = {}) => {
      const key = isStr(to, 40) ? callKey(me, to) : null;
      const entry = key && activeCalls.get(key);
      if (!entry) return;
      emitToUser(to, 'callRejected');
      if (entry.logId) await CallLog.findByIdAndUpdate(entry.logId, { status: 'declined' }).catch(() => {});
      activeCalls.delete(key);
    });

    on('endCall', async ({ to } = {}) => {
      const key = isStr(to, 40) ? callKey(me, to) : null;
      if (!key) return;
      const entry = activeCalls.get(key);
      emitToUser(to, 'callEnded');
      if (entry) await finishCall(key, entry);
    });

    async function finishCall(key, entry) {
      if (entry.startedAt && entry.logId) {
        const duration = Math.round((Date.now() - entry.startedAt.getTime()) / 1000);
        await CallLog.findByIdAndUpdate(entry.logId, { duration }).catch(() => {});
      }
      activeCalls.delete(key);
    }

    on('iceCandidate', ({ to, candidate } = {}) => {
      if (!isStr(to, 40) || !activeCalls.has(callKey(me, to))) return;
      emitToUser(to, 'iceCandidate', { candidate });
    });

    on('getCallLogs', async () => {
      const logs = await CallLog.find({
        $or: [{ caller: me }, { callee: me }],
        hiddenFor: { $ne: me }
      }).sort({ createdAt: -1 }).limit(100);
      socket.emit('callLogs', logs);
    });

    on('deleteCallLog', async ({ logId } = {}) => {
      if (!isId(logId)) return;
      const log = await CallLog.findById(logId);
      if (!log || (log.caller !== me && log.callee !== me)) return;
      await CallLog.findByIdAndUpdate(logId, { $addToSet: { hiddenFor: me } });
      socket.emit('callLogDeleted', { logId });
    });

    on('deleteAllCallLogs', async () => {
      await CallLog.updateMany(
        { $or: [{ caller: me }, { callee: me }] },
        { $addToSet: { hiddenFor: me } }
      );
      socket.emit('callLogsCleared');
    });

    // ---- Disconnect ---------------------------------------------------------------
    socket.on('disconnect', async () => {
      const left = (onlineCounts.get(me) || 1) - 1;
      if (left > 0) {
        onlineCounts.set(me, left);
        return;
      }
      onlineCounts.delete(me);
      broadcastOnline();
      // Hang up any call this user was in so the other side is not left ringing
      for (const [key, entry] of activeCalls) {
        if (entry.users.includes(me)) {
          const peer = entry.users.find(u => u !== me);
          emitToUser(peer, 'callEnded');
          await finishCall(key, entry);
        }
      }
      User.updateOne({ username: me }, { $set: { lastSeen: new Date() } }).catch(err => console.error(err.message));
    });
  });

  // -------------------------------------------------------------------------
  // Scheduled-message delivery (runs every minute)
  // -------------------------------------------------------------------------
  async function deliverDue() {
    try {
      const due = await ScheduledMessage.find({ sent: false, scheduledFor: { $lte: new Date() } });
      for (const sm of due) {
        // Claim it first so a slow run can never deliver the same message twice
        const claimed = await ScheduledMessage.findOneAndUpdate({ _id: sm._id, sent: false }, { $set: { sent: true } });
        if (!claimed) continue;
        if (sm.dmId) {
          const other = dmMembers(sm.dmId).find(u => u !== sm.username);
          const { aBlockedB, bBlockedA } = await getBlockState(sm.username, other);
          if (aBlockedB || bBlockedA) continue;
        } else if (!rooms.has(sm.room)) {
          continue;
        }
        const doc = await Message.create({
          username: sm.username,
          text: sm.text,
          room: sm.dmId ? '' : sm.room,
          isDM: !!sm.dmId,
          dmId: sm.dmId || '',
          readBy: sm.dmId ? [] : [sm.username]
        });
        emitToChat(doc, doc.isDM ? 'dmMessage' : 'message', serializeMessage(doc, null));
      }
    } catch (err) {
      console.error('Scheduled message cron error:', err.message);
    }
  }

  const startScheduler = () => cron.schedule('* * * * *', deliverDue);

  return { startScheduler, deliverDue };
}

async function extractMentions(text) {
  if (!text) return [];
  const words = [...text.matchAll(/@(\w+)/g)].map(m => m[1]).slice(0, 20);
  if (words.length === 0) return [];
  const found = await User.find({ username: { $in: words } }, 'username');
  return found.map(u => u.username);
}

// Sliding window: at most 20 sends per 10 seconds per connection
function allow(socket) {
  const now = Date.now();
  socket.messageTimestamps = socket.messageTimestamps.filter(t => now - t < 10000);
  if (socket.messageTimestamps.length >= 20) return false;
  socket.messageTimestamps.push(now);
  return true;
}

module.exports = { setupSockets, loadRooms, roomNames };
