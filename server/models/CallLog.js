const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
  caller: { type: String, required: true },
  callee: { type: String, required: true },
  callType: { type: String, enum: ['audio', 'video'], required: true },
  status: { type: String, enum: ['answered', 'missed', 'declined'], default: 'missed' },
  duration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('CallLog', callLogSchema);
