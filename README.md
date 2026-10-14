# iChat

A real-time chat app: rooms, direct messages, voice/video calls, polls, scheduled messages and more.

**Live demo:** https://ichat-smoky.vercel.app

## Features

- **Rooms & DMs** – public rooms (creators can rename, describe or delete their own), private 1:1 messages, typing indicators, read receipts, online/away/busy/invisible status
- **Messages** – reply, edit, delete, reactions, pin, star, forward (with a "Forwarded from" label), copy text, link previews, emoji, stickers, image/file/voice uploads, view-once images
- **Search** – full-history message search for the current chat or everywhere you have access to
- **History** – loads the latest 50 messages and pages in older ones on demand; jump to any search result or starred message
- **Block & mute** – block a user (no DMs, their room messages are hidden) and mute any room or DM (no sound or browser notification)
- **Browser notifications** – for new messages in chats you haven't muted
- **Polls, scheduled messages, call history**
- **Voice and video calls** – WebRTC, signalled over Socket.IO
- **Profiles** – avatar, display name, bio, custom stickers

## Tech stack

React 19 (Create React App) · Node.js + Express 5 · Socket.IO · MongoDB (Mongoose) · JWT auth · WebRTC

## Security notes

Socket connections require a signed JWT in the handshake and the server only trusts the identity from that token. All inputs are validated, socket events are rate limited, uploads are re-checked as real images and served with safe headers, link previews are SSRF-protected, and profile/sticker routes are limited to the owner.

## Run locally

Requirements: Node 20+ and a MongoDB instance.

```bash
# server
cd server
cp .env.example .env   # or create .env (see below)
npm install
npm start              # http://localhost:5000

# client (new terminal)
cd client
npm install
npm start              # http://localhost:3000
```

### Server environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Secret used to sign login tokens (use a long random string) |
| `ALLOWED_ORIGINS` | no | Comma-separated allowed client origins (default `http://localhost:3000`) |
| `PORT` | no | Defaults to 5000 |

The client reads the server URL from `client/src/config.js` (and `client/.env.production`).

## Tests

```bash
cd server
MONGO_URI=mongodb://127.0.0.1:27017/ichat_test JWT_SECRET=test npm test   # 18 integration tests
cd ../client
CI=true npm test -- --watchAll=false
```

The server tests spin up the real app and drive it over HTTP and Socket.IO. Use a throwaway database: tests create and delete data.

## Deployment

- **Client:** Vercel (root directory `client`)
- **Server:** Railway (root directory `server`) with the environment variables above

Deploy client and server together: the client now sends its login token on the socket handshake, which the server requires. On first start the server converts old direct-message ids (`a_b`) to the new `a:b` format automatically.
