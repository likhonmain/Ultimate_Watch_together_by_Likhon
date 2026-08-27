/**
 * Watch Together by Likhon — P2P Synchronization Engine (WebRTC via PeerJS)
 * Ultra-resilient connection manager with Google STUN cluster, auto-retry,
 * NAT keep-alive, visibility reconnection, and WakeLock support.
 */

class SyncEngine {
  constructor() {
    this.peer = null;
    this.connections = []; // Active DataChannel connections
    this.isHost = false;
    this.roomId = null;
    this.localPeerId = null;
    this.isRemoteUpdate = false;
    this.lastPing = 0;
    this.heartbeatTimer = null;
    this.pingTimer = null;
    this.keepAliveTimer = null;
    this.connectTimeoutTimer = null;
    this.peerReady = false;
    this.wakeLock = null;
    this.retryAttempts = 0;

    this.localUsername = localStorage.getItem('wt_username') || localStorage.getItem('wt_nickname') || ('User_' + Math.floor(100 + Math.random() * 900));
    this.peersMap = {}; // peerId -> { isSelf, peerId, username, role, isHost, status, joinedAt }

    // Cloud WebSocket Relay Configuration & State
    this.cloudWs = null;
    this.cloudWsUrl = 'wss://138-68-159-46.sslip.io/ws';
    this.cloudWsConnected = false;
    this.cloudWsPingTimer = null;
    this.cloudWsReconnectTimer = null;
    this.cloudPeerCount = 0;

    // Callbacks
    this.onStatusChange = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onActionReceived = null;
    this.onChatReceived = null;
    this.onFileInfoReceived = null;
    this.onPingUpdated = null;
    this.onPeerCountChanged = null;
    this.onPeerListChanged = null;

    this._setupVisibilityListener();
  }

  getUsername() {
    return this.localUsername;
  }

  setUsername(name) {
    if (!name) return;
    this.localUsername = name.trim();
    localStorage.setItem('wt_username', this.localUsername);
    localStorage.setItem('wt_nickname', this.localUsername);

    this.broadcast({
      type: 'username_update',
      username: this.localUsername,
      sender: this.localPeerId
    });

    if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN && this.roomId) {
      try {
        this.cloudWs.send(JSON.stringify({
          type: 'join',
          room: String(this.roomId),
          user: this.localUsername
        }));
      } catch (e) {}
    }

