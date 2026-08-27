/**
 * Watch Together by Likhon — Built-in WebRTC Voice Chat Engine
 * Handles microphone capture, peer audio calls, mute/unmute, and voice activity visualization.
 */

class VoiceEngine {
  constructor(syncEngine) {
    this.sync = syncEngine;
    this.localStream = null;
    this.activeCalls = [];
    this.isMuted = false;
    this.isInCall = false;
    this.audioContext = null;
    this.analyser = null;
    this.visualizerInterval = null;

    // Callbacks
    this.onSpeaking = null; // (isSpeaking: boolean) => void
    this.onCallStateChanged = null; // (isInCall: boolean, isMuted: boolean) => void
  }

  /**
   * Initialize incoming call listener
   */
  initCallListener() {
    if (!this.sync || !this.sync.peer) return;

    this.sync.peer.on('call', (call) => {
      console.log(`[Voice] Incoming voice call from ${call.peer}`);
      // Answer with local stream if already in call, or answer receive-only
      if (this.localStream) {
        call.answer(this.localStream);
      } else {
        call.answer(); // receive only
      }
      this._handleCallStream(call);
    });
  }

  /**
   * Start voice call (prompts user for mic permission)
   */
  async startCall() {
    try {
      console.log('[Voice] Requesting microphone access...');
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.isInCall = true;
      this.isMuted = false;
      this._setupAudioAnalyser(this.localStream);

      // Call all connected data peers
      if (this.sync && this.sync.connections) {
        for (const conn of this.sync.connections) {
          console.log(`[Voice] Calling peer: ${conn.peer}`);
          const call = this.sync.peer.call(conn.peer, this.localStream);
          this._handleCallStream(call);
        }
      }

      if (this.onCallStateChanged) {
        this.onCallStateChanged(this.isInCall, this.isMuted);
      }

      return true;
    } catch (err) {
      console.error('[Voice] Could not access microphone:', err);
      alert('Could not access microphone. Please check browser microphone permissions.');
      return false;
    }
  }

  /**
   * Handle remote audio stream
   */
  _handleCallStream(call) {
    this.activeCalls.push(call);

    call.on('stream', (remoteStream) => {
      console.log(`[Voice] Received remote audio stream from ${call.peer}`);
      // Create hidden audio element for remote speech
      let remoteAudio = document.getElementById(`audio-${call.peer}`);
      if (!remoteAudio) {
        remoteAudio = document.createElement('audio');
        remoteAudio.id = `audio-${call.peer}`;
        remoteAudio.autoplay = true;
        document.body.appendChild(remoteAudio);
      }
      remoteAudio.srcObject = remoteStream;
    });

    call.on('close', () => {
      console.log(`[Voice] Voice call ended with ${call.peer}`);
      this.activeCalls = this.activeCalls.filter(c => c !== call);
      const el = document.getElementById(`audio-${call.peer}`);
      if (el) el.remove();
    });

    call.on('error', (err) => {
      console.error(`[Voice] Call error with ${call.peer}:`, err);
    });
  }

  /**
   * Toggle mute / unmute
   */
  toggleMute() {
    if (!this.localStream) return;

    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });

    if (this.onCallStateChanged) {
      this.onCallStateChanged(this.isInCall, this.isMuted);
    }
    return this.isMuted;
  }

  /**
   * Voice Activity Detection (VAD) via Web Audio API AnalyserNode
   */
  _setupAudioAnalyser(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.4;
      source.connect(this.analyser);

      const buffer = new Uint8Array(this.analyser.frequencyBinCount);

      if (this.visualizerInterval) clearInterval(this.visualizerInterval);
      this.visualizerInterval = setInterval(() => {
        if (!this.isInCall || this.isMuted) {
          if (this.onSpeaking) this.onSpeaking(false);
          return;
        }

        this.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const average = sum / buffer.length;

        // If average volume exceeds threshold, user is talking
        const isTalking = average > 20;
        if (this.onSpeaking) {
          this.onSpeaking(isTalking);
        }
      }, 100);
    } catch (e) {
      console.warn('[Voice] Audio analyzer not available:', e);
    }
  }

  /**
   * End voice call and release microphone
   */
  endCall() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.visualizerInterval) {
      clearInterval(this.visualizerInterval);
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.activeCalls.forEach(call => call.close());
    this.activeCalls = [];
    this.isInCall = false;
    this.isMuted = false;

    if (this.onCallStateChanged) {
      this.onCallStateChanged(this.isInCall, this.isMuted);
    }
  }
}

window.VoiceEngine = VoiceEngine;
