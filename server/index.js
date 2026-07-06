const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { sanitize: mongoSanitize } = require('express-mongo-sanitize');
const Message = require('./models/Message');
const User = require('./models/User');
const Poll = require('./models/Poll');
const ScheduledMessage = require('./models/ScheduledMessage');
const CallLog = require('./models/CallLog');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
// Railway sits behind a reverse proxy — trust its X-Forwarded-* headers so
// req.protocol reports "https" instead of "http" for generated URLs.
app.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, mobile apps in dev)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  allowEIO3: false,
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6
});

// CORS must come before Helmet so preflight OPTIONS responses are never
// intercepted by security-header middleware before CORS headers are written.
app.use(cors(corsOptions));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "http://localhost:5000", "https://ichat-production-e7e3.up.railway.app"],
      connectSrc: ["'self'", "http://localhost:5000", "ws://localhost:5000", "https://ichat-production-e7e3.up.railway.app", "wss://ichat-production-e7e3.up.railway.app"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  // Allow cross-origin loads of static files (images, stickers, audio) by the React client
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(express.json());
// Sanitize req.body only — Express 5's req.query is a read-only getter and
// cannot be reassigned, so middleware packages that do req.query = ... crash.
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize(req.body);
  next();
});

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later.' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later.' }
});

// MongoDB: fail fast on startup, log but don't crash on runtime drops
mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log('Connected to MongoDB!');
    // Run scheduled message delivery every minute
    cron.schedule('* * * * *', async () => {
      try {
        const due = await ScheduledMessage.find({ sent: false, scheduledFor: { $lte: new Date() } });
        for (const sm of due) {
          const newMsg = new Message({
            username: sm.username,
            text: sm.text,
            room: sm.room || 'general',
            isDM: !!sm.dmId,
            dmId: sm.dmId || '',
            readBy: [sm.username]
          });
          await newMsg.save();
          const payload = {
            _id: newMsg._id,
            username: sm.username,
            text: sm.text,
            imageUrl: '',
            fileUrl: '',
            fileName: '',
            fileSize: 0,
            fileType: '',
            duration: 0,
            stickerUrl: '',
            reactions: {},
            replyTo: null,
            createdAt: newMsg.createdAt,
            room: sm.room || '',
            dmId: sm.dmId || '',
            readBy: newMsg.readBy,
            starredBy: [],
            mentions: [],
            viewOnce: false,
            viewOnceExpired: false
          };
          if (sm.dmId) {
            io.to(sm.dmId).emit('dmMessage', payload);
          } else {
            io.to(sm.room).emit('message', payload);
          }
          sm.sent = true;
          await sm.save();
        }
      } catch (err) {
        console.error('Scheduled message cron error:', err);
      }
    });
  })
  .catch(err => console.log('MongoDB error:', err));
mongoose.connection.on('error', err => console.error('MongoDB connection error:', err));

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/upload');
const profileRoutes = require('./routes/profile');
const linkPreviewRoutes = require('./routes/linkPreview');
const stickerRoutes = require('./routes/stickers');

// General API limiter covers all /api/ routes; specific limiters add stricter caps
app.use('/api/', apiLimiter);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/upload', uploadLimiter, uploadRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/link-preview', linkPreviewRoutes);
app.use('/api/stickers', stickerRoutes);
app.use('/uploads', express.static('uploads'));

app.get('/', (req, res) => {
  res.send('Chat server is running!');
});

const onlineUsers = new Set();
const rooms = new Set(['general', 'random', 'tech']);
const roomDescriptions = {
  general: 'General chat for everyone',
  random: 'Random off-topic conversations',
  tech: 'Tech talk and discussions'
};
const userSockets = new Map();
// Tracks the in-progress CallLog document for each active call, keyed by the
// sorted pair of usernames — lets answerCall/rejectCall/endCall update the
// same log entry created when the call was initiated.
const activeCallLogs = new Map();

async function extractMentions(text) {
  if (!text) return [];
  const words = [...text.matchAll(/@(\w+)/g)].map(m => m[1]);
  if (words.length === 0) return [];
  const found = await User.find({ username: { $in: words } }, 'username');
  return found.map(u => u.username);
}

