/**
 * Watch Together by Likhon — Subtitle Parser & Sync Utility
 * Supports SRT & WebVTT parsing, real-time cue lookup, and offset sync.
 */

class SubtitleManager {
  constructor() {
    this.cues = [];
    this.offsetMs = 0; // Offset in milliseconds
    this.enabled = true;
    this.fontSize = 1.35; // rem
  }

  /**
   * Parse SRT or VTT content into structured cues
   * @param {string} content - Raw subtitle file text
   */
  parse(content) {
    this.cues = [];
    if (!content || typeof content !== 'string') return;

    // Normalize line endings
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Check if it's WebVTT
    const isVtt = normalized.trim().startsWith('WEBVTT');

    // Split by double newline blocks
    const blocks = normalized.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (!lines || lines.length < 2) continue;

      let timeLineIdx = 0;
      // If line 0 is a number index or VTT header/note, look at line 1
      if (!lines[0].includes('-->') && lines.length > 1 && lines[1].includes('-->')) {
        timeLineIdx = 1;
      } else if (!lines[0].includes('-->')) {
        continue;
      }

      const timeMatch = lines[timeLineIdx].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{2,3})/);
      if (!timeMatch) continue;

      const startTime = this._parseTimestamp(timeMatch[1]);
      const endTime = this._parseTimestamp(timeMatch[2]);
      const text = lines.slice(timeLineIdx + 1).join('\n').trim();

      if (startTime !== null && endTime !== null && text) {
        this.cues.push({
          start: startTime,
          end: endTime,
          text: this._cleanSubtitleText(text)
        });
      }
    }

    // Sort cues chronologically
    this.cues.sort((a, b) => a.start - b.start);
    console.log(`[Subtitles] Loaded ${this.cues.length} cues.`);
  }

  /**
   * Convert timestamp string (00:01:23,456 or 00:01:23.456) to seconds
   */
  _parseTimestamp(timeStr) {
    const parts = timeStr.replace(',', '.').split(':');
    if (parts.length === 3) {
      const hours = parseFloat(parts[0]);
      const minutes = parseFloat(parts[1]);
      const seconds = parseFloat(parts[2]);
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const minutes = parseFloat(parts[0]);
      const seconds = parseFloat(parts[1]);
      return minutes * 60 + seconds;
    }
    return null;
  }

  /**
   * Clean up formatting tags like <i>, <b>, <font>
   */
  _cleanSubtitleText(text) {
    return text
      .replace(/<[^>]+>/g, '') // remove HTML tags
      .replace(/\{[^\}]+\}/g, ''); // remove SSA/ASS style tags
  }

  /**
   * Adjust subtitle offset (delay or advance)
   * @param {number} deltaMs - positive or negative milliseconds (e.g. +250 or -250)
   */
  adjustOffset(deltaMs) {
    this.offsetMs += deltaMs;
    console.log(`[Subtitles] Offset is now ${this.offsetMs}ms`);
    return this.offsetMs;
  }

  setOffset(ms) {
    this.offsetMs = ms;
    return this.offsetMs;
  }

  resetOffset() {
    this.offsetMs = 0;
    return this.offsetMs;
  }

  /**
   * Get active subtitle text for the given video time in seconds
   * @param {number} currentTimeSeconds
   */
  getCurrentText(currentTimeSeconds) {
    if (!this.enabled || this.cues.length === 0) return '';

    // Apply offset (positive offset means subtitle appears later)
    const effectiveTime = currentTimeSeconds - (this.offsetMs / 1000);

    // Fast binary search or linear search for active cue
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      if (effectiveTime >= cue.start && effectiveTime <= cue.end) {
        return cue.text;
      }
      if (cue.start > effectiveTime + 10) {
        // Cues are sorted; if we are past by 10s, stop checking
        break;
      }
    }
    return '';
  }

  clear() {
    this.cues = [];
    this.offsetMs = 0;
  }
}

window.SubtitleManager = SubtitleManager;
