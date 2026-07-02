import React, { useState, useEffect, useRef } from 'react';
import SERVER_URL from './config';

function Profile({ username, onClose, readOnly = false, onStatusChange }) {
  const formatLastSeen = (date) => {
  const now = new Date();
  const lastSeen = new Date(date);
  const diffMs = now - lastSeen;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return lastSeen.toLocaleDateString();
};
  const [profile, setProfile] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [status, setStatus] = useState('online');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [activeTab, setActiveTab] = useState('profile');
  const avatarInputRef = useRef(null);
  const stickerInputRef = useRef(null);
  const [stickers, setStickers] = useState([]);
  const [stickerMsg, setStickerMsg] = useState('');

  useEffect(() => {
    fetch(`${SERVER_URL}/api/profile/${username}`)
      .then(res => res.json())
      .then(data => {
        setProfile(data);
        setDisplayName(data.displayName || '');
        setBio(data.bio || '');
        setStatus(data.status || 'online');
      });
  }, [username]);

  useEffect(() => {
    if (activeTab === 'stickers' && !readOnly) {
      fetch(`${SERVER_URL}/api/stickers/${username}`)
        .then(r => r.json())
        .then(data => setStickers(Array.isArray(data) ? data : []))
        .catch(() => {});
    }
  }, [activeTab, username, readOnly]);

  const uploadSticker = async (file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('sticker', file);
    formData.append('owner', username);
    const token = localStorage.getItem('token');
    const res = await fetch(`${SERVER_URL}/api/stickers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (data._id) {
      setStickers(prev => [...prev, data]);
      setStickerMsg('Sticker added!');
    } else {
      setStickerMsg(data.message || 'Upload failed');
    }
    setTimeout(() => setStickerMsg(''), 3000);
    if (stickerInputRef.current) stickerInputRef.current.value = '';
  };

  const deleteSticker = async (id) => {
    const token = localStorage.getItem('token');
    await fetch(`${SERVER_URL}/api/stickers/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ owner: username })
    });
    setStickers(prev => prev.filter(s => s._id !== id));
  };

  const saveProfile = async () => {
    const token = localStorage.getItem('token');
    const res = await fetch(`${SERVER_URL}/api/profile/${username}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ displayName, bio, status })
    });
    const data = await res.json();
    setMessage(data.message);
    if (onStatusChange) onStatusChange(status);
    setTimeout(() => setMessage(''), 3000);
  };

  const changePassword = async () => {
    if (!currentPassword || !newPassword) return;
    const token = localStorage.getItem('token');
    const res = await fetch(`${SERVER_URL}/api/profile/${username}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    setMessage(data.message);
    setCurrentPassword('');
    setNewPassword('');
    setTimeout(() => setMessage(''), 3000);
  };

  const uploadAvatar = async (file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    const token = localStorage.getItem('token');
    const res = await fetch(`${SERVER_URL}/api/profile/${username}/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (data.avatarUrl) {
      setProfile(prev => ({ ...prev, avatar: data.avatarUrl }));
      setMessage('Avatar updated!');
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const initials = username.slice(0, 2).toUpperCase();
  const statusColors = {
    online: '#34c759',
    away: '#ff9500',
    busy: '#ff3b30',
    invisible: '#b0b0b5'
  };

  return (
    <div className="profile-overlay" onClick={onClose}>
      <div className="profile-modal" onClick={e => e.stopPropagation()}>
        <div className="profile-header">
          <h2>{readOnly ? `${username}'s Profile` : 'Profile'}</h2>
          <button className="profile-close" onClick={onClose}>вњ•</button>
        </div>

        <div className="profile-tabs">
          <button
            className={activeTab === 'profile' ? 'active' : ''}
            onClick={() => setActiveTab('profile')}
          >Profile</button>
          {!readOnly && (
            <button
              className={activeTab === 'security' ? 'active' : ''}
              onClick={() => setActiveTab('security')}
            >Security</button>
          )}
          {!readOnly && (
            <button
              className={activeTab === 'stickers' ? 'active' : ''}
              onClick={() => setActiveTab('stickers')}
            >Stickers</button>
          )}
        </div>

        {activeTab === 'profile' && (
          <div className="profile-content">
            <div className="avatar-section">
              <div
                className="profile-avatar"
                onClick={() => !readOnly && avatarInputRef.current.click()}
                style={{ cursor: readOnly ? 'default' : 'pointer' }}
              >
                {profile?.avatar ? (
                  <img src={profile.avatar} alt="avatar" />
                ) : (
                  <span>{initials}</span>
                )}
                {!readOnly && <div className="avatar-overlay">Change</div>}
              </div>
              {!readOnly && (
                <input
                  type="file"
                  accept="image/*"
                  ref={avatarInputRef}
                  style={{ display: 'none' }}
                  onChange={e => uploadAvatar(e.target.files[0])}
                />
              )}
              <div className="profile-username">@{username}</div>
              <div className="profile-joined">
  Joined {profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : ''}
</div>
{readOnly && (
  <div className="profile-lastseen">
    Last seen {profile?.lastSeen ? formatLastSeen(profile.lastSeen) : 'a while ago'}
  </div>
)}
            </div>

            <div className="profile-fields">
              <label>Display Name</label>
              {readOnly ? (
                <p style={{ fontSize: '14px', color: '#1d1d1f', padding: '4px 0' }}>
                  {displayName || 'No display name set'}
                </p>
              ) : (
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Your display name"
                />
              )}

              <label>Bio</label>
              {readOnly ? (
                <p style={{ fontSize: '14px', color: '#6e6e73', padding: '4px 0' }}>
                  {bio || 'No bio yet'}
                </p>
              ) : (
                <textarea
                  value={bio}
                  onChange={e => setBio(e.target.value)}
                  placeholder="Tell people about yourself..."
                  rows={3}
                />
              )}

              <label>Status</label>
              {readOnly ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px' }}>
                  <span style={{ color: statusColors[status] }}>в—Џ</span>
                  <span style={{ color: '#1d1d1f', textTransform: 'capitalize' }}>{status}</span>
                </div>
              ) : (
                <div className="status-options">
                  {['online', 'away', 'busy', 'invisible'].map(s => (
                    <button
                      key={s}
                      className={`status-btn ${status === s ? 'active' : ''}`}
                      onClick={() => setStatus(s)}
                    >
                      <span style={{ color: statusColors[s] }}>в—Џ</span> {s}
                    </button>
                  ))}
                </div>
              )}

              {message && <p className="profile-message">{message}</p>}
              {!readOnly && (
                <button className="profile-save-btn" onClick={saveProfile}>
                  Save Changes
                </button>
              )}
            </div>
          </div>
        )}

        {!readOnly && activeTab === 'security' && (
          <div className="profile-content">
            <div className="profile-fields">
              <label>Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
              />

              <label>New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Enter new password"
              />

              {message && <p className="profile-message">{message}</p>}
              <button className="profile-save-btn" onClick={changePassword}>
                Change Password
              </button>
            </div>
          </div>
        )}

        {!readOnly && activeTab === 'stickers' && (
          <div className="profile-content">
            <div className="sticker-manager">
              <div className="sticker-manager-header">
                <span className="sticker-manager-title">My Stickers</span>
                <button
                  className="sticker-add-btn"
                  onClick={() => stickerInputRef.current.click()}
                >
                  + Add Sticker
                </button>
                <input
                  type="file"
                  accept="image/*"
                  ref={stickerInputRef}
                  style={{ display: 'none' }}
                  onChange={e => uploadSticker(e.target.files[0])}
                />
              </div>
              {stickerMsg && <p className="profile-message">{stickerMsg}</p>}
              {stickers.length === 0 ? (
                <p className="sticker-empty">No stickers yet. Add some!</p>
              ) : (
                <div className="sticker-manage-grid">
                  {stickers.map(s => (
                    <div key={s._id} className="sticker-manage-item">
                      <img src={s.imageUrl} alt="sticker" />
                      <button
                        className="sticker-manage-delete"
                        onClick={() => deleteSticker(s._id)}
                        aria-label="Delete sticker"
                      >вњ•</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Profile;
