const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const BLOCKED_MIME_PATTERNS = [
  'application/x-msdownload',
  'application/x-executable',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-bat',
  'application/x-msdos-program',
];

function isBlockedMime(mime) {
  if (!mime) return false;
  if (BLOCKED_MIME_PATTERNS.includes(mime)) return true;
  if (mime.startsWith('application/x-')) return true;
  if (mime.startsWith('text/x-')) return true;
  return false;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, crypto.randomUUID() + (ext ? '.' + ext : ''));
  }
});

const imageUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'));
    }
    cb(null, true);
  }
});

const fileUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isBlockedMime(file.mimetype)) {
      return cb(new Error('File type not allowed'));
    }
    cb(null, true);
  }
});

async function detectMime(filePath) {
  try {
    const { fileTypeFromFile } = await import('file-type');
    return await fileTypeFromFile(filePath);
  } catch {
    return null;
  }
}

// Image upload
router.post('/image', requireAuth, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const detected = await detectMime(req.file.path);
  if (!detected || !ALLOWED_IMAGE_TYPES.includes(detected.mime)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: 'File content does not match a permitted image type' });
  }

  const imageUrl = `http://localhost:5000/uploads/${req.file.filename}`;
  res.json({ imageUrl });
});

// File/voice upload
router.post('/file', requireAuth, fileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  // Enforce stricter 2MB limit for audio
  if (req.file.mimetype.startsWith('audio/') && req.file.size > 2 * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: 'Audio files must be under 2MB' });
  }

  // Reject if actual content is an executable, regardless of claimed MIME
  const detected = await detectMime(req.file.path);
  if (detected && isBlockedMime(detected.mime)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: 'File type not allowed' });
  }

  const fileUrl = `http://localhost:5000/uploads/${req.file.filename}`;
  res.json({
    fileUrl,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    fileType: req.file.mimetype
  });
});

module.exports = router;
