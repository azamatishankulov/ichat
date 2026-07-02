const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true
  },
  text: {
    type: String,
    default: ''
  },
  imageUrl: {
    type: String,
    default: ''
  },

  fileUrl: {
  type: String,
  default: ''
},
fileName: {
  type: String,
  default: ''
},
fileSize: {
  type: Number,
  default: 0
},
fileType: {
  type: String,
  default: ''
},

  room: {
    type: String,
    default: 'general'
  },
  isDM: {
    type: Boolean,
    default: false
  },
  dmId: {
    type: String,
    default: ''
  },
  replyTo: {
    type: {
      messageId: String,
      username: String,
      text: String,
      imageUrl: String
    },
    default: null
  },
  reactions: {
    type: Map,
    of: [String],
    default: {}
  },
  edited: {
    type: Boolean,
    default: false
  },

  pinned: {
  type: Boolean,
  default: false
},

  readBy: {
    type: [String],
    default: []
  },

  duration: {
    type: Number,
    default: 0
  },

  starredBy: {
    type: [String],
    default: []
  },

  mentions: {
    type: [String],
    default: []
  },

  viewOnce: {
    type: Boolean,
    default: false
  },
  viewOnceExpired: {
    type: Boolean,
    default: false
  },

  stickerUrl: {
    type: String,
    default: ''
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Message', messageSchema);