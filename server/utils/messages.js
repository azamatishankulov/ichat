// Shapes a Message document for the client. Used everywhere a message is sent
// so every code path hides view-once images and per-user stars the same way.
function serializeMessage(m, viewer) {
  const o = typeof m.toObject === 'function' ? m.toObject() : m;
  const reactions = o.reactions instanceof Map ? Object.fromEntries(o.reactions) : (o.reactions || {});
  return {
    _id: o._id,
    username: o.username,
    text: o.text || '',
    imageUrl: o.viewOnce ? '' : (o.imageUrl || ''),
    fileUrl: o.fileUrl || '',
    fileName: o.fileName || '',
    fileSize: o.fileSize || 0,
    fileType: o.fileType || '',
    duration: o.duration || 0,
    stickerUrl: o.stickerUrl || '',
    forwardedFrom: o.forwardedFrom || '',
    reactions,
    replyTo: o.replyTo || null,
    createdAt: o.createdAt,
    edited: !!o.edited,
    pinned: !!o.pinned,
    room: o.room || '',
    dmId: o.dmId || '',
    isDM: !!o.isDM,
    // Only reveal whether *this viewer* starred it
    starredBy: viewer && (o.starredBy || []).includes(viewer) ? [viewer] : [],
    mentions: o.mentions || [],
    viewOnce: !!o.viewOnce,
    viewOnceExpired: !!o.viewOnceExpired,
    readBy: o.readBy || []
  };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ':' can never appear in a username (letters, digits and underscores only), so
// two different pairs of users can never produce the same DM id. The old format
// joined with '_', which collided for names like a_b+c and a+b_c.
const DM_SEP = ':';
const dmIdFor = (a, b) => [a, b].sort().join(DM_SEP);
const dmMembers = (dmId) => String(dmId || '').split(DM_SEP);
const isDmMember = (dmId, username) => dmMembers(dmId).length === 2 && dmMembers(dmId).includes(username);

module.exports = { serializeMessage, escapeRegex, dmIdFor, dmMembers, isDmMember, DM_SEP };
