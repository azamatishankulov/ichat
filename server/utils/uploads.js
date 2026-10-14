const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Random file names: never trust the client's file name on disk.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    cb(null, crypto.randomUUID() + (ext ? '.' + ext : ''));
  }
});

function imageUploader(maxBytes) {
  return multer({
    storage,
    limits: { fileSize: maxBytes },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
        return cb(Object.assign(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'), { status: 400 }));
      }
      cb(null, true);
    }
  });
}

async function detectMime(filePath) {
  try {
    const { fileTypeFromFile } = await import('file-type');
    return await fileTypeFromFile(filePath);
  } catch {
    return null;
  }
}

// True only if the bytes on disk really are a permitted image (checks the content, not the header).
async function isRealImage(filePath) {
  const detected = await detectMime(filePath);
  return !!detected && ALLOWED_IMAGE_TYPES.includes(detected.mime);
}

const removeFile = (filePath) => fs.unlink(filePath, () => {});

// Turn "https://host/uploads/abc.png" into the file's path on disk (or null).
function uploadPathFromUrl(url) {
  if (typeof url !== 'string' || !url.includes('/uploads/')) return null;
  return path.join(UPLOAD_DIR, path.basename(url));
}

module.exports = { UPLOAD_DIR, ALLOWED_IMAGE_TYPES, storage, imageUploader, detectMime, isRealImage, removeFile, uploadPathFromUrl };
