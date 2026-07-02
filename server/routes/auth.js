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
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
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
  const existingUser = await User.findOne({ username });
  if (existingUser) return res.json({ message: 'Username already taken' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ username, password: hashedPassword });
  await user.save();
  res.json({ message: 'Account created! You can now login.' });
});

// LOGIN
router.post('/login', loginValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.json({ message: 'User not found' });

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) return res.json({ message: 'Wrong password' });

  const token = jwt.sign(
    { username },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
      algorithm: 'HS256',
      issuer: 'ichat',
      audience: 'ichat-users'
    }
  );

  res.json({ token, username });
});

module.exports = router;
