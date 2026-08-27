/**
 * Ultimate Watch Together — Sync Engine (protocol v2)
 *
 * Playback state, chat and presence all travel over ONE transport: the WebSocket
 * relay. WebRTC/PeerJS is initialised only so that voice chat has a peer id to
 * dial; it never carries playback state. See PROTOCOL.md.
 *
 * Room codes stay 3 digits (100-999) everywhere. The PeerJS id is derived from
 * the code plus a random suffix, so two people can never collide on the public
 * broker and the user still only ever types three digits.
 */

const WT_PROTOCOL_VERSION = 2;

/* Echo-suppression budgets (ms) — see PROTOCOL.md §6 */
const MUTE_SIMPLE = 400;
const MUTE_SEEK = 2500;
const MUTE_SEEK_SETTLED = 250;
const MUTE_HEARTBEAT = 700;

const HEARTBEAT_MS = 3000;
const HELLO_MS = 10000;
const CLOCK_PING_MS = 5000;
const RELAY_PING_MS = 15000;
const PEER_TIMEOUT_MS = 25000;

class SyncEngine {
  constructor() {
    /* ---- identity ---------------------------------------------------- */
    this.sid = 'w' + Math.random().toString(36).slice(2, 10);
    this.seq = 0;
    this.myRelayId = null;

    this.roomId = null;
    this.isHost = false;

    this.localUsername =
      localStorage.getItem('wt_username') ||
      localStorage.getItem('wt_nickname') ||
      ('User_' + Math.floor(100 + Math.random() * 900));

    /* ---- receiver bookkeeping ---------------------------------------- */
    this.lastSeq = {};     // sid -> highest seq seen
    this.peersMap = {};    // sid -> peer record
    this.clock = {};       // sid -> { offset, rtt, samples }
    this.seenChat = new Set();
    this.seenChatOrder = [];

    /* ---- echo suppression (deadline, never a boolean) ---------------- */
    this.remoteUntil = 0;

    /* ---- transport --------------------------------------------------- */
    this.cloudWs = null;
    this.cloudWsConnected = false;
    this.cloudPeerCount = 0;
    this.cloudGeneration = 0;
    this.reconnectAttempts = 0;
    this.cloudWsPingTimer = null;
    this.cloudWsReconnectTimer = null;
    this.joinResolve = null;
    this.joinReject = null;
    this.joinTimer = null;

    this.relayUrls = (location.protocol === 'https:')
      ? ['wss://138-68-159-46.sslip.io/ws']
      : ['wss://138-68-159-46.sslip.io/ws', 'ws://138.68.159.46:8765'];
    this.relayUrlIndex = 0;

    /* ---- voice (PeerJS only) ---------------------------------------- */
    this.peer = null;
    this.peerReady = false;
    this.voiceId = null;
    this.connections = []; // kept empty: legacy field, voice uses getVoicePeerIds()

    /* ---- timers ------------------------------------------------------ */
    this.heartbeatTimer = null;
    this.helloTimer = null;
    this.clockTimer = null;
    this.pruneTimer = null;

    this.lastPing = 0;
    this.wakeLock = null;

    /* ---- callbacks --------------------------------------------------- */
    this.onStatusChange = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onRemoteState = null;      // (state) => void  — the player applies it
    this.onChatReceived = null;
    this.onFileInfoReceived = null;
    this.onPingUpdated = null;
    this.onPeerCountChanged = null;
    this.onPeerListChanged = null;
    this.getLocalState = null;      // () => { position, paused, rate, duration, ready }

    this._setupVisibilityListener();
  }

  /* ====================================================================
     Echo suppression
     ==================================================================== */
  get isRemoteUpdate() {
    return Date.now() < this.remoteUntil;
  }

  /** Extend the mute deadline. Never shortens it. */
  mute(ms) {
    const until = Date.now() + ms;
    if (until > this.remoteUntil) this.remoteUntil = until;
  }

