const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
  caller: { type: String, required: true },
  callee: { type: String, required: true },
  callType: { type: String, enum: ['audio', 'video'], required: true },
  status: { type: String, enum: ['answered', 'missed', 'declined'], default: 'missed' },
  duration: { type: Number, default: 0 },
  // Usernames who've cleared this call from their own history — the log
  // stays intact for the other participant.
  hiddenFor: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('CallLog', callLogSchema);
