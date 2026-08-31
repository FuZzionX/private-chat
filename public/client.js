(function () {
  const landing = document.getElementById('landing');
  const nameGate = document.getElementById('nameGate');
  const chat = document.getElementById('chat');
  const messagesEl = document.getElementById('messages');
  const presenceEl = document.getElementById('presence');
  const typingEl = document.getElementById('typingIndicator');
  const toastEl = document.getElementById('toast');

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function toast(text) {
    toastEl.textContent = text;
    show(toastEl);
    setTimeout(() => hide(toastEl), 1800);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const roomMatch = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]{4,64})$/);

  if (!roomMatch) {
    show(landing);
    document.getElementById('createRoomBtn').addEventListener('click', async () => {
      const res = await fetch('/api/new-room');
      const { roomId } = await res.json();
      window.location.href = `/r/${roomId}`;
    });
    return;
  }

  const roomId = roomMatch[1];
  show(nameGate);
  const nameInput = document.getElementById('nameInput');
  nameInput.focus();

  let myName = null;
  let socket = null;

  function joinWithName() {
    const name = nameInput.value.trim();
    if (!name) return;
    myName = name;
    hide(nameGate);
    show(chat);
    startChat();
  }

  document.getElementById('joinBtn').addEventListener('click', joinWithName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinWithName();
  });

  function addMessageEl(msg, kind) {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    if (kind === 'system') {
      div.textContent = msg.text;
    } else {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = kind === 'me' ? fmtTime(msg.ts) : `${msg.name} · ${fmtTime(msg.ts)}`;
      const body = document.createElement('div');
      body.textContent = msg.text;
      div.appendChild(meta);
      div.appendChild(body);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function startChat() {
    socket = io();

    socket.on('connect', () => {
      socket.emit('join', { roomId, name: myName });
    });

    socket.on('history', (msgs) => {
      messagesEl.innerHTML = '';
      msgs.forEach((m) => addMessageEl(m, m.name === myName ? 'me' : 'other'));
    });

    socket.on('message', (msg) => {
      addMessageEl(msg, msg.name === myName ? 'me' : 'other');
    });

    socket.on('system', (payload) => {
      addMessageEl(payload, 'system');
    });

    socket.on('presence', ({ users }) => {
      presenceEl.textContent = users.length === 1
        ? '1 person here'
        : `${users.length} people here · ${users.join(', ')}`;
    });

    let typingTimeout = null;
    socket.on('typing', ({ name, isTyping }) => {
      typingEl.textContent = isTyping ? `${name} is typing…` : '';
    });

    const form = document.getElementById('composerForm');
    const input = document.getElementById('composerInput');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      socket.emit('message', text);
      input.value = '';
      socket.emit('typing', false);
    });

    let lastTypingEmit = 0;
    input.addEventListener('input', () => {
      const now = Date.now();
      if (now - lastTypingEmit > 800) {
        socket.emit('typing', true);
        lastTypingEmit = now;
      }
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => socket.emit('typing', false), 1500);
    });

    document.getElementById('copyLinkBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        toast('Link copied');
      } catch {
        toast(window.location.href);
      }
    });
  }
})();
