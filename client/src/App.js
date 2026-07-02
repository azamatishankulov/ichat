import React, { useState } from 'react';
import './App.css';
import Chat from './Chat';

function App() {
  const [screen, setScreen] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loggedInUser, setLoggedInUser] = useState('');

  const handleLogin = async () => {
    const res = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', username);
      setLoggedInUser(username);
      setScreen('chat');
    } else {
      setMessage(data.message || 'Login failed');
    }
  };

  const handleRegister = async () => {
    const res = await fetch('http://localhost:5000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    setMessage(data.message);
  };

  const handleLogout = () => {
    localStorage.clear();
    setLoggedInUser('');
    setUsername('');
    setPassword('');
    setScreen('login');
  };

  if (screen === 'chat') {
    return <Chat username={loggedInUser} onLogout={handleLogout} />;
  }

  return (
    <div className="container">
      <div className="auth-box">
        <div className="auth-logo">
          <div className="auth-logo-icon">
            <svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 1.5C4.86 1.5 1.5 4.86 1.5 9c0 1.29.33 2.5.9 3.57L1.5 16.5l3.93-.9A7.44 7.44 0 0 0 9 16.5c4.14 0 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5Z" fill="white" opacity="0.15"/>
              <path d="M9 1.5C4.86 1.5 1.5 4.86 1.5 9c0 1.29.33 2.5.9 3.57L1.5 16.5l3.93-.9A7.44 7.44 0 0 0 9 16.5c4.14 0 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5Z" stroke="white" strokeWidth="1.2" strokeLinejoin="round"/>
              <circle cx="6" cy="9" r="1" fill="white"/>
              <circle cx="9" cy="9" r="1" fill="white"/>
              <circle cx="12" cy="9" r="1" fill="white"/>
            </svg>
          </div>
          <div className="auth-brand">i<span>Chat</span></div>
        </div>
        <p className="auth-subtitle">Sign in to continue</p>

        <div className="tabs">
          <button
            className={screen === 'login' ? 'active' : ''}
            onClick={() => setScreen('login')}
          >Login</button>
          <button
            className={screen === 'register' ? 'active' : ''}
            onClick={() => setScreen('register')}
          >Register</button>
        </div>

        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        {screen === 'login'
          ? <button className="submit" onClick={handleLogin}>Login</button>
          : <button className="submit" onClick={handleRegister}>Register</button>
        }

        {message && <p className="message">{message}</p>}
      </div>
    </div>
  );
}

export default App;