const jwt = require('jsonwebtoken');

const JWT_OPTIONS = {
  algorithms: ['HS256'],
  issuer: 'ichat',
  audience: 'ichat-users'
};

// Returns the decoded payload, or null if the token is missing/invalid/expired.
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET, JWT_OPTIONS);
  } catch {
    return null;
  }
}

const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ message: 'Invalid or expired token' });
  req.user = decoded;
  next();
};

// Use after requireAuth on routes with a :username param — you may only act on yourself.
const requireSelf = (req, res, next) => {
  if (!req.user || req.user.username !== req.params.username) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

module.exports = { requireAuth, requireSelf, verifyToken };
