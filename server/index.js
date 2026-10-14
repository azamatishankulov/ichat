require('dotenv').config();
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
const { setupSockets, loadRooms } = require('./sockets');
const { seedRooms, migrateDmIds } = require('./utils/migrate');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

app.use(express.json({ limit: '100kb' }));
// Sanitize req.body only — Express 5's req.query is a read-only getter and
// cannot be reassigned, so middleware packages that do req.query = ... crash.
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize(req.body);
  next();
});

// Rate limiters
const makeLimiter = (max) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later.' }
});
const authLimiter = makeLimiter(Number(process.env.AUTH_RATE_LIMIT) || 10);
const uploadLimiter = makeLimiter(30);
const apiLimiter = makeLimiter(Number(process.env.API_RATE_LIMIT) || 200);

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

// Uploaded files: only images/audio/video may render inline. Anything else (html,
// svg, pdf...) is forced to download so an uploaded page can never run on our origin.
const INLINE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp3', '.wav', '.ogg', '.m4a', '.webm', '.mp4']);
app.use('/uploads', express.static(UPLOAD_DIR, {
  dotfiles: 'deny',
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (!INLINE_EXT.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

app.get('/', (req, res) => {
  res.send('Chat server is running!');
});

const sockets = setupSockets(io);

// Global error handler — must come after all routes; never leak stack traces in production
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ message: 'Origin not allowed' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'File is too large' });
  console.error(err.stack || err.message);
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  res.status(status).json({
    message: process.env.NODE_ENV === 'production' && status === 500
      ? 'Something went wrong'
      : err.message
  });
});

// A bug in one request must never take the whole chat server down.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

async function start(port = process.env.PORT || 5000) {
  for (const name of ['MONGO_URI', 'JWT_SECRET']) {
    if (!process.env[name]) throw new Error(`Missing required environment variable ${name}`);
  }
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('Connected to MongoDB!');
  mongoose.connection.on('error', err => console.error('MongoDB connection error:', err));

  await seedRooms();
  const converted = await migrateDmIds();
  if (converted) console.log(`Migrated ${converted} direct-message conversation id(s)`);
  await loadRooms();

  const task = sockets.startScheduler();
  await new Promise(resolve => server.listen(port, resolve));
  console.log(`Server running on port ${server.address().port}`);
  return { stop: async () => { task.stop(); io.close(); await mongoose.disconnect(); } };
}

if (require.main === module) {
  start().catch(err => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { app, server, io, start, deliverDueMessages: sockets.deliverDue };
