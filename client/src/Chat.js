import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import EmojiPicker from 'emoji-picker-react';
import Profile from './Profile';

const socket = io(process.env.REACT_APP_SERVER_URL);
const DEFAULT_ROOMS = ['general', 'random', 'tech'];

function fmtDuration(secs) {
  const s = Math.floor(secs || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const URL_RE = /https?:\/\/\S+/gi;

function extractFirstUrl(text) {
  if (!text) return null;
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[0].replace(/[.,;!?)"']+$/, '');
}

function linkifyText(text) {
  if (!text) return text;
  const parts = text.split(/(https?:\/\/\S+)/gi);
  return parts.map((part, i) => {
    if (/^https?:\/\//i.test(part)) {
      const href = part.replace(/[.,;!?)"']+$/, '');
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="msg-link"
          onDoubleClick={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

function renderTextContent(text, mentions, currentUsername) {
  if (!text) return text;
  const validMentions = (mentions || []);
  if (validMentions.length === 0) return linkifyText(text);

  // Sort longest-first so "@alice123" doesn't partially match "@alice"
  const escaped = [...validMentions]
    .sort((a, b) => b.length - a.length)
    .map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(@(?:${escaped.join('|')})(?=\\W|$))`, 'g'));

  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('@') && validMentions.some(m => part === '@' + m)) {
      const user = part.slice(1);
      return (
        <span key={i} className={`mention-chip${user === currentUsername ? ' mention-chip-self' : ''}`}>
          {part}
        </span>
      );
    }
    const linked = linkifyText(part);
    return <React.Fragment key={i}>{linked}</React.Fragment>;
  });
}

function VoicePlayer({ src, duration: msgDuration }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(msgDuration || 0);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    playing ? a.pause() : a.play().catch(() => {});
  };

  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !totalDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - rect.left) / rect.width) * totalDuration;
  };

  return (
    <div className="voice-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          if (audioRef.current) audioRef.current.currentTime = 0;
          setCurrentTime(0);
        }}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => {
          const d = audioRef.current?.duration;
          if (d && isFinite(d)) setTotalDuration(d);
        }}
      />
      <button
        className="voice-play-btn"
        onClick={toggle}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        <i className={`ti ${playing ? 'ti-player-pause-filled' : 'ti-player-play-filled'}`} aria-hidden="true" />
      </button>
      <div className="voice-progress-wrap">
        <div
          className="voice-progress-bar"
          onClick={seek}
          role="slider"
          aria-label="Voice message playback position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={totalDuration > 0 ? Math.round((currentTime / totalDuration) * 100) : 0}
        >
          <div
            className="voice-progress-fill"
            style={{ width: totalDuration > 0 ? `${(currentTime / totalDuration) * 100}%` : '0%' }}
          />
        </div>
        <span className="voice-time">
          {playing || currentTime > 0 ? fmtDuration(currentTime) : fmtDuration(totalDuration)}
        </span>
      </div>
    </div>
  );
}

function formatDMTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const d = new Date(dateStr);
  const diffMins = Math.floor((now - d) / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Avatar({ username, avatarUrl, size = 26 }) {
  const initials = (username || '?').slice(0, 2).toUpperCase();
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0 };
  if (avatarUrl) {
    return <img src={avatarUrl} alt={username} style={{ ...base, objectFit: 'cover' }} />;
  }
  return (
    <div style={{
      ...base,
      background: '#1d1d1f',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.max(7, Math.round(size * 0.38)),
      fontWeight: 600, color: 'white', letterSpacing: '0.3px',
    }}>
      {initials}
    </div>
  );
}

function Chat({ username, onLogout }) {
  const [roomDescriptions, setRoomDescriptions] = useState({});
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState('');
  const fileShareRef = useRef(null);
  const [pinnedMessages, setPinnedMessages] = useState({});
  const [showPinned, setShowPinned] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);

  // Feature 1: notification sound
  const audioCtxRef = useRef(null);
  const soundMutedRef = useRef(localStorage.getItem('ichat-muted') === 'true');
  const [soundMuted, setSoundMuted] = useState(soundMutedRef.current);

  // Feature 2: message forwarding
  const [forwardingMsg, setForwardingMsg] = useState(null);

  // Feature 3: DM user search
  const [dmSearchOpen, setDmSearchOpen] = useState(false);
  const [dmSearchQuery, setDmSearchQuery] = useState('');
  const [showProfile, setShowProfile] = useState(false);
  const [viewingProfile, setViewingProfile] = useState(null);
  const [userStatuses, setUserStatuses] = useState({});
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const messagesContainerRef = useRef(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [lightboxImg, setLightboxImg] = useState('');
  const [activeReactionMsg, setActiveReactionMsg] = useState('');
  const [activeActionMenu, setActiveActionMenu] = useState('');
  const [actionMenuUpward, setActionMenuUpward] = useState(true);
  const [editingMsg, setEditingMsg] = useState('');
  const [editText, setEditText] = useState('');
  const fileInputRef = useRef(null);
  const messageRefs = useRef({});
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTab, setPickerTab] = useState('emoji');
  const [showAttach, setShowAttach] = useState(false);
  const [userStickers, setUserStickers] = useState([]);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [typingUser, setTypingUser] = useState('');
  const [dmTypingUser, setDmTypingUser] = useState('');
  const [rooms, setRooms] = useState(['general', 'random', 'tech']);
  const [currentRoom, setCurrentRoom] = useState('general');
  const [newRoomName, setNewRoomName] = useState('');
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [renamingRoom, setRenamingRoom] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [activeDM, setActiveDM] = useState(null);
  const [dmMessages, setDmMessages] = useState({});
  const [lastDMMessages, setLastDMMessages] = useState({});
  const [unreadCounts, setUnreadCounts] = useState({});
  const messagesEndRef = useRef(null);
  const prevMessageCount = useRef(0);
  // Refs so socket event handlers always see the latest room/DM without stale closures
  const currentRoomRef = useRef('general');
  const activeDMRef = useRef(null);
  // Holds a message _id to scroll to after a room/DM switch triggered by starred-message navigation
  const pendingScrollRef = useRef(null);

  // Starred / saved messages
  const [showStarred, setShowStarred] = useState(false);
  const [starredMsgs, setStarredMsgs] = useState([]);

  // Link previews — keyed by URL string, value is preview object or null (failed)
  const [linkPreviews, setLinkPreviews] = useState({});
  const fetchedUrlsRef = useRef(new Set());

  // Double-tap heart reaction
  const [poppingHeart, setPoppingHeart] = useState('');

  // View-once images
  const [pendingImage, setPendingImage] = useState(null); // { file, preview }
  const [pendingImageViewOnce, setPendingImageViewOnce] = useState(false);
  const [lightboxViewOnce, setLightboxViewOnce] = useState(false);

  // @mention autocomplete
  const [mentionCandidates, setMentionCandidates] = useState([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const messageInputRef = useRef(null);

  // Voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [micError, setMicError] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingIntervalRef = useRef(null);
  const recordingStartRef = useRef(0);

  // Feature: Polls
  const [polls, setPolls] = useState({});
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);

  // Feature: Scheduled Messages
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleMsgText, setScheduleMsgText] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [scheduledMsgs, setScheduledMsgs] = useState([]);

  // Feature: WebRTC Calls
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callCameraOff, setCallCameraOff] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const peerConnectionRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const callTimerRef = useRef(null);

  const statusColors = {
    online: '#34c759',
    away: '#ff9500',
    busy: '#ff3b30',
    invisible: '#b0b0b5'
  };

  useEffect(() => {
    socket.emit('join', username);
    requestNotificationPermission();
    loadStickers();
    fetch('process.env.REACT_APP_SERVER_URL/api/profile')
      .then(r => r.json())
      .then(data => {
        const users = Array.isArray(data) ? data : [];
        setAllUsers(users);
        const dmIds = users
          .filter(u => u.username !== username)
          .map(u => [username, u.username].sort().join('_'));
        if (dmIds.length > 0) socket.emit('getLastMessages', dmIds);
      })
      .catch(() => {});
    socket.on('previousMessages', (msgs) => {
      setMessages(msgs);
      if (pendingScrollRef.current) {
        const id = pendingScrollRef.current;
        pendingScrollRef.current = null;
        setTimeout(() => scrollToMessage(id), 300);
      }
    });
    socket.on('message', (msg) => {
      const isViewingRoom = msg.room === currentRoomRef.current && !activeDMRef.current;
      if (isViewingRoom) {
        setMessages(prev => [...prev, msg]);
        if (msg.username !== username) {
          socket.emit('markRoomRead', { room: msg.room, reader: username });
        }
      } else if (msg.username !== username) {
        setUnreadCounts(prev => ({
          ...prev,
          [msg.room]: (prev[msg.room] || 0) + 1
        }));
      }
      if (msg.username !== username && !(msg.mentions || []).includes(username)) {
        sendNotification(`${msg.username}`, msg.text || (msg.stickerUrl ? '🎭 Sticker' : '📷 Image'));
        if (!isViewingRoom) playNotificationSound();
      }
    });
    socket.on('messagePinned', (msg) => {
      setPinnedMessages(prev => ({
        ...prev,
        [msg.room]: [...(prev[msg.room] || []).filter(m => m.messageId !== msg.messageId), msg]
      }));
    });
    socket.on('messageUnpinned', ({ messageId, room }) => {
      setPinnedMessages(prev => ({
        ...prev,
        [room]: (prev[room] || []).filter(m => m.messageId !== messageId)
      }));
    });
    socket.on('onlineUsers', (users) => setOnlineUsers(users));
    socket.on('roomsList', (roomsList) => setRooms(roomsList));
    socket.on('typing', (user) => setTypingUser(user));
    socket.on('stopTyping', () => setTypingUser(''));
    socket.on('dmTyping', ({ fromUser, dmId }) => {
      if (activeDMRef.current && activeDMRef.current.dmId === dmId) {
        setDmTypingUser(fromUser);
      }
    });
    socket.on('dmStopTyping', ({ dmId }) => {
      if (activeDMRef.current && activeDMRef.current.dmId === dmId) {
        setDmTypingUser('');
      }
    });
    socket.on('userStatus', ({ username: u, status }) => {
      setUserStatuses(prev => ({ ...prev, [u]: status }));
    });
    socket.on('reactionUpdate', ({ messageId, reactions }) => {
      setMessages(prev => prev.map(msg =>
        msg._id === messageId ? { ...msg, reactions } : msg
      ));
      setDmMessages(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(dmId => {
          updated[dmId] = updated[dmId].map(msg =>
            msg._id === messageId ? { ...msg, reactions } : msg
          );
        });
        return updated;
      });
    });
    socket.on('dmMessages', ({ dmId, messages: msgs }) => {
      setDmMessages(prev => ({ ...prev, [dmId]: msgs }));
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        setLastDMMessages(prev => ({
          ...prev,
          [dmId]: { username: last.username, text: last.text, imageUrl: last.imageUrl, fileUrl: last.fileUrl, fileType: last.fileType, stickerUrl: last.stickerUrl, viewOnce: last.viewOnce, createdAt: last.createdAt }
        }));
      }
      socket.emit('markDMRead', { dmId, reader: username });
      if (pendingScrollRef.current) {
        const id = pendingScrollRef.current;
        pendingScrollRef.current = null;
        setTimeout(() => scrollToMessage(id), 300);
      }
    });
    socket.on('dmMessage', (msg) => {
      setDmMessages(prev => ({
        ...prev,
        [msg.dmId]: [...(prev[msg.dmId] || []), msg]
      }));
      setLastDMMessages(prev => ({
        ...prev,
        [msg.dmId]: { username: msg.username, text: msg.text, imageUrl: msg.imageUrl, fileUrl: msg.fileUrl, fileType: msg.fileType, stickerUrl: msg.stickerUrl, viewOnce: msg.viewOnce, createdAt: msg.createdAt }
      }));
      if (msg.username !== username) {
        if (activeDMRef.current && activeDMRef.current.dmId === msg.dmId) {
          // DM is open — mark it read immediately
          socket.emit('markDMRead', { dmId: msg.dmId, reader: username });
        } else {
          setUnreadCounts(prev => ({
            ...prev,
            [msg.dmId]: (prev[msg.dmId] || 0) + 1
          }));
          playNotificationSound();
        }
        sendNotification(`💬 ${msg.username}`, msg.text || (msg.stickerUrl ? '🎭 Sticker' : '📷 Image'));
      }
    });
    socket.on('dmRead', ({ dmId, reader }) => {
      // Add reader to readBy for every message they didn't send in this DM
      setDmMessages(prev => {
        if (!prev[dmId]) return prev;
        return {
          ...prev,
          [dmId]: prev[dmId].map(msg =>
            msg.username !== reader
              ? { ...msg, readBy: [...new Set([...(msg.readBy || []), reader])] }
              : msg
          )
        };
      });
    });
    socket.on('messageEdited', ({ messageId, newText, edited }) => {
      setMessages(prev => prev.map(msg =>
        msg._id === messageId ? { ...msg, text: newText, edited } : msg
      ));
      setDmMessages(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(dmId => {
          updated[dmId] = updated[dmId].map(msg =>
            msg._id === messageId ? { ...msg, text: newText, edited } : msg
          );
        });
        return updated;
      });
    });
    socket.on('roomDescriptions', (descriptions) => {
  setRoomDescriptions(descriptions);
});
socket.on('roomDescriptionUpdated', ({ room, description }) => {
  setRoomDescriptions(prev => ({ ...prev, [room]: description }));
});
    socket.on('messageDeleted', ({ messageId }) => {
      setMessages(prev => prev.filter(msg => msg._id !== messageId));
      setDmMessages(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(dmId => {
          updated[dmId] = updated[dmId].filter(msg => msg._id !== messageId);
        });
        return updated;
      });
    });
    socket.on('starUpdated', ({ messageId, starred }) => {
      const toggle = (arr) => arr.map(m => {
        if (m._id !== messageId) return m;
        const sb = m.starredBy || [];
        return {
          ...m,
          starredBy: starred
            ? (sb.includes(username) ? sb : [...sb, username])
            : sb.filter(u => u !== username)
        };
      });
      setMessages(prev => toggle(prev));
      setDmMessages(prev => {
        const updated = {};
        Object.keys(prev).forEach(k => { updated[k] = toggle(prev[k]); });
        return updated;
      });
    });
    socket.on('starredMessages', (msgs) => setStarredMsgs(msgs));

    socket.on('viewOnceImageData', ({ imageUrl }) => {
      setLightboxImg(imageUrl);
      setLightboxViewOnce(true);
    });
    socket.on('viewOnceExpired', ({ messageId }) => {
      const expire = (arr) => arr.map(m => m._id === messageId ? { ...m, viewOnceExpired: true } : m);
      setMessages(prev => expire(prev));
      setDmMessages(prev => {
        const updated = {};
        Object.keys(prev).forEach(k => { updated[k] = expire(prev[k]); });
        return updated;
      });
    });

    socket.on('mentioned', ({ from, room, text }) => {
      sendNotification(`${from} mentioned you in #${room}`, text || '');
    });
    socket.on('lastMessages', (msgs) => setLastDMMessages(msgs));

    socket.on('roomMessagesRead', ({ reader, room }) => {
      if (room !== currentRoomRef.current) return;
      setMessages(prev => prev.map(msg => ({
        ...msg,
        readBy: (msg.readBy || []).includes(reader)
          ? msg.readBy
          : [...(msg.readBy || []), reader]
      })));
    });

    // Polls
    socket.on('newPoll', (poll) => {
      setPolls(prev => ({ ...prev, [poll._id]: poll }));
    });
    socket.on('pollsList', (list) => {
      const map = {};
      list.forEach(p => { map[p._id] = p; });
      setPolls(prev => ({ ...prev, ...map }));
    });
    socket.on('pollUpdated', (poll) => {
      setPolls(prev => ({ ...prev, [poll._id]: poll }));
    });

    // Scheduled messages
    socket.on('scheduledMessageCreated', (sm) => {
      setScheduledMsgs(prev => [...prev, sm]);
    });
    socket.on('scheduledMessages', (list) => {
      setScheduledMsgs(list);
    });
    socket.on('scheduledMessageCancelled', ({ scheduledMessageId }) => {
      setScheduledMsgs(prev => prev.filter(m => m._id !== scheduledMessageId));
    });
    socket.on('scheduleError', ({ message: msg }) => {
      alert(msg);
    });

    // WebRTC signaling
    socket.on('incomingCall', ({ from, signal, callType }) => {
      setIncomingCall({ from, signal, callType });
    });
    socket.on('callAccepted', async ({ signal }) => {
      const pc = peerConnectionRef.current;
      if (pc) {
        try { await pc.setRemoteDescription(new RTCSessionDescription(signal)); } catch {}
      }
    });
    socket.on('callRejected', () => {
      endCallCleanup();
    });
    socket.on('callEnded', () => {
      endCallCleanup();
    });
    socket.on('callFailed', ({ message: msg }) => {
      endCallCleanup();
      alert(msg);
    });
    socket.on('iceCandidate', async ({ candidate }) => {
      const pc = peerConnectionRef.current;
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      }
    });

    return () => {
      socket.off('messagePinned');
      socket.off('messageUnpinned');
      socket.off('message');
      socket.off('previousMessages');
      socket.off('onlineUsers');
      socket.off('roomsList');
      socket.off('typing');
      socket.off('stopTyping');
      socket.off('dmTyping');
      socket.off('dmStopTyping');
      socket.off('userStatus');
      socket.off('reactionUpdate');
      socket.off('starUpdated');
      socket.off('starredMessages');
      socket.off('dmMessages');
      socket.off('dmMessage');
      socket.off('dmRead');
      socket.off('messageEdited');
      socket.off('messageDeleted');
      socket.off('roomDescriptions');
      socket.off('roomDescriptionUpdated');
      socket.off('viewOnceImageData');
      socket.off('viewOnceExpired');
      socket.off('mentioned');
      socket.off('lastMessages');
      socket.off('roomMessagesRead');
      socket.off('newPoll');
      socket.off('pollsList');
      socket.off('pollUpdated');
      socket.off('scheduledMessageCreated');
      socket.off('scheduledMessages');
      socket.off('scheduledMessageCancelled');
      socket.off('scheduleError');
      socket.off('incomingCall');
      socket.off('callAccepted');
      socket.off('callRejected');
      socket.off('callEnded');
      socket.off('callFailed');
      socket.off('iceCandidate');
    };
  }, [username]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.msg-menu-wrapper')) setActiveActionMenu('');
      if (!e.target.closest('.emoji-wrapper')) setShowPicker(false);
      if (!e.target.closest('.attach-wrapper')) setShowAttach(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    if (messages.length > prevMessageCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMessageCount.current = messages.length;
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeDM, dmMessages]);

  useEffect(() => {
    const msgs = activeDM ? (dmMessages[activeDM.dmId] || []) : messages;
    msgs.forEach(msg => {
      if (!msg.text) return;
      const url = extractFirstUrl(msg.text);
      if (!url || fetchedUrlsRef.current.has(url)) return;
      fetchedUrlsRef.current.add(url);
      fetch(`process.env.REACT_APP_SERVER_URL/api/link-preview?url=${encodeURIComponent(url)}`)
        .then(r => r.json())
        .then(data => setLinkPreviews(prev => ({ ...prev, [url]: data })))
        .catch(() => setLinkPreviews(prev => ({ ...prev, [url]: null })));
    });
  }, [messages, dmMessages, activeDM]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const requestNotificationPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  };

  const saveDescription = () => {
  socket.emit('setRoomDescription', { room: currentRoom, description: descriptionValue });
  setEditingDescription(false);
};

  const sendNotification = (title, body) => {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body, icon: '/favicon.ico' });
    }
  };

  const joinRoom = (room) => {
    setCurrentRoom(room);
    currentRoomRef.current = room;
    setActiveDM(null);
    activeDMRef.current = null;
    setDmTypingUser('');
    setShowPicker(false);
    setShowAttach(false);
    setMessages([]);
    setUnreadCounts(prev => ({ ...prev, [room]: 0 }));
    socket.emit('joinRoom', room);
    socket.emit('getPolls', { room });
  };

  const openDM = (toUser) => {
    if (toUser === username) return;
    const dmId = [username, toUser].sort().join('_');
    setActiveDM({ toUser, dmId });
    activeDMRef.current = { toUser, dmId };
    setDmTypingUser('');
    setShowPicker(false);
    setShowAttach(false);
    setUnreadCounts(prev => ({ ...prev, [dmId]: 0 }));
    socket.emit('openDM', { fromUser: username, toUser });
    socket.emit('getPolls', { dmId });
  };

  const createRoom = () => {
    if (newRoomName.trim() === '') return;
    const roomName = newRoomName.toLowerCase().replace(/\s+/g, '-');
    socket.emit('createRoom', roomName);
    joinRoom(roomName);
    setNewRoomName('');
    setShowNewRoom(false);
  };

  const deleteRoom = (room) => {
    if (currentRoom === room) joinRoom('general');
    socket.emit('deleteRoom', room);
  };

  const startRename = (room) => {
    setRenamingRoom(room);
    setRenameValue(room);
  };

  const confirmRename = () => {
    if (renameValue.trim() === '') return;
    const newName = renameValue.toLowerCase().replace(/\s+/g, '-');
    socket.emit('renameRoom', { oldName: renamingRoom, newName });
    if (currentRoom === renamingRoom) setCurrentRoom(newName);
    setRenamingRoom('');
    setRenameValue('');
  };

  const sendMessage = () => {
    const trimmed = message.trim();
    if (trimmed === '') return;
    if (activeDM) {
      socket.emit('dmMessage', {
        fromUser: username,
        toUser: activeDM.toUser,
        text: trimmed,
        replyTo: replyingTo ? {
          messageId: replyingTo._id,
          username: replyingTo.username,
          text: replyingTo.text,
          imageUrl: replyingTo.imageUrl
        } : null
      });
    } else {
      socket.emit('message', {
        username,
        text: trimmed,
        replyTo: replyingTo ? {
          messageId: replyingTo._id,
          username: replyingTo.username,
          text: replyingTo.text,
          imageUrl: replyingTo.imageUrl
        } : null
      });
      socket.emit('stopTyping');
    }
    setMessage('');
    setReplyingTo(null);
  };

  const sendImage = async (file, viewOnce = false) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('process.env.REACT_APP_SERVER_URL/api/upload/image', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (data.imageUrl) {
        if (activeDMRef.current) {
          socket.emit('dmMessage', {
            fromUser: username,
            toUser: activeDMRef.current.toUser,
            imageUrl: data.imageUrl,
            viewOnce
          });
        } else {
          socket.emit('message', { username, text: '', imageUrl: data.imageUrl, viewOnce });
        }
      }
    } catch (err) {
      console.error('Image upload failed:', err);
    }
  };

  const loadStickers = () => {
    fetch(`process.env.REACT_APP_SERVER_URL/api/stickers/${username}`)
      .then(r => r.json())
      .then(data => setUserStickers(Array.isArray(data) ? data : []))
      .catch(() => {});
  };

  const sendSticker = (stickerUrl) => {
    if (activeDMRef.current) {
      socket.emit('dmMessage', {
        fromUser: username,
        toUser: activeDMRef.current.toUser,
        stickerUrl
      });
    } else {
      socket.emit('message', { username, text: '', stickerUrl });
    }
    setShowPicker(false);
  };

  const handleImageSelect = (file) => {
    if (!file) return;
    const preview = URL.createObjectURL(file);
    setPendingImage({ file, preview });
    setPendingImageViewOnce(false);
  };

  const confirmSendImage = () => {
    const { file } = pendingImage;
    const vo = pendingImageViewOnce;
    URL.revokeObjectURL(pendingImage.preview);
    setPendingImage(null);
    setPendingImageViewOnce(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    sendImage(file, vo);
  };

  const cancelPendingImage = () => {
    URL.revokeObjectURL(pendingImage.preview);
    setPendingImage(null);
    setPendingImageViewOnce(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const requestViewOnceImage = (messageId) => {
    socket.emit('viewOnceImage', { messageId });
  };

  const sendFile = async (file) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('process.env.REACT_APP_SERVER_URL/api/upload/file', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (data.fileUrl) {
        if (activeDM) {
          socket.emit('dmMessage', {
            fromUser: username,
            toUser: activeDM.toUser,
            text: '',
            fileUrl: data.fileUrl,
            fileName: data.fileName,
            fileSize: data.fileSize,
            fileType: data.fileType
          });
        } else {
          socket.emit('message', {
            username,
            text: '',
            fileUrl: data.fileUrl,
            fileName: data.fileName,
            fileSize: data.fileSize,
            fileType: data.fileType
          });
        }
      }
    } catch (err) {
      console.error('File upload failed:', err);
    }
  };

  const sendVoice = async (blob, duration) => {
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
    const formData = new FormData();
    formData.append('file', blob, `voice_${Date.now()}.${ext}`);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('process.env.REACT_APP_SERVER_URL/api/upload/file', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (data.fileUrl) {
        const replyPayload = replyingTo ? {
          messageId: replyingTo._id,
          username: replyingTo.username,
          text: replyingTo.text,
          imageUrl: replyingTo.imageUrl
        } : null;
        const base = {
          text: '',
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          fileSize: data.fileSize,
          fileType: data.fileType,
          duration,
          replyTo: replyPayload
        };
        if (activeDMRef.current) {
          socket.emit('dmMessage', { fromUser: username, toUser: activeDMRef.current.toUser, ...base });
        } else {
          socket.emit('message', { username, ...base });
        }
        setReplyingTo(null);
      }
    } catch (err) {
      console.error('Voice upload failed:', err);
    }
  };

  const startRecording = async () => {
    setMicError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.start();
      mediaRecorderRef.current = recorder;
      recordingStartRef.current = Date.now();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingIntervalRef.current = setInterval(
        () => setRecordingSeconds(s => s + 1),
        1000
      );
    } catch {
      setMicError('Microphone access denied');
      setTimeout(() => setMicError(''), 3000);
    }
  };

  const stopRecording = (send) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    clearInterval(recordingIntervalRef.current);
    setIsRecording(false);
    setRecordingSeconds(0);
    const durationSecs = Math.max(1, Math.round((Date.now() - recordingStartRef.current) / 1000));
    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach(t => t.stop());
      if (send) {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        await sendVoice(blob, durationSecs);
      }
      mediaRecorderRef.current = null;
    };
    recorder.stop();
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const addReaction = (messageId, emoji) => {
    socket.emit('reaction', { messageId, emoji, username });
  };

  const handleDoubleClick = (msgId) => {
    addReaction(msgId, '❤️');
    setPoppingHeart(msgId);
    setTimeout(() => setPoppingHeart(prev => prev === msgId ? '' : prev), 700);
  };

  const editMessage = (messageId, newText) => {
    if (newText.trim() === '') return;
    socket.emit('editMessage', { messageId, newText });
    setEditingMsg('');
    setEditText('');
  };

  const deleteMessage = (messageId) => {
    socket.emit('deleteMessage', { messageId });
  };

  const pinMessage = (messageId) => {
    socket.emit('pinMessage', { messageId });
  };

  const unpinMessage = (messageId) => {
    socket.emit('unpinMessage', { messageId });
  };

  const toggleStar = (messageId) => {
    socket.emit('toggleStar', { messageId });
  };

  const navigateToStarred = (msg) => {
    setShowStarred(false);
    if (msg.isDM) {
      const otherUser = msg.dmId.split('_').find(u => u !== username);
      if (activeDMRef.current && activeDMRef.current.dmId === msg.dmId) {
        scrollToMessage(msg._id);
      } else {
        pendingScrollRef.current = msg._id;
        openDM(otherUser);
      }
    } else {
      if (!activeDMRef.current && currentRoomRef.current === msg.room) {
        scrollToMessage(msg._id);
      } else {
        pendingScrollRef.current = msg._id;
        joinRoom(msg.room);
      }
    }
  };

  const handleSearch = (query) => {
    setSearchQuery(query);
    if (query.trim() === '') {
      setSearchResults([]);
      return;
    }
    const results = messages.filter(msg =>
      msg.text && msg.text.toLowerCase().includes(query.toLowerCase())
    );
    setSearchResults(results);
  };

  const scrollToMessage = (msgId) => {
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    setTimeout(() => {
      const el = messageRefs.current[msgId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-message');
        setTimeout(() => el.classList.remove('highlight-message'), 3000);
      }
    }, 100);
  };

  const insertMention = (selectedUser) => {
    const input = messageInputRef.current;
    if (!input) return;
    const cursor = input.selectionStart;
    const upToCursor = message.slice(0, cursor);
    const match = upToCursor.match(/@(\w*)$/);
    if (!match) return;
    const atStart = cursor - match[0].length;
    const newText = message.slice(0, atStart) + '@' + selectedUser + ' ' + message.slice(cursor);
    setMessage(newText);
    setMentionCandidates([]);
    setMentionIndex(0);
    const newCursor = atStart + selectedUser.length + 2;
    setTimeout(() => { input.focus(); input.setSelectionRange(newCursor, newCursor); }, 0);
  };

  const handleMessageChange = (e) => {
    const val = e.target.value;
    setMessage(val);
    if (activeDM) return;
    const cursor = e.target.selectionStart;
    const upToCursor = val.slice(0, cursor);
    const match = upToCursor.match(/@(\w*)$/);
    if (match) {
      const query = match[1].toLowerCase();
      const candidates = onlineUsers
        .filter(u => u !== username && u.toLowerCase().startsWith(query))
        .slice(0, 6);
      setMentionCandidates(candidates);
      setMentionIndex(0);
    } else if (mentionCandidates.length > 0) {
      setMentionCandidates([]);
    }
  };

  const handleKeyDown = (e) => {
    if (mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, mentionCandidates.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter')     { e.preventDefault(); insertMention(mentionCandidates[mentionIndex]); return; }
      if (e.key === 'Escape')    { setMentionCandidates([]); return; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    } else {
      if (activeDM) {
        socket.emit('dmTyping', { fromUser: username, dmId: activeDM.dmId });
        clearTimeout(window.dmTypingTimeout);
        window.dmTypingTimeout = setTimeout(() => socket.emit('dmStopTyping', { dmId: activeDM.dmId }), 1500);
      } else {
        socket.emit('typing', username);
        clearTimeout(window.typingTimeout);
        window.typingTimeout = setTimeout(() => socket.emit('stopTyping'), 1500);
      }
    }
  };

  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    setShowScrollBtn(!isNearBottom);
  };

  const getStatusColor = (user) => {
    const status = userStatuses[user] || 'online';
    return statusColors[status] || '#34c759';
  };

  const getUserAvatar = (uname) => allUsers.find(u => u.username === uname)?.avatar || '';

  const getDMPreview = (msg) => {
    if (!msg) return '';
    const prefix = msg.username === username ? 'You: ' : '';
    if (msg.viewOnce) return `${prefix}🔥 View once`;
    if (msg.stickerUrl) return `${prefix}🎨 Sticker`;
    if (msg.imageUrl) return `${prefix}📷 Photo`;
    if (msg.fileUrl && msg.fileType?.startsWith('audio/')) return `${prefix}🎤 Voice message`;
    if (msg.fileUrl) return `${prefix}📎 File`;
    return `${prefix}${msg.text || ''}`;
  };

  const playNotificationSound = () => {
    if (soundMutedRef.current) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      // Three-note ascending major arpeggio: C6 → E6 → G6
      // Triangle wave is warmer/softer than sine — closer to iMessage character
      const notes = [
        { freq: 1046.50, startOffset: 0,    duration: 0.18 }, // C6
        { freq: 1318.51, startOffset: 0.11, duration: 0.18 }, // E6
        { freq: 1567.98, startOffset: 0.22, duration: 0.25 }, // G6 — held slightly longer
      ];

      notes.forEach(({ freq, startOffset, duration }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + startOffset);
        // Soft attack (1ms), smooth exponential decay
        gain.gain.setValueAtTime(0, ctx.currentTime + startOffset);
        gain.gain.linearRampToValueAtTime(0.28, ctx.currentTime + startOffset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startOffset + duration);
        osc.start(ctx.currentTime + startOffset);
        osc.stop(ctx.currentTime + startOffset + duration);
      });
    } catch {}
  };

  const toggleMute = () => {
    const next = !soundMutedRef.current;
    soundMutedRef.current = next;
    setSoundMuted(next);
    localStorage.setItem('ichat-muted', next);
  };

  const forwardMessage = (msg, destination) => {
    const content = {
      text: msg.text || '',
      imageUrl: msg.imageUrl || '',
      fileUrl: msg.fileUrl || '',
      fileName: msg.fileName || '',
      fileSize: msg.fileSize || 0,
      fileType: msg.fileType || '',
      stickerUrl: msg.stickerUrl || '',
    };
    if (destination.type === 'room') {
      socket.emit('message', { username, ...content, targetRoom: destination.room });
    } else {
      socket.emit('dmMessage', { fromUser: username, toUser: destination.toUser, ...content });
    }
    setForwardingMsg(null);
  };

  const formatRoomSeenBy = (readers) => {
    if (readers.length === 0) return '';
    if (readers.length <= 2) return `Seen by ${readers.join(', ')}`;
    return `Seen by ${readers.length}`;
  };

  // ---- Poll helpers ----
  const createPoll = () => {
    const opts = pollOptions.map(o => o.trim()).filter(Boolean);
    if (!pollQuestion.trim() || opts.length < 2) return;
    socket.emit('createPoll', {
      question: pollQuestion.trim(),
      options: opts,
      ...(activeDM ? { dmId: activeDM.dmId } : { room: currentRoom })
    });
    setShowPollModal(false);
    setPollQuestion('');
    setPollOptions(['', '']);
  };

  const votePoll = (pollId, optionIndex) => {
    socket.emit('votePoll', { pollId, optionIndex, username });
  };

  // ---- Schedule helpers ----
  const createScheduledMessage = () => {
    if (!scheduleMsgText.trim() || !scheduleTime) return;
    socket.emit('scheduleMessage', {
      username,
      text: scheduleMsgText.trim(),
      scheduledFor: new Date(scheduleTime).toISOString(),
      ...(activeDM ? { dmId: activeDM.dmId, toUser: activeDM.toUser } : { room: currentRoom })
    });
    socket.emit('getScheduledMessages', { username });
    setShowScheduleModal(false);
    setScheduleMsgText('');
    setScheduleTime('');
  };

  const cancelScheduledMessage = (id) => {
    socket.emit('cancelScheduledMessage', { scheduledMessageId: id, username });
  };

  const openScheduleModal = () => {
    setShowScheduleModal(true);
    setShowAttach(false);
    socket.emit('getScheduledMessages', { username });
  };

  const minDateTime = () => {
    const d = new Date(Date.now() + 2 * 60 * 1000);
    return d.toISOString().slice(0, 16);
  };

  // ---- WebRTC helpers ----
  const endCallCleanup = () => {
    if (peerConnectionRef.current) { peerConnectionRef.current.close(); peerConnectionRef.current = null; }
    if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null; }
    setLocalStream(prev => { if (prev) prev.getTracks().forEach(t => t.stop()); return null; });
    setRemoteStream(null);
    setActiveCall(null);
    setCallDuration(0);
    setCallMuted(false);
    setCallCameraOff(false);
  };

  const startCall = async (callType) => {
    if (!activeDM) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        callType === 'video' ? { video: true, audio: true } : { video: false, audio: true }
      );
      setLocalStream(stream);
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      peerConnectionRef.current = pc;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.ontrack = (e) => setRemoteStream(e.streams[0]);
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('iceCandidate', { to: activeDM.toUser, candidate: e.candidate });
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      setActiveCall({ peerUsername: activeDM.toUser, callType });
      socket.emit('callUser', { to: activeDM.toUser, from: username, signal: offer, callType });
      callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('Camera/microphone access denied. Please allow access in your browser and try again.');
      }
      endCallCleanup();
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;
    const callerName = incomingCall.from;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        incomingCall.callType === 'video' ? { video: true, audio: true } : { video: false, audio: true }
      );
      setLocalStream(stream);
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      peerConnectionRef.current = pc;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.ontrack = (e) => setRemoteStream(e.streams[0]);
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('iceCandidate', { to: callerName, candidate: e.candidate });
      };
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answerCall', { to: callerName, signal: answer });
      setActiveCall({ peerUsername: callerName, callType: incomingCall.callType });
      setIncomingCall(null);
      callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('Camera/microphone access denied.');
      }
      socket.emit('rejectCall', { to: callerName });
      setIncomingCall(null);
      endCallCleanup();
    }
  };

  const rejectCall = () => {
    if (incomingCall) { socket.emit('rejectCall', { to: incomingCall.from }); setIncomingCall(null); }
  };

  const hangUp = () => {
    if (activeCall) socket.emit('endCall', { to: activeCall.peerUsername });
    endCallCleanup();
  };

  const toggleMuteCall = () => {
    if (localStream) { localStream.getAudioTracks().forEach(t => { t.enabled = !t.enabled; }); setCallMuted(m => !m); }
  };

  const toggleCamera = () => {
    if (localStream) { localStream.getVideoTracks().forEach(t => { t.enabled = !t.enabled; }); setCallCameraOff(c => !c); }
  };

  const fmtCallDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const initials = username.slice(0, 2).toUpperCase();
  const currentMessages = activeDM ? (dmMessages[activeDM.dmId] || []) : messages;

  // The last message the current user sent in this DM that the other party has read
  const lastSeenMsg = activeDM
    ? [...currentMessages].reverse().find(
        m => m.username === username && (m.readBy || []).includes(activeDM.toUser)
      )
    : null;
  const lastSeenMsgId = lastSeenMsg ? lastSeenMsg._id : null;

  // _id of the last room message sent by the current user (for room read receipts)
  const lastMyRoomMsgId = !activeDM
    ? (currentMessages.filter(m => m.username === username).slice(-1)[0]?._id || null)
    : null;

  // Polls relevant to the current view
  const currentPolls = Object.values(polls).filter(p =>
    activeDM ? p.dmId === activeDM.dmId : (p.room === currentRoom && !p.dmId)
  );

  // Combined message + poll list sorted by createdAt for interleaved rendering
  const combinedItems = [
    ...currentMessages.map(m => ({ type: 'message', item: m, createdAt: m.createdAt })),
    ...currentPolls.map(p => ({ type: 'poll', item: p, createdAt: p.createdAt }))
  ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const currentPinned = activeDM
    ? (pinnedMessages[activeDM.dmId] || [])
    : (pinnedMessages[currentRoom] || []);
  const myStatus = userStatuses[username] || 'online';

  return (
    <div className="chat-container">
      <div className="chat-body">

        <div className="rooms-sidebar">
          <div className="sidebar-top">
            <div className="brand">
              <div className="logo">
                <svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 1.5C4.86 1.5 1.5 4.86 1.5 9c0 1.29.33 2.5.9 3.57L1.5 16.5l3.93-.9A7.44 7.44 0 0 0 9 16.5c4.14 0 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5Z" fill="white" opacity="0.15"/>
                  <path d="M9 1.5C4.86 1.5 1.5 4.86 1.5 9c0 1.29.33 2.5.9 3.57L1.5 16.5l3.93-.9A7.44 7.44 0 0 0 9 16.5c4.14 0 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5Z" stroke="white" strokeWidth="1.2" strokeLinejoin="round"/>
                  <circle cx="6" cy="9" r="1" fill="white"/>
                  <circle cx="9" cy="9" r="1" fill="white"/>
                  <circle cx="12" cy="9" r="1" fill="white"/>
                </svg>
              </div>
              <div className="brand-name">i<span>Chat</span></div>
            </div>
            <div className="user-pill" onClick={() => setShowProfile(true)} style={{ cursor: 'pointer' }}>
              <Avatar username={username} avatarUrl={getUserAvatar(username)} size={26} />
              <div className="user-info">
                <div className="user-name">{username}</div>
                <div className="user-status" style={{ color: getStatusColor(username) }}>
                  ● {myStatus}
                </div>
              </div>
            </div>
          </div>

          <div className="section-label">Rooms</div>
          <ul className="room-list">
            {rooms.map((room, i) => (
              <li key={i} className={!activeDM && currentRoom === room ? 'active-room' : ''}>
                {renamingRoom === room ? (
                  <div className="rename-input">
                    <input
                      type="text"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && confirmRename()}
                      autoFocus
                    />
                    <button onClick={confirmRename}>✓</button>
                    <button onClick={() => setRenamingRoom('')}>✕</button>
                  </div>
                ) : (
                  <div className="room-item">
                    <div className="room-item-left" onClick={() => joinRoom(room)}>
                      <span><span className="room-hash">#</span>{room}</span>
                      {unreadCounts[room] > 0 && (
                        <span className="unread-badge">{unreadCounts[room] > 99 ? '99+' : unreadCounts[room]}</span>
                      )}
                    </div>
                    {!DEFAULT_ROOMS.includes(room) && (
                      <div className="room-actions">
                        <button onClick={() => startRename(room)}>✏️</button>
                        <button onClick={() => deleteRoom(room)}>🗑️</button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {showNewRoom ? (
            <div className="new-room-input">
              <input
                type="text"
                placeholder="room-name"
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createRoom()}
              />
              <button onClick={createRoom}>Add</button>
            </div>
          ) : (
            <button className="add-room-btn" onClick={() => setShowNewRoom(true)}>
              + New Room
            </button>
          )}

          <div className="sidebar-divider" />

          <div className="section-label dm-section-label">
            Direct Messages
            <button
              className="dm-search-btn"
              onClick={() => { setDmSearchOpen(v => !v); setDmSearchQuery(''); }}
              aria-label="Search users"
            >
              <i className="ti ti-search" aria-hidden="true" />
            </button>
          </div>
          {dmSearchOpen && (
            <div className="dm-search-bar">
              <i className="ti ti-search" aria-hidden="true" />
              <input
                type="text"
                placeholder="Find a user…"
                value={dmSearchQuery}
                onChange={e => setDmSearchQuery(e.target.value)}
                autoFocus
                onKeyDown={e => e.key === 'Escape' && setDmSearchOpen(false)}
              />
            </div>
          )}
          {dmSearchOpen && dmSearchQuery && (
            <div className="dm-search-results">
              {allUsers
                .filter(u => u.username !== username && (
                  u.username.toLowerCase().includes(dmSearchQuery.toLowerCase()) ||
                  (u.displayName || '').toLowerCase().includes(dmSearchQuery.toLowerCase())
                ))
                .map(u => (
                  <div
                    key={u.username}
                    className="dm-search-result-item"
                    onClick={() => { openDM(u.username); setDmSearchOpen(false); setDmSearchQuery(''); }}
                  >
                    <Avatar username={u.username} avatarUrl={u.avatar || ''} size={28} />
                    <span>{u.displayName || u.username}</span>
                  </div>
                ))
              }
            </div>
          )}
          <div className="dm-list">
            {allUsers.filter(u => u.username !== username).map((u, i) => {
              const dmId = [username, u.username].sort().join('_');
              const isOnline = onlineUsers.includes(u.username);
              const lastMsg = lastDMMessages[dmId] || null;
              return (
                <div
                  key={i}
                  className={`dm-card${activeDM?.toUser === u.username ? ' active-dm' : ''}`}
                  onClick={() => openDM(u.username)}
                >
                  <div className="avatar-status-wrap">
                    <Avatar username={u.username} avatarUrl={u.avatar || ''} size={40} />
                    <div className="status-dot-overlay" style={{ background: isOnline ? getStatusColor(u.username) : '#b0b0b5' }} />
                  </div>
                  <div className="dm-card-body">
                    <div className="dm-card-top">
                      <span className="dm-card-name">{u.displayName || u.username}</span>
                      {lastMsg && <span className="dm-card-time">{formatDMTime(lastMsg.createdAt)}</span>}
                    </div>
                    <div className="dm-card-bottom">
                      <span className="dm-card-preview">{getDMPreview(lastMsg)}</span>
                      {unreadCounts[dmId] > 0 && (
                        <span className="unread-badge">{unreadCounts[dmId] > 99 ? '99+' : unreadCounts[dmId]}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sidebar-divider" />

          <div className="section-label">Online — {onlineUsers.length}</div>
          <div className="online-list">
            {onlineUsers.map((user, i) => (
              <div
                key={i}
                className="online-item"
                onClick={() => setViewingProfile(user)}
                style={{ cursor: 'pointer' }}
              >
                <div className="avatar-status-wrap">
                  <Avatar username={user} avatarUrl={getUserAvatar(user)} size={22} />
                  <div className="status-dot-overlay" style={{ background: getStatusColor(user) }} />
                </div>
                {user}
              </div>
            ))}
          </div>
        </div>

        <div className="messages-area">
          <div className="chat-header">
            {showStarred && (
              <div className="starred-panel">
                <div className="starred-panel-header">
                  <span><i className="ti ti-star-filled" aria-hidden="true"></i> Saved Messages</span>
                  <button onClick={() => setShowStarred(false)} aria-label="Close saved messages">✕</button>
                </div>
                {starredMsgs.length === 0 ? (
                  <p className="no-starred">No saved messages yet. Save a message with the ⭐ in the action menu.</p>
                ) : (
                  starredMsgs.map((msg) => (
                    <div
                      key={msg._id}
                      className="starred-item"
                      onClick={() => navigateToStarred(msg)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => e.key === 'Enter' && navigateToStarred(msg)}
                    >
                      <div className="starred-item-body">
                        <span className="starred-user">{msg.username}</span>
                        <span className="starred-preview">
                          {msg.viewOnce ? (msg.viewOnceExpired ? '📷 Photo expired' : '📷 View once photo') : msg.stickerUrl ? '🎭 Sticker' : msg.imageUrl ? '📷 Image' : msg.fileType?.startsWith('audio/') ? '🎤 Voice' : msg.text || '📎 File'}
                        </span>
                      </div>
                      <div className="starred-item-meta">
                        <span className="starred-context">
                          {msg.isDM
                            ? `💬 ${msg.dmId.split('_').find(u => u !== username) || msg.dmId}`
                            : `# ${msg.room}`}
                        </span>
                        <span className="starred-time">
                          {new Date(msg.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </span>
                        <button
                          className="starred-remove"
                          aria-label="Remove from saved"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStar(msg._id);
                            setStarredMsgs(prev => prev.filter(m => m._id !== msg._id));
                          }}
                        >
                          <i className="ti ti-x" aria-hidden="true"></i>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            {showPinned && (
              <div className="pinned-panel">
                <div className="pinned-panel-header">
                  <span>📌 Pinned Messages</span>
                  <button onClick={() => setShowPinned(false)}>✕</button>
                </div>
                {currentPinned.length === 0 ? (
                  <p className="no-pinned">No pinned messages yet</p>
                ) : (
                  currentPinned.map((msg, i) => (
                    <div key={i} className="pinned-item" onClick={() => scrollToMessage(msg.messageId)}>
                      <span className="pinned-user">{msg.username}</span>
                      <span className="pinned-text">{msg.imageUrl ? '📷 Image' : msg.text}</span>
                      <button onClick={(e) => { e.stopPropagation(); unpinMessage(msg.messageId); }}>✕</button>
                    </div>
                  ))
                )}
              </div>
            )}
            <div>
              <div
  className="room-title-name"
  style={{ cursor: activeDM ? 'pointer' : 'default', display: activeDM ? 'flex' : undefined, alignItems: activeDM ? 'center' : undefined, gap: activeDM ? '8px' : undefined }}
  onClick={() => activeDM && setViewingProfile(activeDM.toUser)}
>
  {activeDM ? (
    <>
      <Avatar username={activeDM.toUser} avatarUrl={getUserAvatar(activeDM.toUser)} size={28} />
      {allUsers.find(u => u.username === activeDM.toUser)?.displayName || activeDM.toUser}
    </>
  ) : `# ${currentRoom}`}
</div>
              {activeDM ? (
  <div className="room-title-sub">Direct message</div>
) : editingDescription ? (
  <div className="description-edit">
    <input
      type="text"
      value={descriptionValue}
      onChange={e => setDescriptionValue(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && saveDescription()}
      placeholder="Add a room description..."
      autoFocus
    />
    <button onClick={saveDescription}>✓</button>
  </div>
) : (
  <div
    className="room-title-sub clickable"
    onClick={() => {
      setEditingDescription(true);
      setDescriptionValue(roomDescriptions[currentRoom] || '');
    }}
  >
    {roomDescriptions[currentRoom] || 'Add a description...'} · {onlineUsers.length} online
  </div>
)}
            </div>
            <div className="header-right">
              {activeDM && (
                <>
                  <button
                    className="search-toggle-btn"
                    onClick={() => startCall('audio')}
                    aria-label="Voice call"
                    title="Voice call"
                  >
                    <i className="ti ti-phone" aria-hidden="true" />
                  </button>
                  <button
                    className="search-toggle-btn"
                    onClick={() => startCall('video')}
                    aria-label="Video call"
                    title="Video call"
                  >
                    <i className="ti ti-video" aria-hidden="true" />
                  </button>
                </>
              )}
              <button
                className="search-toggle-btn"
                onClick={() => {
                  if (!showStarred) socket.emit('getStarredMessages');
                  setShowStarred(s => !s);
                }}
                aria-label="Saved messages"
              >
                <i className="ti ti-star" aria-hidden="true"></i>
              </button>
              <button
                className="search-toggle-btn"
                onClick={() => setShowPinned(!showPinned)}
                aria-label="Pinned messages"
              >
                <i className="ti ti-pin" aria-hidden="true"></i>
              </button>
              <button
                className="search-toggle-btn"
                onClick={() => setDarkMode(!darkMode)}
                aria-label="Toggle dark mode"
              >
                <i className={`ti ${darkMode ? 'ti-sun' : 'ti-moon'}`} aria-hidden="true"></i>
              </button>
              <button
                className="search-toggle-btn"
                onClick={() => { setShowSearch(!showSearch); setSearchQuery(''); setSearchResults([]); }}
                aria-label="Search"
              >
                <i className="ti ti-search" aria-hidden="true"></i>
              </button>
              <button
                className="search-toggle-btn"
                onClick={toggleMute}
                aria-label={soundMuted ? 'Unmute notifications' : 'Mute notifications'}
                title={soundMuted ? 'Unmute sounds' : 'Mute sounds'}
              >
                <i className={`ti ${soundMuted ? 'ti-bell-off' : 'ti-bell'}`} aria-hidden="true"></i>
              </button>
              <button onClick={onLogout}>Sign out</button>
            </div>
          </div>

          {showSearch && (
            <div className="search-bar">
              <i className="ti ti-search" aria-hidden="true"></i>
              <input
                type="text"
                placeholder="Search messages..."
                value={searchQuery}
                onChange={e => handleSearch(e.target.value)}
                autoFocus
              />
              {searchQuery && <span className="search-count">{searchResults.length} results</span>}
            </div>
          )}

          {showSearch && searchQuery && (
            <div className="search-results">
              {searchResults.length === 0 ? (
                <p className="no-search">No messages found</p>
              ) : (
                searchResults.map((msg, i) => (
                  <div
                    key={i}
                    className="search-result-item"
                    onClick={() => scrollToMessage(msg._id)}
                  >
                    <span className="search-result-user">{msg.username}</span>
                    <span className="search-result-time">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <p className="search-result-text">{msg.text}</p>
                  </div>
                ))
              )}
            </div>
          )}

          <div
            className="messages"
            ref={messagesContainerRef}
            onScroll={handleScroll}
          >
            {combinedItems.length === 0 && (
              <p className="no-messages">
                {activeDM ? `Start a conversation with ${activeDM.toUser}!` : 'No messages yet. Say hello! 👋'}
              </p>
            )}
            {combinedItems.map((item) => {
              if (item.type === 'poll') {
                const poll = item.item;
                const totalVotes = poll.options.reduce((sum, o) => sum + (o.votes || []).length, 0);
                const myVoteIdx = poll.options.findIndex(o => (o.votes || []).includes(username));
                return (
                  <div key={`poll-${poll._id}`} className="poll-card">
                    <div className="poll-header">
                      <i className="ti ti-chart-bar" aria-hidden="true" />
                      <span className="poll-question">{poll.question}</span>
                    </div>
                    <div className="poll-options">
                      {poll.options.map((opt, oi) => {
                        const pct = totalVotes > 0 ? Math.round(((opt.votes || []).length / totalVotes) * 100) : 0;
                        const voted = myVoteIdx === oi;
                        return (
                          <button
                            key={oi}
                            className={`poll-option${voted ? ' poll-option-voted' : ''}`}
                            onClick={() => votePoll(poll._id, oi)}
                          >
                            <div className="poll-option-bar" style={{ width: `${pct}%` }} />
                            <span className="poll-option-text">{opt.text}</span>
                            <span className="poll-option-pct">{pct}%</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="poll-footer">
                      {totalVotes} vote{totalVotes !== 1 ? 's' : ''} · by {poll.createdBy}
                    </div>
                  </div>
                );
              }

              const msg = item.item;
              const msgFirstUrl = msg.text ? extractFirstUrl(msg.text) : null;
              const msgPreview = msgFirstUrl ? linkPreviews[msgFirstUrl] : null;
              return (
              <div
                key={`msg-${msg._id}`}
                ref={el => { messageRefs.current[msg._id] = el; }}
                className={`message-bubble ${msg.username === username ? 'mine' : 'theirs'}${msg.stickerUrl ? ' sticker-message' : ''}${msg.username !== username && (msg.mentions || []).includes(username) ? ' mentioned-bubble' : ''}`}
              >
                <div className="msg-username">
                  {msg.username} · {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                </div>

                <div className="msg-content" onDoubleClick={() => handleDoubleClick(msg._id)}>
                  {msg.replyTo && (
                    <div
                      className="reply-preview"
                      onClick={() => scrollToMessage(msg.replyTo.messageId)}
                      onDoubleClick={e => e.stopPropagation()}
                    >
                      <span className="reply-user">{msg.replyTo.username}</span>
                      {msg.replyTo.imageUrl ? (
                        <span className="reply-text">📷 Image</span>
                      ) : msg.replyTo.text ? (
                        <span className="reply-text">{msg.replyTo.text}</span>
                      ) : (
                        <span className="reply-text">🎤 Voice message</span>
                      )}
                    </div>
                  )}
                  {msg.viewOnce ? (
                    msg.viewOnceExpired ? (
                      <div className="vo-expired">
                        <i className="ti ti-photo-off" aria-hidden="true" />
                        <span>Photo expired</span>
                      </div>
                    ) : msg.username === username ? (
                      <div className="vo-sent">
                        <i className="ti ti-eye-off" aria-hidden="true" />
                        <span>View once · sent</span>
                      </div>
                    ) : (
                      <button className="vo-placeholder" onClick={() => requestViewOnceImage(msg._id)} onDoubleClick={e => e.stopPropagation()}>
                        <i className="ti ti-eye" aria-hidden="true" />
                        <span>Tap to view once</span>
                      </button>
                    )
                  ) : msg.stickerUrl ? (
                    <img
                      src={msg.stickerUrl}
                      alt="sticker"
                      className="msg-sticker"
                      onDoubleClick={e => e.stopPropagation()}
                    />
                  ) : msg.imageUrl ? (
                    <img
                      src={msg.imageUrl}
                      alt="shared"
                      className="msg-image"
                      onClick={() => { setLightboxImg(msg.imageUrl); setLightboxViewOnce(false); }}
                      onDoubleClick={e => e.stopPropagation()}
                    />
                  ) : msg.fileUrl && msg.fileType?.startsWith('audio/') ? (
                    <div onDoubleClick={e => e.stopPropagation()}>
                      <VoicePlayer src={msg.fileUrl} duration={msg.duration} />
                    </div>
                  ) : msg.fileUrl ? (
                    <a
                      href={msg.fileUrl}
                      download={msg.fileName}
                      target="_blank"
                      rel="noreferrer"
                      className="file-attachment"
                      onDoubleClick={e => e.stopPropagation()}
                    >
                      <div className="file-icon">
                        <i className="ti ti-file" aria-hidden="true"></i>
                      </div>
                      <div className="file-info">
                        <span className="file-name">{msg.fileName}</span>
                        <span className="file-size">{formatFileSize(msg.fileSize)}</span>
                      </div>
                      <div className="file-download">
                        <i className="ti ti-download" aria-hidden="true"></i>
                      </div>
                    </a>
                  ) : editingMsg === msg._id ? (
                    <div className="edit-input" onDoubleClick={e => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') editMessage(msg._id, editText);
                          if (e.key === 'Escape') setEditingMsg('');
                        }}
                        autoFocus
                      />
                      <button onClick={() => editMessage(msg._id, editText)}>✓</button>
                      <button onClick={() => setEditingMsg('')}>✕</button>
                    </div>
                  ) : (
                    <>
                      <span className="msg-text">
                        {renderTextContent(msg.text, msg.mentions, username)}
                        {msg.edited && <span className="edited-tag"> (edited)</span>}
                      </span>
                      {msgPreview?.title && (
                        <a
                          href={msgFirstUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="link-preview-card"
                          onDoubleClick={e => e.stopPropagation()}
                          onClick={e => e.stopPropagation()}
                        >
                          {msgPreview.image && (
                            <img src={msgPreview.image} alt="" className="link-preview-img" />
                          )}
                          <div className="link-preview-body">
                            {msgPreview.siteName && (
                              <span className="link-preview-site">{msgPreview.siteName}</span>
                            )}
                            <span className="link-preview-title">{msgPreview.title}</span>
                            {msgPreview.description && (
                              <span className="link-preview-desc">{msgPreview.description}</span>
                            )}
                          </div>
                        </a>
                      )}
                    </>
                  )}
                </div>

                {activeDM && msg._id === lastSeenMsgId && (
                  <span className="seen-indicator">Seen</span>
                )}
                {!activeDM && msg.username === username && msg._id === lastMyRoomMsgId && (() => {
                  const readers = (msg.readBy || []).filter(u => u !== username);
                  return readers.length > 0
                    ? <span className="seen-indicator">{formatRoomSeenBy(readers)}</span>
                    : null;
                })()}

                <div className="reactions-row">
                  {msg.reactions && Object.entries(msg.reactions).map(([emoji, users]) =>
                    users.length > 0 && (
                      <button
                        key={emoji}
                        className={`reaction-btn ${users.includes(username) ? 'reacted' : ''}`}
                        onClick={() => addReaction(msg._id, emoji)}
                      >
                        {emoji} {users.length}
                      </button>
                    )
                  )}
                  <div className="reaction-picker">
                    <button
                      className="add-reaction-btn"
                      onClick={() => setActiveReactionMsg(activeReactionMsg === msg._id ? '' : msg._id)}
                    >+</button>
                    {activeReactionMsg === msg._id && (
                      <div className="reaction-options">
                        {['👍','❤️','😂','😮','😢','🔥','👏','🎉'].map(emoji => (
                          <button
                            key={emoji}
                            onClick={() => {
                              addReaction(msg._id, emoji);
                              setActiveReactionMsg('');
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="msg-menu-wrapper">
                  <button
                    className="msg-menu-trigger"
                    onClick={(e) => {
                      if (activeActionMenu === msg._id) {
                        setActiveActionMenu('');
                      } else {
                        const triggerRect = e.currentTarget.getBoundingClientRect();
                        const containerRect = messagesContainerRef.current.getBoundingClientRect();
                        setActionMenuUpward(triggerRect.top - containerRect.top > 160);
                        setActiveActionMenu(msg._id);
                      }
                    }}
                    aria-label="Message actions"
                  >
                    <i className="ti ti-dots-vertical" aria-hidden="true"></i>
                  </button>
                  {activeActionMenu === msg._id && (
                    <div className={`msg-action-menu${actionMenuUpward ? '' : ' opens-down'}`} role="menu">
                      <button
                        className="msg-action-item"
                        onClick={() => { setReplyingTo(msg); setActiveActionMenu(''); }}
                        aria-label="Reply to message"
                      >
                        <i className="ti ti-arrow-back-up" aria-hidden="true"></i>
                        <span>Reply</span>
                      </button>
                      <button
                        className="msg-action-item"
                        onClick={() => { setForwardingMsg(msg); setActiveActionMenu(''); }}
                        aria-label="Forward message"
                      >
                        <i className="ti ti-share" aria-hidden="true"></i>
                        <span>Forward</span>
                      </button>
                      <button
                        className={`msg-action-item${(msg.starredBy || []).includes(username) ? ' msg-action-starred' : ''}`}
                        onClick={() => { toggleStar(msg._id); setActiveActionMenu(''); }}
                        aria-label={(msg.starredBy || []).includes(username) ? 'Remove from saved' : 'Save message'}
                      >
                        <i className={`ti ${(msg.starredBy || []).includes(username) ? 'ti-star-filled' : 'ti-star'}`} aria-hidden="true"></i>
                        <span>{(msg.starredBy || []).includes(username) ? 'Unsave' : 'Save'}</span>
                      </button>
                      <button
                        className="msg-action-item"
                        onClick={() => { msg.pinned ? unpinMessage(msg._id) : pinMessage(msg._id); setActiveActionMenu(''); }}
                        aria-label={msg.pinned ? 'Unpin message' : 'Pin message'}
                      >
                        <i className={`ti ${msg.pinned ? 'ti-pinned-off' : 'ti-pin'}`} aria-hidden="true"></i>
                        <span>{msg.pinned ? 'Unpin' : 'Pin'}</span>
                      </button>
                      {msg.username === username && (
                        <>
                          <button
                            className="msg-action-item"
                            onClick={() => { setEditingMsg(msg._id); setEditText(msg.text); setActiveActionMenu(''); }}
                            aria-label="Edit message"
                          >
                            <i className="ti ti-pencil" aria-hidden="true"></i>
                            <span>Edit</span>
                          </button>
                          <button
                            className="msg-action-item msg-action-delete"
                            onClick={() => { deleteMessage(msg._id); setActiveActionMenu(''); }}
                            aria-label="Delete message"
                          >
                            <i className="ti ti-trash" aria-hidden="true"></i>
                            <span>Delete</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {poppingHeart === msg._id && (
                  <div className="heart-pop" aria-hidden="true">
                    <i className="ti ti-heart-filled" />
                  </div>
                )}
              </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {showScrollBtn && (
            <button
              className="scroll-bottom-btn"
              onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
              aria-label="Scroll to bottom"
            >
              <i className="ti ti-arrow-down" aria-hidden="true"></i>
            </button>
          )}

          {!activeDM && typingUser && (
            <p className="typing-indicator">{typingUser} is typing...</p>
          )}
          {activeDM && dmTypingUser && (
            <p className="typing-indicator">{dmTypingUser} is typing...</p>
          )}

          {replyingTo && (
            <div className="reply-bar">
              <div className="reply-bar-content">
                <span className="reply-bar-user">↩ Replying to <strong>{replyingTo.username}</strong></span>
                <span className="reply-bar-text">
                  {replyingTo.imageUrl
                    ? '📷 Image'
                    : replyingTo.fileType?.startsWith('audio/')
                    ? '🎤 Voice message'
                    : replyingTo.text}
                </span>
              </div>
              <button className="reply-bar-close" onClick={() => setReplyingTo(null)}>✕</button>
            </div>
          )}

          {pendingImage && (
            <div className="pending-image-bar">
              <img src={pendingImage.preview} alt="preview" className="pending-image-thumb" />
              <label className="vo-toggle">
                <input
                  type="checkbox"
                  checked={pendingImageViewOnce}
                  onChange={e => setPendingImageViewOnce(e.target.checked)}
                />
                <i className={`ti ${pendingImageViewOnce ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                View once
              </label>
              <div className="pending-image-actions">
                <button onClick={confirmSendImage}>Send</button>
                <button onClick={cancelPendingImage} aria-label="Cancel">✕</button>
              </div>
            </div>
          )}

          <div className="input-area">
            {/* Hidden file inputs */}
            <input
              type="file"
              accept="image/*"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={e => handleImageSelect(e.target.files[0])}
            />
            <input
              type="file"
              ref={fileShareRef}
              style={{ display: 'none' }}
              onChange={e => sendFile(e.target.files[0])}
            />
            {/* Preload emoji data off-screen */}
            <div style={{ display: 'none' }}>
              <EmojiPicker onEmojiClick={() => {}} />
            </div>

            {/* + Attachments button */}
            <div className="attach-wrapper">
              <button
                className={`emoji-btn${showAttach ? ' attach-btn-active' : ''}`}
                onClick={() => { setShowAttach(v => !v); setShowPicker(false); }}
                aria-label="Attachments"
              >
                <i className={`ti ${showAttach ? 'ti-x' : 'ti-plus'}`} aria-hidden="true" />
              </button>
              {showAttach && (
                <div className="attach-panel">
                  <button
                    className="attach-option"
                    onClick={() => { fileInputRef.current.click(); setShowAttach(false); }}
                  >
                    <div className="attach-option-icon attach-icon-photo">
                      <i className="ti ti-photo" aria-hidden="true" />
                    </div>
                    <span>Photo</span>
                  </button>
                  <button
                    className="attach-option"
                    onClick={() => { fileShareRef.current.click(); setShowAttach(false); }}
                  >
                    <div className="attach-option-icon attach-icon-file">
                      <i className="ti ti-paperclip" aria-hidden="true" />
                    </div>
                    <span>File</span>
                  </button>
                  <button
                    className="attach-option"
                    onClick={() => { setShowPollModal(true); setShowAttach(false); }}
                  >
                    <div className="attach-option-icon attach-icon-poll">
                      <i className="ti ti-chart-bar" aria-hidden="true" />
                    </div>
                    <span>Poll</span>
                  </button>
                  <button
                    className="attach-option"
                    onClick={openScheduleModal}
                  >
                    <div className="attach-option-icon attach-icon-schedule">
                      <i className="ti ti-clock-send" aria-hidden="true" />
                    </div>
                    <span>Schedule</span>
                  </button>
                </div>
              )}
            </div>

            {/* Unified emoji + sticker picker */}
            <div className="emoji-wrapper">
              <button
                className="emoji-btn"
                onClick={() => { setShowPicker(v => !v); setShowAttach(false); if (!showPicker) loadStickers(); }}
                aria-label="Emoji and stickers"
              >
                <i className="ti ti-mood-smile" aria-hidden="true" />
              </button>
              {showPicker && (
                <div className="emoji-popup">
                  <div className="picker-tabs">
                    <button
                      className={`picker-tab${pickerTab === 'emoji' ? ' active' : ''}`}
                      onClick={() => setPickerTab('emoji')}
                    >Emoji</button>
                    <button
                      className={`picker-tab${pickerTab === 'stickers' ? ' active' : ''}`}
                      onClick={() => { setPickerTab('stickers'); loadStickers(); }}
                    >Stickers</button>
                  </div>
                  {pickerTab === 'emoji' ? (
                    <EmojiPicker
                      onEmojiClick={(e) => { setMessage(prev => prev + e.emoji); setShowPicker(false); }}
                      height={340}
                      width={300}
                      previewConfig={{ showPreview: false }}
                    />
                  ) : (
                    <div className="sticker-picker-content">
                      {userStickers.length === 0 ? (
                        <p className="sticker-popup-empty">No stickers yet.<br />Add some in Profile → Stickers.</p>
                      ) : (
                        <div className="sticker-picker-grid">
                          {userStickers.map(s => (
                            <button
                              key={s._id}
                              className="sticker-picker-item"
                              onClick={() => sendSticker(s.imageUrl)}
                              aria-label="Send sticker"
                            >
                              <img src={s.imageUrl} alt="sticker" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {micError && <span className="mic-error">{micError}</span>}

            {/* Text input / recording indicator */}
            <div style={{ flex: 1, position: 'relative' }}>
              {mentionCandidates.length > 0 && !activeDM && (
                <div className="mention-dropdown">
                  {mentionCandidates.map((user, idx) => (
                    <div
                      key={user}
                      className={`mention-item${idx === mentionIndex ? ' mention-item-active' : ''}`}
                      onMouseDown={e => { e.preventDefault(); insertMention(user); }}
                    >
                      <div className="mention-avatar">{user.slice(0, 2).toUpperCase()}</div>
                      <span>{user}</span>
                    </div>
                  ))}
                </div>
              )}
              {isRecording ? (
                <div className="recording-indicator">
                  <span className="rec-dot" />
                  <span className="rec-timer">{fmtDuration(recordingSeconds)}</span>
                  <span className="rec-hint">Recording...</span>
                  <button
                    className="rec-cancel"
                    onClick={() => stopRecording(false)}
                    aria-label="Cancel recording"
                  >
                    ✕ Cancel
                  </button>
                </div>
              ) : (
                <input
                  ref={messageInputRef}
                  type="text"
                  placeholder={activeDM ? `Message ${activeDM.toUser}...` : `Message #${currentRoom}`}
                  value={message}
                  onChange={handleMessageChange}
                  onKeyDown={handleKeyDown}
                  onBlur={() => setTimeout(() => setMentionCandidates([]), 150)}
                />
              )}
            </div>

            {/* Right button: send (recording) → send (has text) → mic (idle) */}
            {isRecording ? (
              <button className="send-btn" onClick={() => stopRecording(true)} aria-label="Send voice message">
                <i className="ti ti-send" aria-hidden="true" />
              </button>
            ) : message.trim() ? (
              <button className="send-btn" onClick={sendMessage} aria-label="Send">
                <i className="ti ti-arrow-up" aria-hidden="true" />
              </button>
            ) : (
              <button className="emoji-btn mic-btn" onClick={startRecording} aria-label="Record voice message">
                <i className="ti ti-microphone" aria-hidden="true" />
              </button>
            )}
          </div>

        </div>
      </div>

      {showProfile && (
        <Profile
          username={username}
          onClose={() => setShowProfile(false)}
          onStatusChange={(status) => {
            socket.emit('updateStatus', { username, status });
            setUserStatuses(prev => ({ ...prev, [username]: status }));
          }}
        />
      )}

      {viewingProfile && (
        <Profile
          username={viewingProfile}
          onClose={() => setViewingProfile(null)}
          readOnly={true}
        />
      )}

      {lightboxImg && (
        <div className="lightbox" onClick={() => { setLightboxImg(''); setLightboxViewOnce(false); }}>
          <div className="lightbox-content" onClick={e => e.stopPropagation()}>
            <img src={lightboxImg} alt="preview" />
            {lightboxViewOnce && (
              <div className="lightbox-vo-banner">
                <i className="ti ti-eye-off" aria-hidden="true"></i>
                View once — disappears after closing
              </div>
            )}
            <div className="lightbox-actions">
              {!lightboxViewOnce && (
                <a href={lightboxImg} download target="_blank" rel="noreferrer">
                  <i className="ti ti-download" aria-hidden="true"></i> Save image
                </a>
              )}
              <button onClick={() => { setLightboxImg(''); setLightboxViewOnce(false); }}>
                <i className="ti ti-x" aria-hidden="true"></i> Close
              </button>
            </div>
          </div>
        </div>
      )}

      {forwardingMsg && (
        <div className="profile-overlay" onClick={() => setForwardingMsg(null)}>
          <div className="forward-modal" onClick={e => e.stopPropagation()}>
            <div className="forward-modal-header">
              <span>Forward message</span>
              <button className="forward-close-btn" onClick={() => setForwardingMsg(null)} aria-label="Close">
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
            <div className="forward-modal-body">
              <div className="forward-section-label">Rooms</div>
              {rooms.map(room => (
                <div
                  key={room}
                  className="forward-item"
                  onClick={() => forwardMessage(forwardingMsg, { type: 'room', room })}
                >
                  <div className="forward-room-icon">#</div>
                  <span>{room}</span>
                </div>
              ))}
              <div className="forward-section-label">Direct Messages</div>
              {allUsers.filter(u => u.username !== username).map(u => (
                <div
                  key={u.username}
                  className="forward-item"
                  onClick={() => forwardMessage(forwardingMsg, { type: 'dm', toUser: u.username })}
                >
                  <Avatar username={u.username} avatarUrl={u.avatar || ''} size={32} />
                  <span>{u.displayName || u.username}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---- Poll creation modal ---- */}
      {showPollModal && (
        <div className="profile-overlay" onClick={() => setShowPollModal(false)}>
          <div className="poll-create-modal" onClick={e => e.stopPropagation()}>
            <div className="forward-modal-header">
              <span>Create Poll</span>
              <button className="forward-close-btn" onClick={() => setShowPollModal(false)} aria-label="Close">
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
            <div className="poll-create-body">
              <input
                className="poll-question-input"
                type="text"
                placeholder="Ask a question…"
                value={pollQuestion}
                onChange={e => setPollQuestion(e.target.value)}
                autoFocus
              />
              {pollOptions.map((opt, i) => (
                <div key={i} className="poll-option-row">
                  <input
                    className="poll-option-input"
                    type="text"
                    placeholder={`Option ${i + 1}`}
                    value={opt}
                    onChange={e => { const n = [...pollOptions]; n[i] = e.target.value; setPollOptions(n); }}
                    onKeyDown={e => e.key === 'Enter' && createPoll()}
                  />
                  {pollOptions.length > 2 && (
                    <button
                      className="poll-option-remove"
                      onClick={() => setPollOptions(prev => prev.filter((_, idx) => idx !== i))}
                      aria-label="Remove option"
                    >
                      <i className="ti ti-x" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
              {pollOptions.length < 4 && (
                <button className="poll-add-option" onClick={() => setPollOptions(prev => [...prev, ''])}>
                  + Add option
                </button>
              )}
              <button className="poll-create-btn" onClick={createPoll}>Create Poll</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Schedule message modal ---- */}
      {showScheduleModal && (
        <div className="profile-overlay" onClick={() => setShowScheduleModal(false)}>
          <div className="schedule-modal" onClick={e => e.stopPropagation()}>
            <div className="forward-modal-header">
              <span>Schedule Message</span>
              <button className="forward-close-btn" onClick={() => setShowScheduleModal(false)} aria-label="Close">
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
            <div className="schedule-modal-body">
              <input
                type="text"
                placeholder={activeDM ? `Message to ${activeDM.toUser}…` : `Message in #${currentRoom}…`}
                value={scheduleMsgText}
                onChange={e => setScheduleMsgText(e.target.value)}
                autoFocus
              />
              <label className="schedule-label">Send at</label>
              <input
                type="datetime-local"
                value={scheduleTime}
                min={minDateTime()}
                onChange={e => setScheduleTime(e.target.value)}
              />
              <button className="schedule-btn" onClick={createScheduledMessage}>Schedule</button>
              {scheduledMsgs.length > 0 && (
                <div className="scheduled-list">
                  <div className="forward-section-label" style={{ padding: '8px 0 4px' }}>Pending scheduled</div>
                  {scheduledMsgs.map(sm => (
                    <div key={sm._id} className="scheduled-item">
                      <span className="scheduled-item-text">{sm.text}</span>
                      <span className="scheduled-item-time">
                        {new Date(sm.scheduledFor).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button className="scheduled-item-cancel" onClick={() => cancelScheduledMessage(sm._id)} aria-label="Cancel">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- Incoming call banner ---- */}
      {incomingCall && (
        <div className="incoming-call-banner">
          <div className="incoming-call-info">
            <div className="incoming-call-from">{incomingCall.from}</div>
            <div className="incoming-call-type">
              <i className={`ti ${incomingCall.callType === 'video' ? 'ti-video' : 'ti-phone'}`} aria-hidden="true" />
              {' '}{incomingCall.callType === 'video' ? 'Video call' : 'Voice call'}
            </div>
          </div>
          <div className="incoming-call-actions">
            <button className="call-accept-btn" onClick={acceptCall} aria-label="Accept call">
              <i className="ti ti-phone" aria-hidden="true" />
            </button>
            <button className="call-reject-btn" onClick={rejectCall} aria-label="Reject call">
              <i className="ti ti-phone-off" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* ---- Active call overlay ---- */}
      {activeCall && (
        <div className="call-overlay">
          {activeCall.callType === 'video' ? (
            <>
              <video ref={remoteVideoRef} className="call-remote-video" autoPlay playsInline />
              <video ref={localVideoRef} className="call-local-video" autoPlay playsInline muted />
            </>
          ) : (
            <div className="call-audio-screen">
              <div className="call-audio-avatar">
                {(activeCall.peerUsername || '?').slice(0, 2).toUpperCase()}
              </div>
              <div className="call-peer-name">{activeCall.peerUsername}</div>
              <div className="call-status">
                {remoteStream ? `Call in progress · ${fmtCallDuration(callDuration)}` : 'Calling…'}
              </div>
            </div>
          )}
          <div className="call-controls">
            <button
              className={`call-control-btn${callMuted ? ' active' : ''}`}
              onClick={toggleMuteCall}
              aria-label={callMuted ? 'Unmute' : 'Mute'}
              title={callMuted ? 'Unmute' : 'Mute'}
            >
              <i className={`ti ${callMuted ? 'ti-microphone-off' : 'ti-microphone'}`} aria-hidden="true" />
            </button>
            {activeCall.callType === 'video' && (
              <button
                className={`call-control-btn${callCameraOff ? ' active' : ''}`}
                onClick={toggleCamera}
                aria-label={callCameraOff ? 'Turn camera on' : 'Turn camera off'}
                title={callCameraOff ? 'Camera on' : 'Camera off'}
              >
                <i className={`ti ${callCameraOff ? 'ti-video-off' : 'ti-video'}`} aria-hidden="true" />
              </button>
            )}
            <button className="call-control-btn call-end-btn" onClick={hangUp} aria-label="End call">
              <i className="ti ti-phone-off" aria-hidden="true" />
            </button>
          </div>
          {activeCall.callType === 'video' && (
            <div className="call-duration-badge">{fmtCallDuration(callDuration)}</div>
          )}
        </div>
      )}

    </div>
  );
}

export default Chat;