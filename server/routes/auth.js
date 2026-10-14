const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();
const { body, validationResult } = require('express-validator');

const registerValidation = [
  body('username')
    .trim()
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username may only contain letters, numbers, and underscores')
    .isLength({ min: 3, max: 30 }).withMessage('Username must be 3–30 characters'),
  body('password')
    .isLength({ min: 6, max: 128 }).withMessage('Password must be 6–128 characters')
];

const loginValidation = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
];

// REGISTER
router.post('/register', registerValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  // Usernames are compared case-insensitively so "Alice" and "alice" can't both exist
  const taken = await User.findOne({ username: new RegExp(`^${username}$`, 'i') }, '_id').lean();
  if (taken) return res.status(409).json({ message: 'Username already taken' });

  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    await User.create({ username, password: hashedPassword });
  } catch (err) {
    // Two sign-ups racing for the same name: the unique index catches the loser
    if (err.code === 11000) return res.status(409).json({ message: 'Username already taken' });
    throw err;
  }
  res.json({ message: 'Account created! You can now login.' });
});

// LOGIN
router.post('/login', loginValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  const user = await User.findOne({ username });
  // Same message for "no such user" and "wrong password" so usernames can't be probed
  const valid = user && await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ message: 'Invalid username or password' });

  const token = jwt.sign(
    { username: user.username },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
      algorithm: 'HS256',
      issuer: 'ichat',
      audience: 'ichat-users'
    }
  );

  res.json({ token, username: user.username });
});

module.exports = router;
