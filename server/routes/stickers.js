const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Sticker = require('../models/Sticker');
const { requireAuth } = require('../middleware/auth');
const { imageUploader, isRealImage, removeFile, uploadPathFromUrl } = require('../utils/uploads');

const MAX_STICKERS_PER_USER = 50;
const upload = imageUploader(2 * 1024 * 1024);

// Upload a new sticker (always owned by whoever is logged in)
router.post('/', requireAuth, upload.single('sticker'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  if (!(await isRealImage(req.file.path))) {
    removeFile(req.file.path);
    return res.status(400).json({ message: 'File content does not match a permitted image type' });
  }
  const owner = req.user.username;
  if ((await Sticker.countDocuments({ owner })) >= MAX_STICKERS_PER_USER) {
    removeFile(req.file.path);
    return res.status(400).json({ message: `You can have at most ${MAX_STICKERS_PER_USER} stickers` });
  }
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  const sticker = await Sticker.create({ owner, imageUrl });
  res.json({ _id: sticker._id, imageUrl, owner, createdAt: sticker.createdAt });
});

// List stickers for a user
router.get('/:username', async (req, res) => {
  const stickers = await Sticker.find({ owner: req.params.username }).sort({ createdAt: 1 });
  res.json(stickers);
});

// Delete one of your own stickers
router.delete('/:id', requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Not found' });
  const sticker = await Sticker.findById(req.params.id);
  if (!sticker) return res.status(404).json({ message: 'Not found' });
  if (sticker.owner !== req.user.username) return res.status(403).json({ message: 'Forbidden' });
  await Sticker.deleteOne({ _id: req.params.id });
  const filePath = uploadPathFromUrl(sticker.imageUrl);
  if (filePath) removeFile(filePath);
  res.json({ message: 'Deleted' });
});

module.exports = router;
