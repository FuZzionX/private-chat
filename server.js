const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = require('http').createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// In-memory only — nothing ever touches disk, nothing survives a restart.
// rooms: Map<roomId, { messages: Array<{id, name, text, ts}>, users: Map<socketId, name> }>
const rooms = new Map();

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { messages: [], users: new Map() };
    rooms.set(roomId, room);
  }
  return room;
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

  socket.on('message', (text) => {
    if (!joinedRoomId) return;
    if (typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, MAX_MSG_LEN);
    if (!trimmed) return;

    const room = rooms.get(joinedRoomId);
    if (!room) return;

    const msg = {
      id: crypto.randomUUID(),
      name: displayName,
      text: trimmed,
      ts: Date.now(),
    };
    room.messages.push(msg);
    // Cap in-memory history so a long-running room can't grow unbounded.
    if (room.messages.length > 500) room.messages.shift();

    io.to(joinedRoomId).emit('message', msg);
  });

  socket.on('typing', (isTyping) => {
    if (!joinedRoomId) return;
    socket.to(joinedRoomId).emit('typing', { name: displayName, isTyping: !!isTyping });
  });

  socket.on('disconnect', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    room.users.delete(socket.id);
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
