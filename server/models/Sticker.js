const mongoose = require('mongoose');

const stickerSchema = new mongoose.Schema({
  owner: {
    type: String,
    required: true
  },
  imageUrl: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Sticker', stickerSchema);
