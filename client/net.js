// Transports. Every transport exposes the same interface to the game:
//   on('open'|'close'|'msg'|'snap', fn), send(json), sendBinary(bytes), close(),
//   rtt / jitter (ms) measured with pings on the game-traffic path.
//
//  * Net      – dedicated server: WebSocket, upgraded to an unreliable/unordered
//               WebRTC DataChannel for inputs, snapshots and pings when available.
//  * PeerNet  – serverless guest: WebRTC straight to the hosting player (p2p.js).
//  * LocalNet – the hosting player's own client, an in-memory loopback (p2p.js).
import { MSG, SnapshotDecoder, decodePong, encodePing } from '../shared/protocol.js';

const CHANNEL = { ordered: false, maxRetransmits: 0, negotiated: true, id: 0 };

export class Transport {
  constructor(kind) {
    this.handlers = {};
    this.rtt = 100;       // smoothed round trip (ms)
    this.jitter = 5;      // smoothed rtt deviation (ms)
    this.samples = 0;
    this.connected = false;
    this.bytesIn = 0; this.bytesOut = 0;
    this.transport = kind;
    this._pingTimer = null;
    this.snaps = new SnapshotDecoder();
  }

  // newest snapshot we hold, for the server to send deltas against
  get snapAck() { return this.snaps.latest; }

  on(type, fn) { this.handlers[type] = fn; }
  emit(type, data) { const h = this.handlers[type]; if (h) h(data); }

  onBinary(ab) {
    this.bytesIn += ab.byteLength;
    const dv = new DataView(ab);
    const type = dv.getUint8(0);
    if (type === MSG.SNAP || type === MSG.SNAPD) {
      const snap = this.snaps.decode(ab);
      if (snap) this.emit('snap', snap);
    }
    else if (type === MSG.PONG) this.onPong(decodePong(dv));
  }

  schedulePing(delay) {
    clearTimeout(this._pingTimer);
    this._pingTimer = setTimeout(() => {
      if (!this.connected) return;
      this.sendBinary(encodePing(performance.now()));
      this.schedulePing(this.samples < 10 ? 100 : 500);
    }, delay);
  }

  stopPing() { clearTimeout(this._pingTimer); }

  onPong({ clientTime }) {
    const rtt = performance.now() - clientTime;
    if (this.samples === 0) { this.rtt = rtt; this.jitter = rtt * 0.1; }
    else {
      this.jitter += (Math.abs(rtt - this.rtt) - this.jitter) * 0.125;
      this.rtt += (rtt - this.rtt) * 0.125;
    }
    this.samples++;
  }
}

export class Net extends Transport {
  constructor() {
    super('websocket');
    this.ws = null;
    this.pc = null; this.dc = null;
    let allow = true;
    try { allow = localStorage.getItem('caput.rtc') !== '0'; } catch { /* ignore */ }
    this.allowRtc = allow && typeof RTCPeerConnection !== 'undefined';
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.emit('open');
      this.schedulePing(0);
    };
    ws.onclose = () => {
      const wasOpen = this.connected;
      this.connected = false;
      this.stopPing();
      this.closeRtc();
      this.emit('close', { wasOpen });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.bytesIn += ev.data.length;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome' && msg.rtc && this.allowRtc) this.startRtc();
        else if (msg.t === 'rtc') { this.onRtcSignal(msg); return; }
        this.emit('msg', msg);
        return;
      }
      this.onBinary(ev.data);
    };
  }

  close() { if (this.ws) this.ws.close(); }

  // ------------------------------------------------------------ WebRTC upgrade

  startRtc() {
    this.send({ t: 'rtcStart' });
    this._rtcTimeout = setTimeout(() => { if (this.transport !== 'webrtc') this.closeRtc(); }, 8000);
  }

  async onRtcSignal(msg) {
    try {
      if (msg.sdp && msg.sdp.type === 'offer') {
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.pc = pc;
        const dc = pc.createDataChannel('game', CHANNEL);
        dc.binaryType = 'arraybuffer';
        this.dc = dc;
        dc.onopen = () => {
          this.transport = 'webrtc';
          this.samples = Math.min(this.samples, 3); // re-converge RTT on the new path
        };
        dc.onclose = () => { this.transport = 'websocket'; };
        dc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onBinary(e.data); };
        pc.onicecandidate = (e) => {
          if (e.candidate && e.candidate.candidate) this.send({ t: 'rtc', candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid } });
        };
        await pc.setRemoteDescription(msg.sdp);
        for (const c of this._pendingCand || []) await pc.addIceCandidate(c).catch(() => {});
        this._pendingCand = null;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ t: 'rtc', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } else if (msg.candidate) {
        if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(msg.candidate);
        else (this._pendingCand = this._pendingCand || []).push(msg.candidate);
      }
    } catch (e) {
      console.warn('WebRTC unavailable, staying on WebSocket', e);
      this.closeRtc();
    }
  }

  closeRtc() {
    clearTimeout(this._rtcTimeout);
    this.transport = 'websocket';
    try { if (this.dc) this.dc.close(); } catch { /* ignore */ }
    try { if (this.pc) this.pc.close(); } catch { /* ignore */ }
    this.dc = null; this.pc = null;
  }

  // ------------------------------------------------------------ send

  send(obj) {
    if (!this.connected) return;
    const s = JSON.stringify(obj);
    this.bytesOut += s.length;
    this.ws.send(s);
  }

  sendBinary(buf) {
    this.bytesOut += buf.byteLength;
    if (this.dc && this.dc.readyState === 'open' && this.dc.bufferedAmount < 64 * 1024) {
      try { this.dc.send(buf); return; } catch { /* fall back */ }
    }
    if (!this.connected || this.ws.readyState !== 1) return;
    this.ws.send(buf);
  }
}
