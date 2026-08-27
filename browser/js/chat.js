/**
 * Watch Together by Likhon — Real-Time Synchronized Chat Manager
 * Handles Mobile & Desktop chat streams, notifications, audio chime, and unread badges.
 */

class ChatManager {
  constructor(syncEngine) {
    this.sync = syncEngine;
    this.unreadCount = 0;
    this.nickname = 'Guest';

    // DOM Elements
    this.mpStream = document.getElementById('mp-chat-stream');
    this.mpInput = document.getElementById('mp-chat-input');
    this.mpSendBtn = document.getElementById('mp-chat-send');

    this.dtStream = document.getElementById('desktop-chat-stream');
    this.dtInput = document.getElementById('desktop-chat-input');
    this.dtSendBtn = document.getElementById('desktop-chat-send');

    this.toggleBtn = document.getElementById('chat-toggle-btn');
    this.unreadBadge = document.getElementById('chat-unread-badge');
    this.tabBadge = document.getElementById('chat-tab-badge');

    this.init();
  }

  init() {
    // 1. Nickname Initialization
    this.syncNickname();

    // 2. Mobile Chat Input Wiring
    if (this.mpSendBtn && this.mpInput) {
      const sendMobile = () => {
        const text = this.mpInput.value.trim();
        if (!text) return;
        this.sendChatMessage(text);
        this.mpInput.value = '';
      };
      this.mpSendBtn.addEventListener('click', sendMobile);
      this.mpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendMobile();
      });
    }

    // 3. Desktop Sidebar Chat Input Wiring
    if (this.dtSendBtn && this.dtInput) {
      const sendDesktop = () => {
        const text = this.dtInput.value.trim();
        if (!text) return;
        this.sendChatMessage(text);
        this.dtInput.value = '';
      };
      this.dtSendBtn.addEventListener('click', sendDesktop);
      this.dtInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendDesktop();
      });
    }

    // 4. Header Chat Toggle Button Wiring
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          const chatTabBtn = document.querySelector('.mp-tab-btn[data-tab="mp-tab-chat"]');
          if (chatTabBtn) chatTabBtn.click();
          if (this.mpInput) this.mpInput.focus();
        } else {
          if (this.dtInput) {
            this.dtInput.focus();
            this.dtInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
        this.resetUnreadBadge();
      });
    }

    // 5. Connect incoming sync callback
    if (this.sync) {
      this.sync.onChatReceived = (msg) => this.handleIncomingMessage(msg);
    }
  }

  syncNickname() {
    if (this.sync && this.sync.getUsername) {
      this.nickname = this.sync.getUsername();
    } else {
      const saved = localStorage.getItem('wt_username') || localStorage.getItem('wt_nickname');
      this.nickname = saved || ('User_' + Math.floor(100 + Math.random() * 900));
    }
  }

  getNickname() {
    this.syncNickname();
    return this.nickname;
  }

  setNickname(name) {
    if (!name) return;
    this.nickname = name.trim();
    localStorage.setItem('wt_username', this.nickname);
    localStorage.setItem('wt_nickname', this.nickname);
  }

  sendChatMessage(text) {
    const currentName = this.getNickname();

    // Broadcast to remote peer via sync engine
    if (this.sync && this.sync.sendChat) {
      this.sync.sendChat(text, currentName);
    }

    // Append locally to own streams
    this.appendMessage({
      text: text,
      sender: currentName,
      timestamp: Date.now(),
      isMe: true
    });
  }

  handleIncomingMessage(msg) {
    if (!msg || !msg.text) return;

    this.appendMessage({
      text: msg.text,
      sender: msg.sender || 'Friend',
      timestamp: msg.timestamp || Date.now(),
      isMe: false
    });

    // Check if chat is currently visible to user
    const chatTabPane = document.getElementById('mp-tab-chat');
    const isMobileChatActive = chatTabPane && chatTabPane.classList.contains('active');
    const isDesktop = window.innerWidth > 768;

    if (!isDesktop && !isMobileChatActive) {
      this.unreadCount++;
      this.updateBadge();
    }

    this.playNotificationSound();
  }

  appendMessage({ text, sender, timestamp, isMe }) {
    const timeStr = new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isSystem = sender === 'System';

    const createBubble = () => {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${isSystem ? 'system' : (isMe ? 'me' : 'peer')}`;

      bubble.innerHTML = `
        ${!isMe ? `<div class="chat-sender">${this._escapeHtml(sender)}</div>` : ''}
        <div class="chat-text">${this._escapeHtml(text)}</div>
        <div class="chat-time">${timeStr}</div>
      `;
      return bubble;
    };

    // Append to Mobile stream
    const mpStream = this.mpStream || document.getElementById('mp-chat-stream');
    if (mpStream) {
      mpStream.appendChild(createBubble());
      mpStream.scrollTop = mpStream.scrollHeight;
    }

    // Append to Desktop stream
    const dtStream = this.dtStream || document.getElementById('desktop-chat-stream');
    if (dtStream) {
      dtStream.appendChild(createBubble());
      dtStream.scrollTop = dtStream.scrollHeight;
    }
  }

  resetUnreadBadge() {
    this.unreadCount = 0;
    this.updateBadge();
  }

  updateBadge() {
    if (this.unreadBadge) {
      if (this.unreadCount > 0) {
        this.unreadBadge.innerText = this.unreadCount > 9 ? '9+' : this.unreadCount;
        this.unreadBadge.classList.add('active');
      } else {
        this.unreadBadge.classList.remove('active');
      }
    }

    if (this.tabBadge) {
      if (this.unreadCount > 0) {
        this.tabBadge.innerText = this.unreadCount;
        this.tabBadge.style.display = 'inline-block';
      } else {
        this.tabBadge.style.display = 'none';
      }
    }
  }

  /**
   * Modern 2-tone chime using Web Audio API
   */
  playNotificationSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880, now + 0.08);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.33);
    } catch (e) {
      console.warn('[Chat] Audio chime error:', e);
    }
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
}

window.ChatManager = ChatManager;
