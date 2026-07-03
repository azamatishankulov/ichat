const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const Sticker = require('../models/Sticker');
const { requireAuth } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_sticker_' + file.originalname.replace(/\s+/g, '_'));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});

// Upload a new sticker
router.post('/', requireAuth, upload.single('sticker'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  const { owner } = req.body;
  if (!owner) return res.status(400).json({ message: 'owner required' });
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  const sticker = new Sticker({ owner, imageUrl });
  await sticker.save();
  res.json({ _id: sticker._id, imageUrl, owner, createdAt: sticker.createdAt });
});

// List stickers for a user
router.get('/:username', async (req, res) => {
  const stickers = await Sticker.find({ owner: req.params.username }).sort({ createdAt: 1 });
  res.json(stickers);
});

// Delete a sticker (ownership enforced via body.owner)
router.delete('/:id', requireAuth, async (req, res) => {
  const { owner } = req.body;
  const sticker = await Sticker.findById(req.params.id);
  if (!sticker) return res.status(404).json({ message: 'Not found' });
  if (sticker.owner !== owner) return res.status(403).json({ message: 'Forbidden' });
  const filename = path.basename(sticker.imageUrl);
  await Sticker.deleteOne({ _id: req.params.id });
  const filePath = path.join(__dirname, '..', 'uploads', filename);
  fs.unlink(filePath, () => {});
  res.json({ message: 'Deleted' });
});

module.exports = router;
