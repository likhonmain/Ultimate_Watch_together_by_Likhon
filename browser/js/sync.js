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

    await this.init(randomCode);
    this._startHeartbeat();
    return randomCode;
  }

  /**
   * Client joins an existing room with connection timeout & retry
   */
  async joinRoom(targetRoomId) {
    targetRoomId = targetRoomId.trim();
    this.isHost = false;
    this.roomId = targetRoomId;
    this.retryAttempts = 0;

    if (!this.peer || this.peer.destroyed || !this.peerReady) {
      await this.init();
    }

    this._connectToHostWithRetry(targetRoomId);
    return targetRoomId;
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

  sendPlay(currentTime, playbackRate) {
    this.broadcast({ type: 'play', time: currentTime, rate: playbackRate, timestamp: Date.now() });
  }

  sendPause(currentTime) {
    this.broadcast({ type: 'pause', time: currentTime, timestamp: Date.now() });
  }

  sendSeek(currentTime) {
    this.broadcast({ type: 'seek', time: currentTime, timestamp: Date.now() });
  }

  sendRate(rate) {
    this.broadcast({ type: 'rate', rate: rate, timestamp: Date.now() });
  }

  sendChat(text, sender) {
    const msg = { type: 'chat', text: text, sender: sender, timestamp: Date.now() };
    this.broadcast(msg);
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
    if (this.onPeerCountChanged) {
      this.onPeerCountChanged(this.connections.length);
    }
  }

  destroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
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
