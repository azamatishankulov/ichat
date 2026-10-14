const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { requireAuth, requireSelf } = require('../middleware/auth');
const { imageUploader, isRealImage, removeFile, uploadPathFromUrl } = require('../utils/uploads');

const upload = imageUploader(3 * 1024 * 1024);
const STATUSES = ['online', 'away', 'busy', 'invisible'];

// Public view of a user — never includes the password hash or private settings.
const publicProfile = (user) => ({
  username: user.username,
  displayName: user.displayName,
  bio: user.bio,
  avatar: user.avatar,
  status: user.status,
  lastSeen: user.lastSeen,
  createdAt: user.createdAt
});

// Get all registered users (roster — no passwords)
router.get('/', async (req, res) => {
  const users = await User.find({}, 'username displayName avatar status lastSeen').lean();
  res.json(users);
});

// Get profile
router.get('/:username', async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(publicProfile(user));
});

// Update profile (you can only edit your own)
router.put('/:username', requireAuth, requireSelf, async (req, res) => {
  const { displayName, bio, status } = req.body;
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });

  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.length > 50) {
      return res.status(400).json({ message: 'Display name must be 50 characters or fewer' });
    }
    user.displayName = displayName.trim();
  }
  if (bio !== undefined) {
    if (typeof bio !== 'string' || bio.length > 300) {
      return res.status(400).json({ message: 'Bio must be 300 characters or fewer' });
    }
    user.bio = bio.trim();
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    user.status = status;
  }
  await user.save();
  res.json({ message: 'Profile updated!', user: publicProfile(user) });
});

// Update avatar
router.post('/:username/avatar', requireAuth, requireSelf, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  if (!(await isRealImage(req.file.path))) {
    removeFile(req.file.path);
    return res.status(400).json({ message: 'File content does not match a permitted image type' });
  }
  const user = await User.findOne({ username: req.params.username });
  if (!user) {
    removeFile(req.file.path);
    return res.status(404).json({ message: 'User not found' });
  }
  const oldFile = uploadPathFromUrl(user.avatar);
  user.avatar = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  await user.save();
  if (oldFile) removeFile(oldFile); // don't leave the previous avatar behind
  res.json({ avatarUrl: user.avatar });
});

// Change password
router.put('/:username/password', requireAuth, requireSelf, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ message: 'Both passwords are required' });
  }
  if (newPassword.length < 6 || newPassword.length > 128) {
    return res.status(400).json({ message: 'New password must be 6–128 characters' });
  }
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ message: 'User not found' });
  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(400).json({ message: 'Current password is wrong' });
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ message: 'Password changed successfully!' });
});

module.exports = router;
