const User = require('../models/User');
const Message = require('../models/Message');
const Poll = require('../models/Poll');
const ScheduledMessage = require('../models/ScheduledMessage');
const Room = require('../models/Room');
const { dmIdFor, DM_SEP } = require('./messages');

const DEFAULT_ROOMS = {
  general: 'General chat for everyone',
  random: 'Random off-topic conversations',
  tech: 'Tech talk and discussions'
};

// Make sure the built-in rooms exist.
async function seedRooms() {
  for (const [name, description] of Object.entries(DEFAULT_ROOMS)) {
    await Room.updateOne({ name }, { $setOnInsert: { name, description, createdBy: '' } }, { upsert: true });
  }
}

// Old DM ids looked like "alice_bob" and could be ambiguous when usernames contain
// underscores. Convert them to "alice:bob" by finding the split where both halves
// are real usernames. Safe to run on every start: it only touches old-style ids.
async function migrateDmIds() {
  const oldIds = (await Message.distinct('dmId', { isDM: true }))
    .filter(id => id && !id.includes(DM_SEP));
  if (oldIds.length === 0) return 0;

  const names = new Set((await User.find({}, 'username').lean()).map(u => u.username));
  let converted = 0;
  for (const oldId of oldIds) {
    let newId = null;
    for (let i = 1; i < oldId.length - 1; i++) {
      if (oldId[i] !== '_') continue;
      const a = oldId.slice(0, i);
      const b = oldId.slice(i + 1);
      // The old id was the *sorted* pair, so only a correctly ordered split matches.
      if (names.has(a) && names.has(b) && [a, b].sort().join('_') === oldId) {
        newId = dmIdFor(a, b);
        break;
      }
    }
    if (!newId) continue;
    await Message.updateMany({ isDM: true, dmId: oldId }, { $set: { dmId: newId } });
    await Poll.updateMany({ dmId: oldId }, { $set: { dmId: newId } });
    await ScheduledMessage.updateMany({ dmId: oldId }, { $set: { dmId: newId } });
    converted++;
  }
  return converted;
}

module.exports = { seedRooms, migrateDmIds, DEFAULT_ROOMS };