    if (this.onPeerListChanged) {
      this.onPeerListChanged(this.getPeerList());
    }
  }

  getPeerList() {
    const list = [
      {
        isSelf: true,
        peerId: this.localPeerId || 'local',
        username: this.localUsername,
        role: this.isHost ? 'Host' : 'Guest',
        isHost: this.isHost,
        status: 'online',
        joinedAt: Date.now()
      }
    ];
    for (const pid in this.peersMap) {
      list.push(this.peersMap[pid]);
    }
    return list;
  }

  /**
   * ICE Servers: Google STUN (for direct P2P) + Metered.ca TURN (for relay through NAT/firewalls)
   * TURN relay is essential for mobile data (4G/5G symmetric NAT) connections.
   */
  _getPeerConfig() {
    return {
      debug: 1,
      config: {
        iceServers: [
          // Google STUN cluster (fast direct P2P when possible)
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.relay.metered.ca:80' },
          // Metered.ca Global TURN relay (punches through mobile/symmetric NAT)
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
   * Initialize PeerJS instance with clean error handling and reconnects
   */
  init(customId = null) {
    return new Promise((resolve, reject) => {
      if (this.peer && !this.peer.destroyed) {
        this.peer.destroy();
      }

      this.peerReady = false;
      const options = this._getPeerConfig();

      console.log(`[Sync] Initializing Peer${customId ? ' with room: ' + customId : ''}...`);
      this._updateStatus('connecting', 'Connecting to signaling network...');

      try {
        if (customId) {
          this.peer = new Peer(customId, options);
        } else {
          this.peer = new Peer(options);
        }
      } catch (err) {
        console.error('[Sync] Peer constructor error:', err);
        this._updateStatus('error', 'Peer initialization failed.');
        return reject(err);
      }

      this.peer.on('open', (id) => {
        this.localPeerId = id;
        this.peerReady = true;
        console.log(`[Sync] Peer opened successfully. ID: ${id}`);
        this._updateStatus('ready', this.isHost ? `Room Ready: ${id}` : 'Connected to network');
        this._acquireWakeLock();
        resolve(id);
      });

      this.peer.on('connection', (conn) => {
        console.log(`[Sync] Incoming connection from peer: ${conn.peer}`);
        this._setupConnection(conn, false);
      });

      this.peer.on('error', (err) => {
        console.warn('[Sync] Peer error event:', err.type, err.message);

        if (err.type === 'unavailable-id') {
          // Collision: retry with fresh 3-digit random number
          const newCode = String(Math.floor(100 + Math.random() * 900));
          console.log('[Sync] Room code taken, trying fresh 3-digit code:', newCode);
          this.roomId = newCode;
          this.init(newCode).then(resolve).catch(reject);
          return;
        } else if (err.type === 'peer-unavailable') {
          this._updateStatus('error', 'Host room not found or Host is offline.');
        } else if (err.type === 'network') {
          this._updateStatus('error', 'Network error. Check internet connection.');
        } else {
          this._updateStatus('error', err.type || 'Connection issue');
        }
        reject(err);
      });

      this.peer.on('disconnected', () => {
        console.warn('[Sync] Signaling server disconnected. Attempting reconnect...');
        if (this.peer && !this.peer.destroyed) {
          try {
            this.peer.reconnect();
          } catch (e) {}
        }
      });
    });
  }

  /**
   * Host creates a room (3-digit random number only)
   */
  async createRoom() {
    const randomCode = String(Math.floor(100 + Math.random() * 900));
    this.isHost = true;
    this.roomId = randomCode;

    // Connect to Cloud WebSocket Relay alongside PeerJS
    this._connectCloudRelay(randomCode);

    await this.init(randomCode);
    this._startHeartbeat();
    return randomCode;
  }

  /**
   * Client joins an existing room with connection timeout & retry
   */
  async joinRoom(targetRoomId) {
    targetRoomId = String(targetRoomId).trim();
    this.isHost = false;
    this.roomId = targetRoomId;
    this.retryAttempts = 0;

    // Connect to Cloud WebSocket Relay alongside PeerJS
    this._connectCloudRelay(targetRoomId);

    if (!this.peer || this.peer.destroyed || !this.peerReady) {
      await this.init();
    }

    this._connectToHostWithRetry(targetRoomId);
    return targetRoomId;
  }

  /**
   * Connect to the Cloud WebSocket Relay (wss://138-68-159-46.sslip.io/ws)
   * in addition to / alongside PeerJS WebRTC.
   */
  _connectCloudRelay(roomId) {
    if (!roomId) return;
    const cleanRoom = String(roomId).trim();

    if (this.cloudWs) {
      try {
        this.cloudWs.onopen = null;
        this.cloudWs.onmessage = null;
        this.cloudWs.onerror = null;
        this.cloudWs.onclose = null;
        this.cloudWs.close();
      } catch (e) {}
      this.cloudWs = null;
    }
    clearInterval(this.cloudWsPingTimer);
    clearTimeout(this.cloudWsReconnectTimer);

    try {
      console.log(`[Sync] Connecting to Cloud WebSocket Relay: ${this.cloudWsUrl} (Room: ${cleanRoom})`);
      this.cloudWs = new WebSocket(this.cloudWsUrl);

      this.cloudWs.onopen = () => {
        console.log('[Sync] Cloud WebSocket Relay connected successfully!');
        this.cloudWsConnected = true;

        // When a 3-digit room is created or joined, register on the cloud relay:
        // {"type": "join", "room": roomId, "user": username}
        const joinPacket = {
          type: 'join',
          room: cleanRoom,
          user: this.getUsername()
        };
        this.cloudWs.send(JSON.stringify(joinPacket));

        // Ensure ping/pong keepalive is sent every 15s to maintain 4G/5G connections
        this.cloudWsPingTimer = setInterval(() => {
          if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
            try {
              this.cloudWs.send(JSON.stringify({
                type: 'ping',
                timestamp: Date.now()
              }));
            } catch (e) {}
          }
        }, 15000);
      };

      this.cloudWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this._handleCloudRelayMessage(data);
        } catch (err) {
          console.warn('[Sync] Could not parse cloud relay message:', err);
        }
      };

      this.cloudWs.onerror = (err) => {
        console.warn('[Sync] Cloud WebSocket Relay error:', err);
      };

      this.cloudWs.onclose = () => {
        console.log('[Sync] Cloud WebSocket Relay disconnected.');
        this.cloudWsConnected = false;
        clearInterval(this.cloudWsPingTimer);

        // Auto-reconnect after 3s if user is still in room
        if (this.roomId) {
          this.cloudWsReconnectTimer = setTimeout(() => {
            if (this.roomId) {
              console.log('[Sync] Reconnecting to Cloud WebSocket Relay...');
              this._connectCloudRelay(this.roomId);
            }
          }, 3000);
        }
      };
    } catch (err) {
      console.error('[Sync] Failed to initialize Cloud WebSocket Relay:', err);
    }
  }

  /**
   * Process incoming messages from Cloud WebSocket Relay
   */
  _handleCloudRelayMessage(data) {
    if (!data || !data.type) return;

    // 1. Action packet from Cloud Relay:
    // {"type": "action", "room": roomId, "action": {"type": "play"/"pause"/"seek", "time": currentTime}}
    if (data.type === 'action' && data.action) {
      const act = data.action;
      const actType = act.type;
      const actTime = typeof act.time === 'number' ? act.time : parseFloat(act.time || 0);

      this.isRemoteUpdate = true;

      // Apply action to local video player
      if (window.player && window.player.video) {
        const v = window.player.video;
        if (actType === 'play') {
          v.currentTime = actTime;
          if (act.rate) v.playbackRate = act.rate;
          v.play().catch(e => console.warn('[Player] Remote play blocked:', e));
          if (window.player._showGestureAnimation) window.player._showGestureAnimation('Play (Synced)');
          if (window.player._hideCenterPlayCard) window.player._hideCenterPlayCard();
        } else if (actType === 'pause') {
          v.currentTime = actTime;
          v.pause();
          if (window.player._showGestureAnimation) window.player._showGestureAnimation('Pause (Synced)');
          if (window.player._showCenterPlayCard) window.player._showCenterPlayCard();
        } else if (actType === 'seek') {
          v.currentTime = actTime;
          if (window.player._showGestureAnimation && window.player._formatTime) {
            window.player._showGestureAnimation(`Seek: ${window.player._formatTime(actTime)}`);
          }
        } else if (actType === 'start_watching') {
          v.currentTime = actTime || 0;
          v.play().catch(e => console.warn('[Player] Autoplay blocked:', e));
          if (window.player._showGestureAnimation) window.player._showGestureAnimation('🎬 Started Watching Together!');
          if (window.player._hideCenterPlayCard) window.player._hideCenterPlayCard();
          if (window.showToast) window.showToast('🎬 Friend started watching together!', true, 4000);
        }
      }

      // Trigger onActionReceived callback
      if (this.onActionReceived) {
        this.onActionReceived({
          type: actType,
          time: actTime,
          rate: act.rate || 1.0,
          timestamp: Date.now()
        });
      }

      setTimeout(() => { this.isRemoteUpdate = false; }, 350);
      return;
    }

    // 2. Direct play/pause/seek from mpvEx / legacy clients
    if (data.type === 'play' || data.type === 'pause' || data.type === 'seek') {
      const actTime = typeof data.time === 'number' ? data.time : parseFloat(data.time || 0);
      this.isRemoteUpdate = true;

      if (window.player && window.player.video) {
        const v = window.player.video;
        if (data.type === 'play') {
          v.currentTime = actTime;
          if (data.rate) v.playbackRate = data.rate;
          v.play().catch(() => {});
        } else if (data.type === 'pause') {
          v.currentTime = actTime;
          v.pause();
        } else if (data.type === 'seek') {
          v.currentTime = actTime;
        }
      }

      if (this.onActionReceived) {
        this.onActionReceived(data);
      }

      setTimeout(() => { this.isRemoteUpdate = false; }, 350);
      return;
    }

    // 3. Chat message from Cloud Relay:
    // {"type": "chat", "room": roomId, "chat": {"sender": username, "text": text, "time": Date.now()}}
    if (data.type === 'chat') {
      let sender = 'Friend';
      let text = '';
      let timestamp = Date.now();

      if (data.chat && typeof data.chat === 'object') {
        sender = data.chat.sender || data.sender_name || 'Friend';
        text = data.chat.text || '';
        timestamp = data.chat.time || Date.now();
      } else {
        sender = data.sender_name || data.sender || 'Friend';
        text = data.text || '';
        timestamp = data.timestamp || Date.now();
      }

      // Do not duplicate own messages
      if (sender === this.getUsername()) return;

      if (text && this.onChatReceived) {
        this.onChatReceived({
          text: text,
          sender: sender,
          timestamp: timestamp
        });
      }
      return;
    }

    // 4. Room / Peer presence updates from Cloud Relay
    if (data.type === 'room_joined' || data.type === 'peer_joined' || data.type === 'peer_left') {
      if (typeof data.peer_count === 'number') {
        this.cloudPeerCount = data.peer_count;
        this._notifyPeerCount();
      }

      if (data.type === 'peer_joined') {
        const name = data.username || data.user || 'Friend';
        if (name !== this.getUsername()) {
          this._updateStatus('connected', 'Connected with friend!');
          if (this.onChatReceived) {
            this.onChatReceived({
              text: `🎉 ${name} joined the room`,
              sender: 'System',
              timestamp: Date.now()
            });
          }
        }
      } else if (data.type === 'peer_left') {
        if (this.connections.length === 0 && this.cloudPeerCount <= 1) {
          this._updateStatus('ready', this.isHost ? 'Friend disconnected. Waiting...' : 'Connection closed.');
        }
      }
    }
  }

  _connectToHostWithRetry(targetRoomId) {
    this._updateStatus('connecting', `Connecting to ${targetRoomId}...`);
    console.log(`[Sync] Connecting to room ${targetRoomId} (Attempt ${this.retryAttempts + 1})`);

    const conn = this.peer.connect(targetRoomId, {
      reliable: true
    });

    this._setupConnection(conn, true);

    // Timeout guard: If connection isn't open in 7 seconds, retry
    clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.connections.length === 0 && this.retryAttempts < 3) {
        this.retryAttempts++;
        console.log(`[Sync] Connection timed out. Retrying attempt ${this.retryAttempts}...`);
        this._updateStatus('connecting', `Retrying connection (Attempt ${this.retryAttempts + 1}/3)...`);
        this._connectToHostWithRetry(targetRoomId);
      } else if (this.connections.length === 0) {
        this._updateStatus('error', 'Could not reach Host. Make sure Host has the webpage open on screen.');
      }
    }, 7000);
  }

  /**
   * Setup active connection with bidirectional handshake & keep-alive
   */
  _setupConnection(conn, isInitiator) {
    conn.on('open', () => {
      console.log(`[Sync] DataChannel OPEN with peer: ${conn.peer}`);
      clearTimeout(this.connectTimeoutTimer);
      this.retryAttempts = 0;

      if (!this.connections.find(c => c.peer === conn.peer)) {
        this.connections.push(conn);
      }

      this._updateStatus('connected', `Connected with friend!`);
      this._notifyPeerCount();

      if (this.onPeerConnected) {
        this.onPeerConnected(conn.peer);
      }

      // Initial Handshake with display name
      try {
        conn.send({
          type: 'handshake',
          role: this.isHost ? 'host' : 'guest',
          sender: this.localPeerId,
          username: this.getUsername(),
          timestamp: Date.now()
        });
      } catch (e) {}

      if (this.isHost) {
        this._startHeartbeat();
      }
      this._startPing();
      this._startKeepAlive();
    });

    conn.on('data', (data) => {
      this._handleIncomingData(data, conn);
    });

    conn.on('close', () => {
      console.log(`[Sync] DataChannel closed with peer: ${conn.peer}`);
      this.connections = this.connections.filter(c => c.peer !== conn.peer);
      delete this.peersMap[conn.peer];
      this._notifyPeerCount();

      if (this.onPeerListChanged) {
        this.onPeerListChanged(this.getPeerList());
      }

      if (this.onPeerDisconnected) {
        this.onPeerDisconnected(conn.peer);
      }

      if (this.connections.length === 0) {
        this._updateStatus('ready', this.isHost ? 'Friend disconnected. Waiting...' : 'Connection closed. Tap Reconnect.');
      } else {
        this._updateStatus('connected', `Connected with ${this.connections.length} peer(s)`);
      }
    });

    conn.on('error', (err) => {
      console.warn(`[Sync] DataChannel error with ${conn.peer}:`, err);
    });
  }

  /**
   * Process incoming messages
   */
  _handleIncomingData(data, conn) {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'handshake':
        console.log(`[Sync] Handshake received from ${conn.peer} (${data.username})`);
        this.peersMap[conn.peer] = {
          isSelf: false,
          peerId: conn.peer,
          username: data.username || 'Friend',
          role: data.role === 'host' ? 'Host' : 'Guest',
          isHost: data.role === 'host',
          status: 'online',
          joinedAt: data.timestamp || Date.now()
        };
        // Reply with handshake_ack so both sides know the other's username
        try {
          conn.send({
            type: 'handshake_ack',
            role: this.isHost ? 'host' : 'guest',
            sender: this.localPeerId,
            username: this.getUsername(),
            timestamp: Date.now()
          });
        } catch (e) {}
        this._updateStatus('connected', 'Connected with friend!');
        if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
        break;

      case 'handshake_ack':
        console.log(`[Sync] Handshake ACK received from ${conn.peer} (${data.username})`);
        this.peersMap[conn.peer] = {
          isSelf: false,
          peerId: conn.peer,
          username: data.username || 'Friend',
          role: data.role === 'host' ? 'Host' : 'Guest',
          isHost: data.role === 'host',
          status: 'online',
          joinedAt: data.timestamp || Date.now()
        };
        if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
        break;

      case 'username_update':
        if (this.peersMap[conn.peer]) {
          const oldName = this.peersMap[conn.peer].username;
          this.peersMap[conn.peer].username = data.username || 'Friend';
          if (this.onPeerListChanged) this.onPeerListChanged(this.getPeerList());
          if (window.showToast) {
            window.showToast(`👤 ${oldName} is now "${data.username}"`, true, 3000);
          }
          if (this.onChatReceived) {
            this.onChatReceived({
              text: `👤 ${oldName} changed name to "${data.username}"`,
              sender: 'System',
              timestamp: Date.now()
            });
          }
        }
        break;

      case 'keepalive':
        // UDP NAT hole-punch keep-alive
        break;

      case 'play':
      case 'pause':
      case 'seek':
      case 'rate':
      case 'start_watching':
        this.isRemoteUpdate = true;
        if (this.onActionReceived) this.onActionReceived(data);
        setTimeout(() => { this.isRemoteUpdate = false; }, 350);
        break;

      case 'heartbeat':
        if (!this.isHost && this.onActionReceived) {
          this.onActionReceived(data);
        }
        break;

      case 'chat':
        if (this.onChatReceived) this.onChatReceived(data);
        break;

      case 'file_info':
        if (this.onFileInfoReceived) this.onFileInfoReceived(data);
        break;

      case 'ping':
        try {
          conn.send({ type: 'pong', sendTime: data.sendTime });
        } catch (e) {}
        break;

      case 'pong':
        const rtt = Date.now() - data.sendTime;
        this.lastPing = Math.max(1, Math.round(rtt / 2));
        if (this.onPingUpdated) this.onPingUpdated(this.lastPing);
        break;
    }
  }

  broadcast(data) {
    if (this.isRemoteUpdate) return;
    if (!this.connections || this.connections.length === 0) return;

    for (const conn of this.connections) {
      if (conn.open) {
        try {
          conn.send(data);
        } catch (e) {
          console.warn('[Sync] Broadcast error:', e);
        }
      }
    }
  }

  /**
   * Send playback action to Cloud WebSocket Relay:
   * {"type": "action", "room": roomId, "action": {"type": "play"/"pause"/"seek", "time": currentTime}}
   */
  sendCloudAction(actionType, currentTime) {
    if (!this.cloudWs || this.cloudWs.readyState !== WebSocket.OPEN || !this.roomId) return;
    if (this.isRemoteUpdate) return;

    try {
      const cur = typeof currentTime === 'number' ? currentTime : parseFloat(currentTime || 0);
      const pkt = {
        type: 'action',
        room: String(this.roomId),
        action: {
          type: actionType,
          time: cur
        }
      };
      this.cloudWs.send(JSON.stringify(pkt));
    } catch (e) {
      console.warn('[Sync] Send cloud action error:', e);
    }
  }

  /**
   * Broadcast chat message to Cloud WebSocket Relay:
   * {"type": "chat", "room": roomId, "chat": {"sender": username, "text": text, "time": Date.now()}}
   */
  sendCloudChat(text, sender) {
    if (!this.cloudWs || this.cloudWs.readyState !== WebSocket.OPEN || !this.roomId) return;
    try {
      const pkt = {
        type: 'chat',
        room: String(this.roomId),
        chat: {
          sender: sender || this.getUsername(),
          text: text,
          time: Date.now()
        }
      };
      this.cloudWs.send(JSON.stringify(pkt));
    } catch (e) {
      console.warn('[Sync] Send cloud chat error:', e);
    }
  }

  sendPlay(currentTime, playbackRate) {
    this.broadcast({ type: 'play', time: currentTime, rate: playbackRate, timestamp: Date.now() });
    this.sendCloudAction('play', currentTime);
  }

  sendPause(currentTime) {
    this.broadcast({ type: 'pause', time: currentTime, timestamp: Date.now() });
    this.sendCloudAction('pause', currentTime);
  }

  sendSeek(currentTime) {
    this.broadcast({ type: 'seek', time: currentTime, timestamp: Date.now() });
    this.sendCloudAction('seek', currentTime);
  }

  sendAction(actionType, time = 0) {
    this.broadcast({ type: actionType, time: time, timestamp: Date.now() });
    this.sendCloudAction(actionType, time);
  }

  sendRate(rate) {
    this.broadcast({ type: 'rate', rate: rate, timestamp: Date.now() });
  }

  sendChat(text, sender) {
    const currentName = sender || this.getUsername();
    const msg = { type: 'chat', text: text, sender: currentName, timestamp: Date.now() };
    this.broadcast(msg);
    this.sendCloudChat(text, currentName);
    return msg;
  }

  sendFileInfo(name, size, duration) {
    this.broadcast({ type: 'file_info', name: name, size: size, duration: duration });
  }

  /**
   * NAT Keep-Alive packet every 2.5s (prevents router/cellular NAT timeout)
   */
  _startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.connections.length > 0) {
        for (const conn of this.connections) {
          if (conn.open) {
            try {
              conn.send({ type: 'keepalive' });
            } catch (e) {}
          }
        }
      }
    }, 2500);
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.isHost && window.player && this.connections.length > 0) {
        const v = window.player.video;
        if (v && !isNaN(v.duration) && v.duration > 0) {
          this.broadcast({
            type: 'heartbeat',
            time: v.currentTime,
            isPlaying: !v.paused,
            rate: v.playbackRate,
            timestamp: Date.now()
          });
        }
      }
    }, 2000);
  }

  _startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.connections.length > 0) {
        for (const conn of this.connections) {
          if (conn.open) {
            try {
              conn.send({ type: 'ping', sendTime: Date.now() });
            } catch (e) {}
          }
        }
      }
    }, 4000);
  }

  /**
   * Screen WakeLock: Keeps screen & network radio awake on Android
   */
  async _acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('[Sync] Screen WakeLock acquired (prevents sleep & disconnect)');
      } catch (err) {
        console.log('[Sync] WakeLock not allowed:', err);
      }
    }
  }

  /**
   * When user returns to tab (e.g. after sending WhatsApp link), check & re-establish
   */
  _setupVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[Sync] Tab returned to foreground');
        this._acquireWakeLock();

        // Reconnect signaling if disconnected
        if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
          try {
            this.peer.reconnect();
          } catch (e) {}
        }

        // If client lost host connection, retry joining
        if (!this.isHost && this.roomId && this.connections.length === 0) {
          console.log('[Sync] Retrying connection to host after foreground return...');
          this._connectToHostWithRetry(this.roomId);
        }
      }
    });
  }

  _updateStatus(status, detail = '') {
    if (this.onStatusChange) this.onStatusChange(status, detail);
  }

  _notifyPeerCount() {
    const totalCount = Math.max(
      this.connections.length,
      Math.max(0, (this.cloudPeerCount || 1) - 1)
    );
    if (this.onPeerCountChanged) {
      this.onPeerCountChanged(totalCount);
    }
  }

  destroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
    if (this.cloudWsPingTimer) clearInterval(this.cloudWsPingTimer);
    clearTimeout(this.cloudWsReconnectTimer);
    if (this.cloudWs) {
      try {
        this.cloudWs.onclose = null;
        this.cloudWs.onerror = null;
        this.cloudWs.onmessage = null;
        this.cloudWs.close();
      } catch (e) {}
      this.cloudWs = null;
    }
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    if (this.peer) this.peer.destroy();
    this.connections = [];
    this.peerReady = false;
  }
}

window.SyncEngine = SyncEngine;