// Sliding-window rate limiter for socket message events (per socket, in-memory)
function checkSocketRateLimit(socket) {
  const now = Date.now();
  const windowMs = 10000;
  const max = 20;
  if (!socket.messageTimestamps) socket.messageTimestamps = [];
  socket.messageTimestamps = socket.messageTimestamps.filter(t => now - t < windowMs);
  if (socket.messageTimestamps.length >= max) return false;
  socket.messageTimestamps.push(now);
  return true;
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join', async (username) => {
    socket.username = username;
    onlineUsers.add(username);
    userSockets.set(username, socket);
    io.emit('onlineUsers', Array.from(onlineUsers));
    io.emit('roomsList', Array.from(rooms));
    socket.emit('roomDescriptions', roomDescriptions);
    rooms.forEach(room => socket.join(room));
    socket.currentRoom = 'general';

    const userProfile = await User.findOne({ username });
    if (userProfile) {
      io.emit('userStatus', { username, status: userProfile.status });
    }

    const messages = await Message.find({ room: 'general' })
      .sort({ createdAt: -1 })
      .limit(50);
    socket.emit('previousMessages', messages.reverse().map(m => ({
      _id: m._id,
      username: m.username,
      text: m.text,
      imageUrl: m.viewOnce ? '' : (m.imageUrl || ''),
      fileUrl: m.fileUrl,
      fileName: m.fileName,
      fileSize: m.fileSize,
      fileType: m.fileType,
      duration: m.duration || 0,
      stickerUrl: m.stickerUrl || '',
      reactions: Object.fromEntries(m.reactions || new Map()),
      replyTo: m.replyTo || null,
      createdAt: m.createdAt,
      edited: m.edited,
      pinned: m.pinned,
      starredBy: (m.starredBy || []).includes(socket.username) ? [socket.username] : [],
      mentions: m.mentions || [],
      viewOnce: m.viewOnce || false,
      viewOnceExpired: m.viewOnceExpired || false,
      readBy: m.readBy || []
    })));
  });

  socket.on('joinRoom', async (room) => {
    if (!socket.rooms.has(room)) socket.join(room);
    socket.currentRoom = room;
    const messages = await Message.find({ room })
      .sort({ createdAt: -1 })
      .limit(50);

    // Mark loaded messages as read by this user (fire-and-forget)
    if (socket.username) {
      const ids = messages.map(m => m._id);
      Message.updateMany(
        { _id: { $in: ids }, readBy: { $ne: socket.username } },
        { $push: { readBy: socket.username } }
      ).then(() => {
        io.to(room).emit('roomMessagesRead', { reader: socket.username, room });
      }).catch(() => {});
    }

    socket.emit('previousMessages', messages.reverse().map(m => ({
      _id: m._id,
      username: m.username,
      text: m.text,
      imageUrl: m.viewOnce ? '' : (m.imageUrl || ''),
      fileUrl: m.fileUrl,
      fileName: m.fileName,
      fileSize: m.fileSize,
      fileType: m.fileType,
      duration: m.duration || 0,
      stickerUrl: m.stickerUrl || '',
      reactions: Object.fromEntries(m.reactions || new Map()),
      replyTo: m.replyTo || null,
      createdAt: m.createdAt,
      edited: m.edited,
      pinned: m.pinned,
      starredBy: (m.starredBy || []).includes(socket.username) ? [socket.username] : [],
      mentions: m.mentions || [],
      viewOnce: m.viewOnce || false,
      viewOnceExpired: m.viewOnceExpired || false,
      readBy: Array.from(new Set([...(m.readBy || []), ...(socket.username ? [socket.username] : [])]))
    })));
  });

  socket.on('createRoom', (roomName) => {
    rooms.add(roomName);
    io.sockets.sockets.forEach(s => s.join(roomName));
    io.emit('roomsList', Array.from(rooms));
  });

  socket.on('deleteRoom', (room) => {
    if (['general', 'random', 'tech'].includes(room)) return;
    rooms.delete(room);
    io.emit('roomsList', Array.from(rooms));
  });

  socket.on('renameRoom', ({ oldName, newName }) => {
    if (['general', 'random', 'tech'].includes(oldName)) return;
    rooms.delete(oldName);
    rooms.add(newName);
    io.in(oldName).socketsJoin(newName);
    io.in(oldName).socketsLeave(oldName);
    io.emit('roomsList', Array.from(rooms));
  });

  socket.on('setRoomDescription', ({ room, description }) => {
    roomDescriptions[room] = description;
    io.emit('roomDescriptionUpdated', { room, description });
  });

  socket.on('updateStatus', async ({ username, status }) => {
    await User.findOneAndUpdate({ username }, { status });
    io.emit('userStatus', { username, status });
  });

  socket.on('typing', (username) => {
    socket.broadcast.to(socket.currentRoom).emit('typing', username);
  });

  socket.on('stopTyping', () => {
    socket.broadcast.to(socket.currentRoom).emit('stopTyping');
  });

  socket.on('dmTyping', ({ fromUser, dmId }) => {
    socket.broadcast.to(dmId).emit('dmTyping', { fromUser, dmId });
  });

  socket.on('dmStopTyping', ({ dmId }) => {
    socket.broadcast.to(dmId).emit('dmStopTyping', { dmId });
  });

  socket.on('message', async (msg) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('rateLimitError', { message: 'Sending too fast, slow down.' });
      return;
    }
    const targetRoom = msg.targetRoom || socket.currentRoom;
    const mentions = await extractMentions(msg.text);
    const newMessage = new Message({
      username: msg.username,
      text: msg.text || '',
      imageUrl: msg.imageUrl || '',
      fileUrl: msg.fileUrl || '',
      fileName: msg.fileName || '',
      fileSize: msg.fileSize || 0,
      fileType: msg.fileType || '',
      duration: msg.duration || 0,
      stickerUrl: msg.stickerUrl || '',
      room: targetRoom,
      replyTo: msg.replyTo || null,
      viewOnce: msg.viewOnce || false,
      mentions,
      readBy: socket.username ? [socket.username] : []
    });
    await newMessage.save();
    io.to(targetRoom).emit('message', {
      _id: newMessage._id,
      username: msg.username,
      text: msg.text,
      imageUrl: newMessage.viewOnce ? '' : (msg.imageUrl || ''),
      fileUrl: msg.fileUrl || '',
      fileName: msg.fileName || '',
      fileSize: msg.fileSize || 0,
      fileType: msg.fileType || '',
      duration: newMessage.duration,
      stickerUrl: msg.stickerUrl || '',
      reactions: {},
      replyTo: msg.replyTo || null,
      createdAt: newMessage.createdAt,
      room: targetRoom,
      starredBy: [],
      mentions,
      viewOnce: newMessage.viewOnce,
      viewOnceExpired: false,
      readBy: newMessage.readBy
    });
    mentions.forEach(mentionedUser => {
      if (mentionedUser === msg.username) return;
      const targetSocket = userSockets.get(mentionedUser);
      if (targetSocket) {
        targetSocket.emit('mentioned', { from: msg.username, room: socket.currentRoom, text: msg.text });
      }
    });
  });

  socket.on('reaction', async ({ messageId, emoji, username }) => {
    const message = await Message.findById(messageId);
    if (!message) return;
    const reactions = message.reactions || new Map();
    const users = reactions.get(emoji) || [];
    if (users.includes(username)) {
      reactions.set(emoji, users.filter(u => u !== username));
    } else {
      reactions.set(emoji, [...users, username]);
    }
    message.reactions = reactions;
    await message.save();
    const room = message.isDM ? message.dmId : socket.currentRoom;
    io.to(room).emit('reactionUpdate', {
      messageId,
      reactions: Object.fromEntries(message.reactions)
    });
  });

  socket.on('openDM', async ({ fromUser, toUser }) => {
    const dmId = [fromUser, toUser].sort().join('_');
    socket.join(dmId);
    socket.currentDM = dmId;
    const messages = await Message.find({ isDM: true, dmId })
      .sort({ createdAt: -1 })
      .limit(50);
    socket.emit('dmMessages', {
      dmId,
      messages: messages.reverse().map(m => ({
        _id: m._id,
        username: m.username,
        text: m.text,
        imageUrl: m.viewOnce ? '' : (m.imageUrl || ''),
        fileUrl: m.fileUrl,
        fileName: m.fileName,
        fileSize: m.fileSize,
        fileType: m.fileType,
        duration: m.duration || 0,
        stickerUrl: m.stickerUrl || '',
        reactions: Object.fromEntries(m.reactions || new Map()),
        replyTo: m.replyTo || null,
        createdAt: m.createdAt,
        edited: m.edited,
        readBy: m.readBy || [],
        starredBy: (m.starredBy || []).includes(socket.username) ? [socket.username] : [],
        mentions: m.mentions || [],
        viewOnce: m.viewOnce || false,
        viewOnceExpired: m.viewOnceExpired || false
      }))
    });
  });

  socket.on('dmMessage', async ({ fromUser, toUser, text, imageUrl, fileUrl, fileName, fileSize, fileType, duration, replyTo, viewOnce, stickerUrl }) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('rateLimitError', { message: 'Sending too fast, slow down.' });
      return;
    }
    const dmId = [fromUser, toUser].sort().join('_');
    const mentions = await extractMentions(text);
    const newMessage = new Message({
      username: fromUser,
      text: text || '',
      imageUrl: imageUrl || '',
      fileUrl: fileUrl || '',
      fileName: fileName || '',
      fileSize: fileSize || 0,
      fileType: fileType || '',
      duration: duration || 0,
      stickerUrl: stickerUrl || '',
      isDM: true,
      dmId,
      replyTo: replyTo || null,
      viewOnce: viewOnce || false,
      mentions
    });
    await newMessage.save();
    const payload = {
      _id: newMessage._id,
      dmId,
      username: fromUser,
      text: text || '',
      imageUrl: newMessage.viewOnce ? '' : (imageUrl || ''),
      fileUrl: fileUrl || '',
      fileName: fileName || '',
      fileSize: fileSize || 0,
      fileType: fileType || '',
      duration: newMessage.duration,
      stickerUrl: stickerUrl || '',
      reactions: {},
      replyTo: replyTo || null,
      createdAt: newMessage.createdAt,
      readBy: [],
      starredBy: [],
      mentions,
      viewOnce: newMessage.viewOnce,
      viewOnceExpired: false
    };
    io.to(dmId).emit('dmMessage', payload);
    const recipientSocket = userSockets.get(toUser);
    if (recipientSocket && !recipientSocket.rooms.has(dmId)) {
      recipientSocket.join(dmId);
      recipientSocket.emit('dmMessage', payload);
    }
  });

  socket.on('markDMRead', async ({ dmId, reader }) => {
    await Message.updateMany(
      { isDM: true, dmId, username: { $ne: reader }, readBy: { $ne: reader } },
      { $push: { readBy: reader } }
    );
    io.to(dmId).emit('dmRead', { dmId, reader });
  });

  socket.on('markRoomRead', async ({ room, reader }) => {
    const recent = await Message.find({ room, isDM: false })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('_id');
    const ids = recent.map(m => m._id);
    await Message.updateMany(
      { _id: { $in: ids }, readBy: { $ne: reader } },
      { $push: { readBy: reader } }
    );
    io.to(room).emit('roomMessagesRead', { reader, room });
  });

  socket.on('editMessage', async ({ messageId, newText }) => {
    const message = await Message.findById(messageId);
    if (!message) return;
    if (message.username !== socket.username) return;
    message.text = newText;
    message.edited = true;
    await message.save();
    const room = message.isDM ? message.dmId : socket.currentRoom;
    io.to(room).emit('messageEdited', { messageId, newText, edited: true });
  });

  socket.on('deleteMessage', async ({ messageId }) => {
    const message = await Message.findById(messageId);
    if (!message) return;
    if (message.username !== socket.username) return;
    const room = message.isDM ? message.dmId : socket.currentRoom;
    await Message.findByIdAndDelete(messageId);
    io.to(room).emit('messageDeleted', { messageId });
  });

  socket.on('pinMessage', async ({ messageId }) => {
    const message = await Message.findById(messageId);
    if (!message) return;
    message.pinned = true;
    await message.save();
    const room = message.isDM ? message.dmId : socket.currentRoom;
    io.to(room).emit('messagePinned', {
      messageId,
      username: message.username,
      text: message.text,
      imageUrl: message.imageUrl,
      room
    });
  });

  socket.on('unpinMessage', async ({ messageId }) => {
    const message = await Message.findById(messageId);
    if (!message) return;
    message.pinned = false;
    await message.save();
    const room = message.isDM ? message.dmId : socket.currentRoom;
    io.to(room).emit('messageUnpinned', { messageId, room });
  });

  socket.on('toggleStar', async ({ messageId }) => {
    const message = await Message.findById(messageId);
    if (!message) return;
    const idx = (message.starredBy || []).indexOf(socket.username);
    if (idx === -1) {
      message.starredBy.push(socket.username);
    } else {
      message.starredBy.splice(idx, 1);
    }
    await message.save();
    const starred = message.starredBy.includes(socket.username);
    socket.emit('starUpdated', { messageId, starred });
  });

  socket.on('getStarredMessages', async () => {
    const msgs = await Message.find({ starredBy: socket.username })
      .sort({ createdAt: -1 })
      .limit(100);
    socket.emit('starredMessages', msgs.map(m => ({
      _id: m._id,
      username: m.username,
      text: m.text,
      imageUrl: m.viewOnce ? '' : (m.imageUrl || ''),
      fileType: m.fileType,
      stickerUrl: m.stickerUrl || '',
      room: m.room,
      isDM: m.isDM,
      dmId: m.dmId,
      createdAt: m.createdAt,
      mentions: m.mentions || [],
      viewOnce: m.viewOnce || false,
      viewOnceExpired: m.viewOnceExpired || false
    })));
  });

  socket.on('getLastMessages', async (dmIds) => {
    if (!Array.isArray(dmIds) || dmIds.length === 0) return;
    const results = {};
    await Promise.all(dmIds.map(async (dmId) => {
      const msg = await Message.findOne({ isDM: true, dmId })
        .sort({ createdAt: -1 })
        .select('username text imageUrl fileUrl fileType stickerUrl viewOnce createdAt');
      if (msg) {
        results[dmId] = {
          username: msg.username,
          text: msg.text || '',
          imageUrl: msg.imageUrl || '',
          fileUrl: msg.fileUrl || '',
          fileType: msg.fileType || '',
          stickerUrl: msg.stickerUrl || '',
          viewOnce: msg.viewOnce || false,
          createdAt: msg.createdAt
        };
      }
    }));
    socket.emit('lastMessages', results);
  });

  socket.on('viewOnceImage', async ({ messageId }) => {
    const message = await Message.findById(messageId);
    if (!message || !message.viewOnce) return;
    if (message.username === socket.username) return;
    if (message.isDM) {
      if (!message.dmId.split('_').includes(socket.username)) return;
    } else {
      if (!socket.rooms.has(message.room)) return;
    }

    const consumed = await Message.findOneAndUpdate(
      { _id: messageId, viewOnce: true, viewOnceExpired: false },
      { $set: { viewOnceExpired: true, imageUrl: '' } },
      { new: false }
    );
    if (!consumed) return;

    let imageData = consumed.imageUrl;
    if (consumed.imageUrl) {
      const filename = path.basename(consumed.imageUrl);
      const filePath = path.join(__dirname, 'uploads', filename);
      try {
        const ext = path.extname(filename).slice(1).toLowerCase();
        const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
        const mimeType = mimeMap[ext] || 'image/jpeg';
        const buffer = await fs.promises.readFile(filePath);
        imageData = `data:${mimeType};base64,${buffer.toString('base64')}`;
      } catch (err) {
        console.log('view-once read error (falling back to URL):', err);
      }
    }

    socket.emit('viewOnceImageData', { messageId, imageUrl: imageData });

    if (consumed.imageUrl) {
      const filename = path.basename(consumed.imageUrl);
      const filePath = path.join(__dirname, 'uploads', filename);
      fs.unlink(filePath, (err) => { if (err) console.log('view-once unlink:', err); });
    }

    const room = message.isDM ? message.dmId : message.room;
    io.to(room).emit('viewOnceExpired', { messageId });
  });

  // ---- Polls ----
  socket.on('createPoll', async ({ question, options, room, dmId }) => {
    if (!socket.username) return;
    if (!question || !Array.isArray(options) || options.length < 2) return;
    const poll = new Poll({
      question,
      options: options.map(text => ({ text, votes: [] })),
      room: room || '',
      dmId: dmId || '',
      createdBy: socket.username
    });
    await poll.save();
    const target = dmId || room;
    io.to(target).emit('newPoll', poll.toObject());
  });

  socket.on('votePoll', async ({ pollId, optionIndex, username: voter }) => {
    const poll = await Poll.findById(pollId);
    if (!poll) return;
    const opt = poll.options[optionIndex];
    if (!opt) return;
    // Check before removal so we know whether to re-add (toggle behaviour)
    const alreadyVotedThis = opt.votes.includes(voter);
    // Remove from all options (one vote per user)
    poll.options.forEach(o => { o.votes = o.votes.filter(u => u !== voter); });
    // Only add vote if they weren't already on this option (click same = unvote)
    if (!alreadyVotedThis) poll.options[optionIndex].votes.push(voter);
    await poll.save();
    const target = poll.dmId || poll.room;
    io.to(target).emit('pollUpdated', poll.toObject());
  });

  socket.on('getPolls', async ({ room, dmId }) => {
    const query = dmId ? { dmId } : { room };
    const polls = await Poll.find(query).sort({ createdAt: 1 });
    socket.emit('pollsList', polls.map(p => p.toObject()));
  });

  // ---- Scheduled Messages ----
  socket.on('scheduleMessage', async ({ username: uname, text, room, dmId, toUser, scheduledFor }) => {
    if (!text || !scheduledFor) return;
    const sendAt = new Date(scheduledFor);
    if (isNaN(sendAt) || sendAt <= new Date()) {
      socket.emit('scheduleError', { message: 'Scheduled time must be in the future.' });
      return;
    }
    const sm = new ScheduledMessage({ username: uname, text, room: room || '', dmId: dmId || '', toUser: toUser || '', scheduledFor: sendAt });
    await sm.save();
    socket.emit('scheduledMessageCreated', sm.toObject());
  });

  socket.on('getScheduledMessages', async ({ username: uname }) => {
    const msgs = await ScheduledMessage.find({ username: uname, sent: false }).sort({ scheduledFor: 1 });
    socket.emit('scheduledMessages', msgs.map(m => m.toObject()));
  });

  socket.on('cancelScheduledMessage', async ({ scheduledMessageId, username: uname }) => {
    const sm = await ScheduledMessage.findById(scheduledMessageId);
    if (!sm || sm.username !== uname) return;
    await ScheduledMessage.findByIdAndDelete(scheduledMessageId);
    socket.emit('scheduledMessageCancelled', { scheduledMessageId });
  });

  // ---- WebRTC Signaling ----
  socket.on('callUser', async ({ to, from, signal, callType }) => {
    const targetSocket = userSockets.get(to);
    if (!targetSocket) {
      socket.emit('callFailed', { message: `${to} is not online.` });
      return;
    }
    const key = [from, to].sort().join('_');
    try {
      const log = await CallLog.create({ caller: from, callee: to, callType, status: 'missed', duration: 0 });
      activeCallLogs.set(key, { logId: log._id, startedAt: null });
    } catch (err) {}
    targetSocket.emit('incomingCall', { from, signal, callType });
  });

  socket.on('answerCall', async ({ to, signal }) => {
    const targetSocket = userSockets.get(to);
    if (targetSocket) targetSocket.emit('callAccepted', { signal });
    const key = [socket.username, to].sort().join('_');
    const entry = activeCallLogs.get(key);
    if (entry) {
      entry.startedAt = new Date();
      CallLog.findByIdAndUpdate(entry.logId, { status: 'answered' }).catch(() => {});
    }
  });

  socket.on('rejectCall', async ({ to }) => {
    const targetSocket = userSockets.get(to);
    if (targetSocket) targetSocket.emit('callRejected');
    const key = [socket.username, to].sort().join('_');
    const entry = activeCallLogs.get(key);
    if (entry) {
      await CallLog.findByIdAndUpdate(entry.logId, { status: 'declined' }).catch(() => {});
      activeCallLogs.delete(key);
    }
  });

  socket.on('endCall', async ({ to }) => {
    const targetSocket = userSockets.get(to);
    if (targetSocket) targetSocket.emit('callEnded');
    const key = [socket.username, to].sort().join('_');
    const entry = activeCallLogs.get(key);
    if (entry) {
      if (entry.startedAt) {
        const duration = Math.round((Date.now() - entry.startedAt.getTime()) / 1000);
        await CallLog.findByIdAndUpdate(entry.logId, { duration }).catch(() => {});
      }
      activeCallLogs.delete(key);
    }
  });

  socket.on('getCallLogs', async () => {
    if (!socket.username) return;
    const logs = await CallLog.find({
      $or: [{ caller: socket.username }, { callee: socket.username }]
    }).sort({ createdAt: -1 }).limit(100);
    socket.emit('callLogs', logs);
  });

  socket.on('iceCandidate', ({ to, candidate }) => {
    const targetSocket = userSockets.get(to);
    if (targetSocket) targetSocket.emit('iceCandidate', { candidate });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      userSockets.delete(socket.username);
      io.emit('onlineUsers', Array.from(onlineUsers));
      User.findOneAndUpdate(
        { username: socket.username },
        { lastSeen: new Date() }
      ).catch(err => console.log(err));
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Global error handler — must be last; never leak stack traces in production
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message
  });
});
