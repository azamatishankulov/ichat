const express = require('express');
const multer = require('multer');
const fs = require('fs');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

const { storage, imageUploader, detectMime, isRealImage } = require('../utils/uploads');

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

const imageUpload = imageUploader(5 * 1024 * 1024);

const fileUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isBlockedMime(file.mimetype)) {
      return cb(Object.assign(new Error('File type not allowed'), { status: 400 }));
    }
    cb(null, true);
  }
});

// Image upload
router.post('/image', requireAuth, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  if (!(await isRealImage(req.file.path))) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: 'File content does not match a permitted image type' });
  }

  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
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

  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({
    fileUrl,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    fileType: req.file.mimetype
  });
});

module.exports = router;
