const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  displayName: {
    type: String,
    default: ''
  },
  bio: {
    type: String,
    default: ''
  },
  avatar: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    default: 'online'
  },
  // Usernames this user has blocked (no DMs or calls in either direction)
  blockedUsers: {
    type: [String],
    default: []
  },
  // Chats this user muted: "room:<name>" or "dm:<dmId>" (no notifications)
  mutedChats: {
    type: [String],
    default: []
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);