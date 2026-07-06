const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'avatar_' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 3 * 1024 * 1024 } });

// Get all registered users (roster — no passwords)
router.get('/', async (req, res) => {
  const users = await User.find({}, 'username displayName avatar status lastSeen').lean();
  res.json(users);
});

// Get profile
router.get('/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatar: user.avatar,
    status: user.status,
    lastSeen: user.lastSeen,
    createdAt: user.createdAt
  });
});

// Update profile
router.put('/:username', requireAuth, async (req, res) => {
  const { displayName, bio, status } = req.body;
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (displayName !== undefined) user.displayName = displayName;
  if (bio !== undefined) user.bio = bio;
  if (status !== undefined) user.status = status;
  await user.save();
  res.json({ message: 'Profile updated!', user });
});

// Update avatar
router.post('/:username/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  const avatarUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  user.avatar = avatarUrl;
  await user.save();
  res.json({ avatarUrl });
});

// Change password
router.put('/:username/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(400).json({ message: 'Current password is wrong' });
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ message: 'Password changed successfully!' });
});

module.exports = router;