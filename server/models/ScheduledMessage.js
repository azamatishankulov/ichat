const mongoose = require('mongoose');

const scheduledMessageSchema = new mongoose.Schema({
  username: { type: String, required: true },
  text: { type: String, required: true },
  room: { type: String, default: '' },
  dmId: { type: String, default: '' },
  toUser: { type: String, default: '' },
  scheduledFor: { type: Date, required: true },
  sent: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ScheduledMessage', scheduledMessageSchema);
