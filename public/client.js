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
    const isImage = !!msg.image;
    const isAudio = !!msg.audio;
    div.className = isImage ? `msg ${kind} image` : isAudio ? `msg ${kind} audio` : `msg ${kind}`;
    if (kind === 'system') {
      div.textContent = msg.text;
    } else {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = kind === 'me' ? fmtTime(msg.ts) : `${msg.name} · ${fmtTime(msg.ts)}`;
      div.appendChild(meta);

      if (isImage) {
        const img = document.createElement('img');
        img.src = msg.image;
        img.alt = 'Shared photo';
        img.addEventListener('click', () => window.open(msg.image, '_blank'));
        div.appendChild(img);
      } else if (isAudio) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = msg.audio;
        div.appendChild(audio);
      } else {
        const body = document.createElement('div');
        body.textContent = msg.text;
        div.appendChild(body);
      }
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Downscale/compress client-side so photos stay reasonable over the socket.
  function compressImage(file, maxDim = 1600, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => { img.src = reader.result; };
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      reader.readAsDataURL(file);
    });
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
    const attachBtn = document.getElementById('attachBtn');
    const photoInput = document.getElementById('photoInput');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      socket.emit('message', { text });
      input.value = '';
      socket.emit('typing', false);
    });

    attachBtn.addEventListener('click', () => photoInput.click());

    photoInput.addEventListener('change', async () => {
      const file = photoInput.files[0];
      photoInput.value = '';
      if (!file || !file.type.startsWith('image/')) return;

      attachBtn.disabled = true;
      try {
        const dataUrl = await compressImage(file);
        if (dataUrl.length > 6 * 1024 * 1024) {
          toast('That photo is too large, try a smaller one');
        } else {
          socket.emit('message', { image: dataUrl });
        }
      } catch {
        toast('Could not send that photo');
      } finally {
        attachBtn.disabled = false;
      }
    });

    initVoiceNotes(socket, attachBtn, input);

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

    initVoiceCall(socket, myName);
  }

  // --- Voice notes: record a short clip, send it like a photo. ---
  function initVoiceNotes(socket, attachBtn, textInput) {
    const recordBtn = document.getElementById('recordBtn');
    if (!recordBtn) return;

    const MAX_MS = 120000;
    let recorder = null;
    let chunks = [];
    let startedAt = 0;
    let timerId = null;
    let indicatorEl = null;

    function pickMimeType() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    }

    function showIndicator() {
      indicatorEl = document.createElement('span');
      indicatorEl.className = 'recording-indicator';
      indicatorEl.textContent = '● 0:00';
      recordBtn.after(indicatorEl);
    }

    function updateIndicator() {
      if (!indicatorEl) return;
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(secs / 60);
      const s = String(secs % 60).padStart(2, '0');
      indicatorEl.textContent = `● ${m}:${s}`;
    }

    function teardownUI() {
      clearInterval(timerId);
      timerId = null;
      if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎤';
      attachBtn.disabled = false;
      textInput.disabled = false;
    }

    async function startRecording() {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast('Could not access microphone');
        return;
      }

      const mimeType = pickMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunks = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        teardownUI();

        const durationMs = Date.now() - startedAt;
        if (durationMs < 400) return; // accidental tap

        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          if (dataUrl.length > 6 * 1024 * 1024) {
            toast('That voice note is too long');
          } else {
            socket.emit('message', { audio: dataUrl });
          }
        };
        reader.readAsDataURL(blob);
      };

      recorder.start();
      startedAt = Date.now();
      recordBtn.classList.add('recording');
      recordBtn.textContent = '⏹️';
      attachBtn.disabled = true;
      textInput.disabled = true;
      showIndicator();
      timerId = setInterval(() => {
        updateIndicator();
        if (Date.now() - startedAt > MAX_MS) stopRecording();
      }, 250);
    }

    function stopRecording() {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    recordBtn.addEventListener('click', () => {
      if (recorder && recorder.state === 'recording') stopRecording();
      else startRecording();
    });
  }

  // --- Voice calls: peer-to-peer WebRTC. Audio never touches the server —
  // it only relays the SDP/ICE handshake over the existing socket. ---
  function initVoiceCall(socket, myName) {
    const ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    const callBtn = document.getElementById('callBtn');
    const muteBtn = document.getElementById('muteBtn');
    const callBar = document.getElementById('callBar');

    let localStream = null;
    let inCall = false;
    let muted = false;
    const peers = new Map(); // socketId -> RTCPeerConnection
    const peerNames = new Map(); // socketId -> name
    const audioEls = new Map(); // socketId -> HTMLAudioElement

    function renderCallBar() {
      if (!inCall || peers.size === 0) {
        callBar.innerHTML = inCall ? 'In call — waiting for others…' : '';
        callBar.classList.toggle('hidden', !inCall);
        return;
      }
      callBar.classList.remove('hidden');
      callBar.innerHTML = '';
      const label = document.createElement('span');
      label.textContent = 'In call:';
      callBar.appendChild(label);
      for (const id of peers.keys()) {
        const chip = document.createElement('span');
        chip.className = 'call-chip';
        chip.textContent = peerNames.get(id) || 'Someone';
        callBar.appendChild(chip);
      }
    }

    function createPeerConnection(peerId, peerName) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerNames.set(peerId, peerName);

      if (localStream) {
        for (const track of localStream.getAudioTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('call:signal', { to: peerId, data: { type: 'ice', candidate: e.candidate } });
        }
      };

      pc.ontrack = (e) => {
        let audioEl = audioEls.get(peerId);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          audioEl.style.display = 'none';
          document.body.appendChild(audioEl);
          audioEls.set(peerId, audioEl);
        }
        audioEl.srcObject = e.streams[0];
      };

      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          cleanupPeer(peerId);
        }
      };

      peers.set(peerId, pc);
      return pc;
    }

    function cleanupPeer(peerId) {
      const pc = peers.get(peerId);
      if (pc) {
        pc.close();
        peers.delete(peerId);
      }
      peerNames.delete(peerId);
      const audioEl = audioEls.get(peerId);
      if (audioEl) {
        audioEl.remove();
        audioEls.delete(peerId);
      }
      renderCallBar();
    }

    async function joinCall() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast('Could not access microphone');
        return;
      }
      inCall = true;
      callBtn.textContent = '📞 Leave call';
      callBtn.classList.add('active');
      show(muteBtn);
      renderCallBar();
      socket.emit('call:join');
    }

    function leaveCall() {
      inCall = false;
      for (const id of Array.from(peers.keys())) cleanupPeer(id);
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
      }
      socket.emit('call:leave');
      callBtn.textContent = '🎙️ Start voice call';
      callBtn.classList.remove('active');
      hide(muteBtn);
      muted = false;
      muteBtn.textContent = '🎙️ Mute';
      callBar.classList.add('hidden');
    }

    callBtn.addEventListener('click', () => {
      if (inCall) leaveCall();
      else joinCall();
    });

    muteBtn.addEventListener('click', () => {
      if (!localStream) return;
      muted = !muted;
      localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      muteBtn.textContent = muted ? '🔇 Unmute' : '🎙️ Mute';
    });

    socket.on('call:members', async (existing) => {
      for (const { id, name } of existing) {
        const pc = createPeerConnection(id, name);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('call:signal', { to: id, data: { type: 'offer', sdp: offer } });
        } catch {
          cleanupPeer(id);
        }
      }
      renderCallBar();
    });

    socket.on('call:peer-joined', ({ name }) => {
      if (inCall) toast(`${name} joined the call`);
    });

    socket.on('call:signal', async ({ from, name, data }) => {
      if (!inCall) return;
      let pc = peers.get(from);
      if (!pc) pc = createPeerConnection(from, name);

      if (data.type === 'offer') {
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:signal', { to: from, data: { type: 'answer', sdp: answer } });
        renderCallBar();
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(data.sdp);
        renderCallBar();
      } else if (data.type === 'ice') {
        try { await pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
      }
    });

    socket.on('call:peer-left', ({ id }) => {
      cleanupPeer(id);
    });
  }
})();
