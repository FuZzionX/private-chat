const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = require('http').createServer(app);
const io = new Server(server, {
  // Default is 1MB, too small for a photo message — the whole point is
  // images travel as part of the normal socket message, never a file upload.
  maxHttpBufferSize: 8 * 1024 * 1024,
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// In-memory only — nothing ever touches disk, nothing survives a restart.
// rooms: Map<roomId, { messages: Array<{id, name, text?, image?, ts}>, users: Map<socketId, name> }>
const rooms = new Map();
const MAX_ROOM_HISTORY_BYTES = 40 * 1024 * 1024; // rough cap so an image-heavy room can't balloon memory

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { messages: [], users: new Map(), callMembers: new Set(), historyBytes: 0 };
    rooms.set(roomId, room);
  }
  return room;
}

function messageBytes(msg) {
  return (msg.text ? msg.text.length : 0) + (msg.image ? msg.image.length : 0) + (msg.audio ? msg.audio.length : 0);
}

function pushMessage(room, msg) {
  room.messages.push(msg);
  room.historyBytes += messageBytes(msg);
  while (room.messages.length > 500 || room.historyBytes > MAX_ROOM_HISTORY_BYTES) {
    const dropped = room.messages.shift();
    if (!dropped) break;
    room.historyBytes -= messageBytes(dropped);
  }
}

function roomUserList(room) {
  return Array.from(room.users.values());
}

app.get('/api/new-room', (req, res) => {
  const roomId = crypto.randomBytes(9).toString('base64url');
  res.json({ roomId });
});

app.get('/r/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const MAX_NAME_LEN = 24;
const MAX_MSG_LEN = 2000;
const MAX_IMAGE_DATA_URL_LEN = 6 * 1024 * 1024; // ~4.5MB raw image, base64-encoded
const MAX_AUDIO_DATA_URL_LEN = 6 * 1024 * 1024; // generous for a couple minutes of opus

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let displayName = null;

  socket.on('join', ({ roomId, name }) => {
    if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(roomId)) return;
    if (typeof name !== 'string' || !name.trim()) return;
    if (joinedRoomId) return; // one room per connection

    displayName = name.trim().slice(0, MAX_NAME_LEN);
    joinedRoomId = roomId;

    const room = getOrCreateRoom(roomId);
    room.users.set(socket.id, displayName);
    socket.join(roomId);

    socket.emit('history', room.messages);
    io.to(roomId).emit('presence', { users: roomUserList(room) });
    socket.to(roomId).emit('system', { text: `${displayName} joined`, ts: Date.now() });
  });

  socket.on('message', (payload, ack) => {
    const fail = (reason) => { if (typeof ack === 'function') ack({ ok: false, reason }); };

    if (!joinedRoomId) return fail('not-in-room');
    const room = rooms.get(joinedRoomId);
    if (!room) return fail('room-gone');

    let msg = null;

    if (payload && typeof payload.image === 'string') {
      if (!/^data:image\//.test(payload.image)) return fail('bad-image');
      if (payload.image.length > MAX_IMAGE_DATA_URL_LEN) return fail('image-too-large');
      msg = { id: crypto.randomUUID(), name: displayName, image: payload.image, ts: Date.now() };
    } else if (payload && typeof payload.audio === 'string') {
      if (!/^data:audio\//.test(payload.audio)) return fail('bad-audio');
      if (payload.audio.length > MAX_AUDIO_DATA_URL_LEN) return fail('audio-too-large');
      msg = { id: crypto.randomUUID(), name: displayName, audio: payload.audio, ts: Date.now() };
    } else if (payload && typeof payload.text === 'string') {
      const trimmed = payload.text.trim().slice(0, MAX_MSG_LEN);
      if (!trimmed) return fail('empty-text');
      msg = { id: crypto.randomUUID(), name: displayName, text: trimmed, ts: Date.now() };
    } else {
      return fail('bad-payload');
    }

    pushMessage(room, msg);
    io.to(joinedRoomId).emit('message', msg);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('typing', (isTyping) => {
    if (!joinedRoomId) return;
    socket.to(joinedRoomId).emit('typing', { name: displayName, isTyping: !!isTyping });
  });

  // Voice calls are peer-to-peer WebRTC — this server only relays the
  // handshake (who's in the call, SDP offers/answers, ICE candidates).
  // No audio ever passes through it.
  socket.on('call:join', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    const existing = Array.from(room.callMembers)
      .filter((id) => id !== socket.id)
      .map((id) => ({ id, name: room.users.get(id) }));

    room.callMembers.add(socket.id);
    socket.emit('call:members', existing);
    socket.to(joinedRoomId).emit('call:peer-joined', { id: socket.id, name: displayName });
  });

  socket.on('call:signal', ({ to, data } = {}) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room || typeof to !== 'string' || !room.callMembers.has(to)) return;
    io.to(to).emit('call:signal', { from: socket.id, name: displayName, data });
  });

  socket.on('call:leave', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    room.callMembers.delete(socket.id);
    socket.to(joinedRoomId).emit('call:peer-left', { id: socket.id });
  });

  socket.on('disconnect', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    room.users.delete(socket.id);
    if (room.callMembers.delete(socket.id)) {
      socket.to(joinedRoomId).emit('call:peer-left', { id: socket.id });
    }
    io.to(joinedRoomId).emit('presence', { users: roomUserList(room) });
    socket.to(joinedRoomId).emit('system', { text: `${displayName} left`, ts: Date.now() });

    // Nobody left in the room — wipe its history immediately.
    if (room.users.size === 0) {
      rooms.delete(joinedRoomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Private chat running on http://localhost:${PORT}`);
});