  /** Only the seek path may pull the deadline in, once the seek has settled. */
  muteSettled(ms) {
    const until = Date.now() + ms;
    if (until < this.remoteUntil) this.remoteUntil = until;
  }

  /* ====================================================================
     Identity / presence
     ==================================================================== */
  getUsername() {
    return this.localUsername;
  }

  setUsername(name) {
    if (!name) return;
    this.localUsername = String(name).trim();
    localStorage.setItem('wt_username', this.localUsername);
    localStorage.setItem('wt_nickname', this.localUsername);
    this._sendHello();
    if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
  }

  getPeerList() {
    const list = [{
      isSelf: true,
      sid: this.sid,
      peerId: this.sid,
      username: this.localUsername,
      role: this.isHost ? 'Host' : 'Guest',
      isHost: this.isHost,
      platform: 'web',
      status: 'online',
      joinedAt: Date.now()
    }];
    for (const sid in this.peersMap) {
      const p = this.peersMap[sid];
      list.push({
        isSelf: false,
        sid: p.sid,
        peerId: p.sid,
        username: p.username,
        role: p.isHost ? 'Host' : 'Guest',
        isHost: p.isHost,
        platform: p.platform,
        status: 'online',
        joinedAt: p.joinedAt
      });
    }
    return list;
  }

  getRemotePeerCount() {
    const known = Object.keys(this.peersMap).length;
    return Math.max(known, Math.max(0, (this.cloudPeerCount || 1) - 1));
  }

  /** PeerJS ids to dial for voice chat. */
  getVoicePeerIds() {
    const ids = [];
    for (const sid in this.peersMap) {
      const v = this.peersMap[sid].voiceId;
      if (v) ids.push(v);
    }
    return ids;
  }

  /**
   * Leader = lowest score among self + known peers. Host wins ties.
   * See PROTOCOL.md §7.
   */
  leaderSid() {
    let best = (this.isHost ? '0:' : '1:') + this.sid;
    let bestSid = this.sid;
    for (const sid in this.peersMap) {
      const p = this.peersMap[sid];
      const score = (p.isHost ? '0:' : '1:') + sid;
      if (score < best) {
        best = score;
        bestSid = sid;
      }
    }
    return bestSid;
  }

  get isLeader() {
    return this.leaderSid() === this.sid;
  }

  /* ====================================================================
     Room lifecycle
     ==================================================================== */
  async createRoom() {
    const code = String(Math.floor(100 + Math.random() * 900));
    this.isHost = true;
    return this._enterRoom(code);
  }

  async joinRoom(code) {
    this.isHost = false;
    return this._enterRoom(String(code || '').trim());
  }

  /** Re-run the join handshake on the same code (used by the Reconnect button). */
  async reconnect() {
    if (!this.roomId) return null;
    return this._enterRoom(this.roomId);
  }

  async _enterRoom(code) {
    // Room codes are always 3 digits, on every platform.
    if (!/^\d{3}$/.test(String(code || ''))) throw new Error('Room code must be 3 digits (100-999)');
    this.roomId = code;
    this.lastSeq = {};
    this.peersMap = {};
    this.clock = {};
    // `seq` is deliberately NOT reset: peers remember our highest seq, so
    // restarting the counter on a re-join would make them drop everything.

    this._initVoicePeer(code); // fire and forget, never blocks the room
    await this._connectRelay(code);

    this._startTimers();
    this._acquireWakeLock();
    return code;
  }

  _connectRelay(code) {
    return new Promise((resolve, reject) => {
      const gen = ++this.cloudGeneration;
      this._teardownRelay();

      this.joinResolve = resolve;
      this.joinReject = reject;

      const url = this.relayUrls[this.relayUrlIndex % this.relayUrls.length];
      this._updateStatus('connecting', `Joining room ${code}...`);
      console.log(`[Sync] Relay connect ${url} room=${code} sid=${this.sid}`);

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this._failJoin(err);
        return;
      }
      this.cloudWs = ws;

      clearTimeout(this.joinTimer);
      this.joinTimer = setTimeout(() => {
        if (gen === this.cloudGeneration && !this.cloudWsConnected) {
          this.relayUrlIndex++;
          this._failJoin(new Error('Relay join timed out'));
        }
      }, 12000);

      ws.onopen = () => {
        if (gen !== this.cloudGeneration) { try { ws.close(); } catch (e) {} return; }
        this.reconnectAttempts = 0;
        this.cloudWs.send(JSON.stringify({
          type: 'join',
          room: code,
          room_id: code,
          user: this.localUsername,
          username: this.localUsername,
          platform: 'web'
        }));
        clearInterval(this.cloudWsPingTimer);
        this.cloudWsPingTimer = setInterval(() => {
          if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
            try {
              this.cloudWs.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            } catch (e) {}
          }
        }, RELAY_PING_MS);
      };

      ws.onmessage = (event) => {
        if (gen !== this.cloudGeneration) return;
        let data;
        try { data = JSON.parse(event.data); } catch (e) { return; }
        this._handleRelayMessage(data);
      };

      ws.onerror = () => {
        if (gen !== this.cloudGeneration) return;
        console.warn('[Sync] Relay socket error');
      };

      ws.onclose = () => {
        if (gen !== this.cloudGeneration) return;
        const wasConnected = this.cloudWsConnected;
        this.cloudWsConnected = false;
        clearInterval(this.cloudWsPingTimer);
        this.peersMap = {};
        this._notifyPeerCount();
        if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());

        if (!wasConnected) {
          this.relayUrlIndex++;
          this._failJoin(new Error('Relay closed before join'));
          return;
        }

        this._updateStatus('connecting', 'Relay lost — reconnecting...');
        this._scheduleReconnect();
      };
    });
  }

  _failJoin(err) {
    clearTimeout(this.joinTimer);
    const reject = this.joinReject;
    this.joinResolve = null;
    this.joinReject = null;
    this._updateStatus('error', 'Could not reach the sync relay. Check your connection.');
    if (reject) reject(err);
  }

  _scheduleReconnect() {
    if (!this.roomId) return;
    clearTimeout(this.cloudWsReconnectTimer);
    const delay = Math.min(15000, 1000 * Math.pow(1.6, Math.min(8, this.reconnectAttempts++)));
    this.cloudWsReconnectTimer = setTimeout(() => {
      if (!this.roomId) return;
      this._connectRelay(this.roomId).catch(() => this._scheduleReconnect());
    }, delay);
  }

  _teardownRelay() {
    clearInterval(this.cloudWsPingTimer);
    clearTimeout(this.cloudWsReconnectTimer);
    if (this.cloudWs) {
      try {
        this.cloudWs.onopen = null;
        this.cloudWs.onmessage = null;
        this.cloudWs.onerror = null;
        this.cloudWs.onclose = null;
        this.cloudWs.close();
      } catch (e) {}
    }
    this.cloudWs = null;
    this.cloudWsConnected = false;
  }

  _startTimers() {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.helloTimer);
    clearInterval(this.clockTimer);
    clearInterval(this.pruneTimer);

    this.heartbeatTimer = setInterval(() => this._tickHeartbeat(), HEARTBEAT_MS);
    this.helloTimer = setInterval(() => this._sendHello(), HELLO_MS);
    this.clockTimer = setInterval(() => this._sendClockPings(), CLOCK_PING_MS);
    this.pruneTimer = setInterval(() => this._prunePeers(), 5000);
  }

  /* ====================================================================
     Sending
     ==================================================================== */
  _send(kind, extra) {
    if (!this.cloudWs || this.cloudWs.readyState !== WebSocket.OPEN || !this.roomId) return false;
    const pkt = Object.assign({
      type: 'action',
      room: String(this.roomId),
      v: WT_PROTOCOL_VERSION,
      kind: kind,
      sid: this.sid,
      sname: this.localUsername,
      splat: 'web',
      seq: ++this.seq,
      sent_at: Date.now()
    }, extra || {});
    try {
      this.cloudWs.send(JSON.stringify(pkt));
      return true;
    } catch (e) {
      console.warn('[Sync] send failed:', e);
      return false;
    }
  }

  _sendHello() {
    this._send('hello', {
      isHost: this.isHost,
      voice: this.voiceId || undefined,
      ver: '2.0'
    });
  }

  _localState() {
    if (typeof this.getLocalState === 'function') {
      try { return this.getLocalState(); } catch (e) {}
    }
    return null;
  }

  /**
   * The one function that broadcasts playback state.
   * `override` lets a caller pin position/paused/rate explicitly.
   */
  sendState(cause, override) {
    if (this.isRemoteUpdate) return false;
    const st = Object.assign({ position: 0, paused: true, rate: 1.0, duration: 0 },
      this._localState() || {}, override || {});
    return this._send('state', {
      position: Number(st.position) || 0,
      paused: !!st.paused,
      rate: Number(st.rate) || 1.0,
      duration: Number(st.duration) || 0,
      cause: cause || 'state'
    });
  }

  /* Convenience wrappers kept for the player's call sites */
  sendPlay(position, rate) { return this.sendState('play', { position, paused: false, rate: rate || 1.0 }); }
  sendPause(position) { return this.sendState('pause', { position, paused: true }); }
  sendSeek(position) { return this.sendState('seek', { position }); }
  sendRate(rate) { return this.sendState('rate', { rate }); }
  sendStartWatching() { return this.sendState('start', { position: 0, paused: false }); }

  sendChat(text, sender) {
    const msg = {
      text: text,
      sender: sender || this.localUsername,
      timestamp: Date.now()
    };
    this._send('chat', { text: text });
    return msg;
  }

  sendFileInfo(name, size, duration) {
    this._send('file_info', { name: name, size: size, duration: duration });
  }

  requestState() {
    this._send('request_state', {});
  }

  _sendClockPings() {
    for (const sid in this.peersMap) {
      this._send('tping', { to: sid, t0: Date.now() });
    }
  }

  _tickHeartbeat() {
    if (!this.isLeader) return;
    if (Object.keys(this.peersMap).length === 0) return;
    const st = this._localState();
    if (!st || !st.ready || !(st.duration > 0)) return;
    this._send('state', {
      position: Number(st.position) || 0,
      paused: !!st.paused,
      rate: Number(st.rate) || 1.0,
      duration: Number(st.duration) || 0,
      cause: 'heartbeat'
    });
  }

  /* ====================================================================
     Receiving
     ==================================================================== */
  _handleRelayMessage(data) {
    if (!data || !data.type) return;

    /* ---- server control frames (no `v`) ----------------------------- */
    switch (data.type) {
      case 'pong':
        if (typeof data.timestamp === 'number') {
          this.lastPing = Math.max(1, Math.round((Date.now() - data.timestamp) / 2));
          if (this.onPingUpdated) this.onPingUpdated(this.lastPing);
        }
        return;

      case 'room_joined': {
        this.cloudWsConnected = true;
        this.myRelayId = data.client_id || null;
        if (typeof data.peer_count === 'number') this.cloudPeerCount = data.peer_count;
        clearTimeout(this.joinTimer);
        console.log(`[Sync] Joined room ${data.room_id || this.roomId} as ${this.sid} (relay ${this.myRelayId}), ${this.cloudPeerCount} present`);

        this._sendHello();
        this._notifyPeerCount();
        this._updateStatus(
          this.cloudPeerCount > 1 ? 'connected' : 'ready',
          this.cloudPeerCount > 1 ? 'Connected with friend!' : (this.isHost ? 'Waiting for friend...' : 'Room ready')
        );

        const resolve = this.joinResolve;
        this.joinResolve = null;
        this.joinReject = null;
        if (resolve) resolve(this.roomId);

        // Ask whoever is in charge where the movie is right now.
        setTimeout(() => { if (Object.keys(this.peersMap).length) this.requestState(); }, 900);
        return;
      }

      case 'peer_joined':
        if (typeof data.peer_count === 'number') this.cloudPeerCount = data.peer_count;
        this._notifyPeerCount();
        // Re-announce so the newcomer learns about us, then push current state.
        this._sendHello();
        setTimeout(() => {
          this._sendHello();
          if (this.isLeader) {
            const st = this._localState();
            if (st && st.ready) this.sendState('resync');
          }
        }, 600);
        return;

      case 'peer_left': {
        if (typeof data.peer_count === 'number') this.cloudPeerCount = data.peer_count;
        // The v2 relay names the departing sid outright; the v1 relay only gives us
        // its own client id, which we matched to a sid from that peer's traffic.
        if (data.sid && this.peersMap[data.sid]) {
          this._dropPeer(data.sid, 'left');
        } else if (data.client_id) {
          for (const sid in this.peersMap) {
            if (this.peersMap[sid].relayId === data.client_id) {
              this._dropPeer(sid, 'left');
              break;
            }
          }
        }
        if (this.cloudPeerCount <= 1) {
          this.peersMap = {};
          this._updateStatus('ready', this.isHost ? 'Friend disconnected. Waiting...' : 'Alone in room.');
        }
        this._notifyPeerCount();
        if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
        return;
      }
    }

    /* ---- v2 peer packets -------------------------------------------- */
    if (data.type !== 'action' || data.v !== WT_PROTOCOL_VERSION) return;

    const sid = data.sid;
    if (!sid || sid === this.sid) return;                 // rule 1: self-echo

    if (typeof data.seq === 'number') {                   // rule 3: replay / reorder
      const last = this.lastSeq[sid];
      if (typeof last === 'number' && data.seq <= last) {
        // A big backwards jump means the sender restarted its counter; accept.
        if (last - data.seq < 50) return;
      }
      this.lastSeq[sid] = data.seq;
    }

    this._touchPeer(sid, data);

    switch (data.kind) {
      case 'hello':       this._onHello(sid, data); break;
      case 'state':       this._onState(sid, data); break;
      case 'chat':        this._onChat(sid, data); break;
      case 'file_info':   if (this.onFileInfoReceived) this.onFileInfoReceived(data); break;
      case 'request_state':
        if (this.isLeader) {
          const st = this._localState();
          if (st && st.ready) this.sendState('resync');
        }
        break;
      case 'tping':
        if (data.to === this.sid) {
          this._send('tpong', { to: sid, t0: data.t0, t1: Date.now() });
        }
        break;
      case 'tpong':
        if (data.to === this.sid) this._onClockSample(sid, data);
        break;
      case 'bye':
        this._dropPeer(sid, 'bye');
        break;
    }
  }

  _touchPeer(sid, data) {
    let p = this.peersMap[sid];
    const isNew = !p;
    if (isNew) {
      p = this.peersMap[sid] = {
        sid: sid,
        username: data.sname || 'Friend',
        platform: data.splat || 'unknown',
        isHost: false,
        voiceId: null,
        relayId: data.sender_id || null,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      };
      console.log(`[Sync] Peer discovered: ${sid} (${p.username} / ${p.platform})`);
      this._updateStatus('connected', 'Connected with friend!');
      this._notifyPeerCount();
      if (this.onPeerConnected) this.onPeerConnected(sid, p);
      if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
      // Fast clock probes so the very first sync is already compensated.
      for (let i = 1; i <= 3; i++) {
        setTimeout(() => this._send('tping', { to: sid, t0: Date.now() }), i * 700);
      }
    } else {
      p.lastSeen = Date.now();
      if (data.sender_id) p.relayId = data.sender_id;
      if (data.sname && data.sname !== p.username) {
        p.username = data.sname;
        if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
      }
    }
    return p;
  }

  _onHello(sid, data) {
    const p = this.peersMap[sid];
    if (!p) return;
    let changed = false;
    if (typeof data.isHost === 'boolean' && p.isHost !== data.isHost) { p.isHost = data.isHost; changed = true; }
    if (data.voice && p.voiceId !== data.voice) { p.voiceId = data.voice; changed = true; }
    if (changed && this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
  }

  _onChat(sid, data) {
    const text = data.text || (data.chat && data.chat.text) || '';
    if (!text) return;
    const mid = sid + ':' + (data.seq || Date.now());
    if (this.seenChat.has(mid)) return;
    this.seenChat.add(mid);
    this.seenChatOrder.push(mid);
    if (this.seenChatOrder.length > 500) {
      this.seenChat.delete(this.seenChatOrder.shift());
    }
    if (this.onChatReceived) {
      this.onChatReceived({
        text: text,
        sender: data.sname || (this.peersMap[sid] && this.peersMap[sid].username) || 'Friend',
        timestamp: data.sent_at || Date.now(),
        sid: sid
      });
    }
  }

  _onClockSample(sid, data) {
    const t0 = Number(data.t0);
    const t1 = Number(data.t1);
    if (!t0 || !t1) return;
    const t3 = Date.now();
    const rtt = t3 - t0;
    if (rtt < 0 || rtt > 2000) return;
    const offset = t1 - (t0 + t3) / 2;

    let c = this.clock[sid];
    if (!c) {
      c = this.clock[sid] = { offset: offset, rtt: rtt, samples: 1 };
    } else {
      const a = 0.3;
      c.offset = c.offset * (1 - a) + offset * a;
      c.rtt = c.rtt * (1 - a) + rtt * a;
      c.samples++;
    }

    this.lastPing = Math.max(1, Math.round(rtt / 2));
    if (this.onPingUpdated) this.onPingUpdated(this.lastPing);
  }

  /**
   * Turn a peer's state packet into a target position for *now*, then hand it
   * to the player. The engine itself never touches the <video> element.
   */
  _onState(sid, data) {
    const cause = data.cause || 'state';
    if (cause === 'heartbeat') {
      if (this.isLeader) return;                 // leaders don't follow
      if (sid !== this.leaderSid()) return;      // only the leader corrects
    }

    const position = Number(data.position) || 0;
    const paused = !!data.paused;
    const rate = Number(data.rate) || 1.0;

    const c = this.clock[sid];
    let elapsed = 0;
    if (!paused) {
      if (c && c.samples > 0 && typeof data.sent_at === 'number') {
        elapsed = (Date.now() - (data.sent_at - c.offset)) / 1000;
      } else if (c) {
        elapsed = (c.rtt / 2) / 1000;
      }
      if (!(elapsed > 0)) elapsed = 0;
      if (elapsed > 5) elapsed = 5;
    }

    const target = paused ? position : position + elapsed * rate;

    if (this.onRemoteState) {
      this.onRemoteState({
        cause: cause,
        position: position,
        target: target,
        paused: paused,
        rate: rate,
        duration: Number(data.duration) || 0,
        sid: sid,
        sname: data.sname || (this.peersMap[sid] && this.peersMap[sid].username) || 'Friend',
        rtt: c ? Math.round(c.rtt) : 0
      });
    }
  }

  _dropPeer(sid, reason) {
    if (!this.peersMap[sid]) return;
    const p = this.peersMap[sid];
    delete this.peersMap[sid];
    delete this.clock[sid];
    delete this.lastSeq[sid];
    console.log(`[Sync] Peer removed: ${sid} (${reason})`);
    this._notifyPeerCount();
    if (this.onPeerDisconnected) this.onPeerDisconnected(sid, p);
    if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
    if (Object.keys(this.peersMap).length === 0) {
      this._updateStatus('ready', this.isHost ? 'Friend disconnected. Waiting...' : 'Alone in room.');
    }
  }

  _prunePeers() {
    const now = Date.now();
    for (const sid in this.peersMap) {
      if (now - this.peersMap[sid].lastSeen > PEER_TIMEOUT_MS) {
        this._dropPeer(sid, 'timeout');
      }
    }
  }

  /* ====================================================================
     Voice peer (PeerJS) — signalling for audio only
     ==================================================================== */
  _getPeerConfig() {
    return {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.relay.metered.ca:80' },
          {
            urls: 'turn:global.relay.metered.ca:80',
            username: '1cf2d79f96fff8c808bf9920',
            credential: 'mBOMO6wq0kfXKWgP'
          },
          {
            urls: 'turn:global.relay.metered.ca:80?transport=tcp',
            username: '1cf2d79f96fff8c808bf9920',
            credential: 'mBOMO6wq0kfXKWgP'
          },
          {
            urls: 'turn:global.relay.metered.ca:443',
            username: '1cf2d79f96fff8c808bf9920',
            credential: 'mBOMO6wq0kfXKWgP'
          },
          {
            urls: 'turns:global.relay.metered.ca:443?transport=tcp',
            username: '1cf2d79f96fff8c808bf9920',
            credential: 'mBOMO6wq0kfXKWgP'
          }
        ],
        iceCandidatePoolSize: 10
      }
    };
  }

  /**
   * Unique per client — the 3-digit code is only a prefix, so nobody can ever
   * squat someone else's id and there is no `unavailable-id` failure path.
   */
  _initVoicePeer(code) {
    if (typeof Peer === 'undefined') return;
    try {
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
    } catch (e) {}

    this.peerReady = false;
    const wanted = `uwt-voice-${code}-${this.sid}`;
    try {
      this.peer = new Peer(wanted, this._getPeerConfig());
    } catch (err) {
      console.warn('[Sync] Voice peer init failed (voice chat unavailable):', err);
      this.peer = null;
      return;
    }

    this.peer.on('open', (id) => {
      this.voiceId = id;
      this.peerReady = true;
      console.log(`[Sync] Voice peer ready: ${id}`);
      this._sendHello();
      if (this.onVoiceReady) this.onVoiceReady(id);
    });

    this.peer.on('error', (err) => {
      // Voice is optional: log it, never surface it as a sync failure.
      console.warn('[Sync] Voice peer error (sync unaffected):', err.type || err);
    });

    this.peer.on('disconnected', () => {
      if (this.peer && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (e) {}
      }
    });
  }

  /* ====================================================================
     Misc
     ==================================================================== */
  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      /* user denied or not permitted — harmless */
    }
  }

  _setupVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this._acquireWakeLock();
      if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (e) {}
      }
      if (this.roomId && (!this.cloudWs || this.cloudWs.readyState !== WebSocket.OPEN)) {
        console.log('[Sync] Foreground: relay is down, reconnecting now');
        clearTimeout(this.cloudWsReconnectTimer);
        this.reconnectAttempts = 0;
        this._connectRelay(this.roomId).catch(() => this._scheduleReconnect());
      } else if (this.roomId) {
        this._sendHello();
        this.requestState();
      }
    });
  }

  _updateStatus(status, detail) {
    if (this.onStatusChange) this.onStatusChange(status, detail || '');
  }

  _notifyPeerCount() {
    if (this.onPeerCountChanged) this.onPeerCountChanged(this.getRemotePeerCount());
  }

  destroy() {
    this._send('bye', {});
    this.roomId = null;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.helloTimer);
    clearInterval(this.clockTimer);
    clearInterval(this.pruneTimer);
    clearTimeout(this.joinTimer);
    this._teardownRelay();
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
    this.peersMap = {};
    this.peerReady = false;
  }
}

window.SyncEngine = SyncEngine;
