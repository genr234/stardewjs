// Multiplayer transport, beside the managed runtime. A browser can't listen, so
// both host and farmhand dial out to scripts/relay.ts, which tags each frame
// with its peer. The game polls once per tick, so sockets only fill queues.
(function (root) {
  var RELAY_PATH = '/relay';

  function relayUrl(role, room, key) {
    // In a worker, location is the script's URL, so its origin is the relay's
    // host. The settings menu can name another relay.
    var base = typeof root.__relayUrl === 'string' ? root.__relayUrl.trim() : '';
    var url;
    if (base) {
      // Accept a bare host, http:// or ws://.
      url = base.replace(/^http/, 'ws');
      if (!/^wss?:\/\//i.test(url)) url = 'ws://' + url;
      url = url.replace(/\/+$/, '');
      if (!new RegExp(RELAY_PATH + '$').test(url)) url += RELAY_PATH;
    } else {
      var origin = (root.location && root.location.origin) || '';
      url = origin.replace(/^http/, 'ws') + RELAY_PATH;
    }
    url += '?role=' + role;
    if (room) url += '&room=' + encodeURIComponent(room);
    if (key) url += '&key=' + encodeURIComponent(key);
    return url;
  }

  // Chunked so the large world-state message on join fits apply()'s argument limit.
  function toBase64(bytes) {
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function asBytes(data, then) {
    if (data instanceof ArrayBuffer) {
      then(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      then(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (data && typeof data.arrayBuffer === 'function') {
      // A Blob, if the browser ignores binaryType.
      data.arrayBuffer().then(function (buffer) { then(new Uint8Array(buffer)); });
      return;
    }
    then(null);
  }

  function readPeerFrame(bytes) {
    if (!bytes || bytes.length < 4) return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { peer: view.getUint32(0, true), payload: bytes.subarray(4) };
  }

  function writePeerFrame(peer, payload) {
    var framed = new Uint8Array(4 + payload.length);
    new DataView(framed.buffer).setUint32(0, peer, true);
    framed.set(payload, 4);
    return framed;
  }

  // A proxy in front of the relay may cap WebSocket messages (Hack Club Nest's
  // drops anything past 16 MB), and a farmhand joining a big farm is sent the
  // whole world in one message. So each game message leads with a byte:
  // WHOLE, or MORE / LAST for the pieces of one split at FRAGMENT_BYTES. The
  // relay forwards the pieces as they are, in order, over one socket.
  var WHOLE = 0;
  var MORE = 1;
  var LAST = 2;
  var FRAGMENT_BYTES = 4 * 1024 * 1024;
  // Past this a sender is refused rather than let it fill the tab's memory.
  var MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

  function fragment(payload) {
    if (payload.length <= FRAGMENT_BYTES) {
      var whole = new Uint8Array(1 + payload.length);
      whole[0] = WHOLE;
      whole.set(payload, 1);
      return [whole];
    }
    var pieces = [];
    for (var at = 0; at < payload.length; at += FRAGMENT_BYTES) {
      var end = Math.min(at + FRAGMENT_BYTES, payload.length);
      var piece = new Uint8Array(1 + end - at);
      piece[0] = end === payload.length ? LAST : MORE;
      piece.set(payload.subarray(at, end), 1);
      pieces.push(piece);
    }
    return pieces;
  }

  function Reassembler() {
    this.parts = [];
    this.size = 0;
  }

  // The finished message, or null while pieces are still arriving (or the
  // input was malformed, which drops whatever was pending).
  Reassembler.prototype.push = function (bytes) {
    if (!bytes || bytes.length < 1) return this.reset();
    var kind = bytes[0];
    var body = bytes.subarray(1);
    if (kind === WHOLE) {
      if (this.parts.length) this.reset();
      return body;
    }
    if (kind !== MORE && kind !== LAST) return this.reset();
    this.size += body.length;
    if (this.size > MAX_MESSAGE_BYTES) return this.reset();
    this.parts.push(body);
    if (kind === MORE) return null;
    var joined = new Uint8Array(this.size);
    var offset = 0;
    for (var i = 0; i < this.parts.length; i++) {
      joined.set(this.parts[i], offset);
      offset += this.parts[i].length;
    }
    this.reset();
    return joined;
  };

  Reassembler.prototype.reset = function () {
    this.parts = [];
    this.size = 0;
    return null;
  };

  function Endpoint() {
    this.socket = null;
    this.state = 'idle';   // idle | connecting | open | closed
    this.room = null;
    this.lobby = {};
    this.error = null;
    this.events = [];
  }

  Endpoint.prototype.close = function (reason) {
    if (this.socket) {
      try { this.socket.close(); } catch (err) {}
      this.socket = null;
    }
    this.state = 'closed';
    if (reason && !this.error) this.error = reason;
  };

  Endpoint.prototype.open = function (url, onBinary, onControl) {
    var self = this;
    this.state = 'connecting';
    this.error = null;
    this.events = [];
    var socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = function () {
      if (self.socket === socket) self.state = 'open';
    };
    socket.onmessage = function (event) {
      if (self.socket !== socket) return;
      if (typeof event.data === 'string') {
        var message = null;
        try { message = JSON.parse(event.data); } catch (err) { return; }
        onControl(message);
        return;
      }
      asBytes(event.data, function (bytes) {
        if (self.socket === socket && bytes) onBinary(bytes);
      });
    };
    socket.onerror = function () {
      if (self.socket === socket && !self.error) self.error = 'socket-error';
    };
    socket.onclose = function (event) {
      if (self.socket !== socket) return;
      self.socket = null;
      self.state = 'closed';
      if (!self.error) self.error = (event && event.reason) || 'closed';
    };
  };

  Endpoint.prototype.send = function (bytes) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(bytes);
    return true;
  };

  // All the pieces of one message, or none of them.
  Endpoint.prototype.sendAll = function (frames) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    for (var i = 0; i < frames.length; i++) this.socket.send(frames[i]);
    return true;
  };

  Endpoint.prototype.drain = function () {
    var events = this.events;
    this.events = [];
    return events;
  };

  var host = new Endpoint();
  var client = new Endpoint();
  // The relay hands a host a key with its code; only that key gets the code
  // back after a drop, so nobody who merely heard it can take the room.
  var roomKeys = {};
  // The host holds one partial message per peer; a client only ever hears the host.
  var fromPeers = {};
  var fromHost = new Reassembler();

  function peerAssembler(peer) {
    return fromPeers[peer] || (fromPeers[peer] = new Reassembler());
  }

  var browserNet = {
    // Pass the previous room to keep an invite code that was already shared.
    hostStart: function (room) {
      host.close();
      host.room = null;
      fromPeers = {};
      host.open(
        relayUrl('host', room || null, room ? roomKeys[room] : null),
        function (bytes) {
          var frame = readPeerFrame(bytes);
          if (!frame) return;
          var message = peerAssembler(frame.peer).push(frame.payload);
          if (message) host.events.push({ k: 'data', peer: frame.peer, b: toBase64(message) });
        },
        function (message) {
          if (message.type === 'ready') {
            host.room = message.room;
            if (message.key) roomKeys[message.room] = message.key;
          }
          else if (message.type === 'connect') host.events.push({ k: 'connect', peer: message.peer });
          else if (message.type === 'disconnect') {
            delete fromPeers[message.peer];
            host.events.push({ k: 'disconnect', peer: message.peer });
          }
          else if (message.type === 'error') host.error = message.reason;
        },
      );
    },

    hostState: function () {
      return { state: host.state, room: host.room, error: host.error };
    },

    hostPoll: function () {
      return host.drain();
    },

    hostSend: function (peer, base64) {
      var pieces = fragment(fromBase64(base64));
      for (var i = 0; i < pieces.length; i++) pieces[i] = writePeerFrame(peer, pieces[i]);
      return host.sendAll(pieces);
    },

    // Stands in for Lidgren discovery: the joining client reads the host's
    // protocol version before committing.
    hostLobby: function (json) {
      if (!host.socket || host.socket.readyState !== 1) return false;
      host.socket.send(JSON.stringify({ type: 'lobby', data: JSON.parse(json) }));
      return true;
    },

    hostKick: function (peer) {
      if (!host.socket || host.socket.readyState !== 1) return false;
      host.socket.send(JSON.stringify({ type: 'kick', peer: peer }));
      delete fromPeers[peer];
      return true;
    },

    hostStop: function () {
      fromPeers = {};
      host.close('stopped');
      host.room = null;
    },

    clientConnect: function (room) {
      client.close();
      client.room = room;
      client.lobby = {};
      fromHost = new Reassembler();
      client.open(
        relayUrl('client', room),
        function (bytes) {
          var message = fromHost.push(bytes);
          if (message) client.events.push(toBase64(message));
        },
        function (message) {
          if (message.type === 'ready') {
            client.room = message.room;
            client.lobby = message.lobby || {};
          } else if (message.type === 'error') {
            client.error = message.reason;
          }
        },
      );
    },

    clientState: function () {
      return {
        state: client.state,
        room: client.room,
        lobby: JSON.stringify(client.lobby || {}),
        error: client.error,
      };
    },

    clientPoll: function () {
      return client.drain();
    },

    clientSend: function (base64) {
      return client.sendAll(fragment(fromBase64(base64)));
    },

    clientClose: function () {
      client.close('closed');
    },
  };

  root.browserNet = browserNet;
})(typeof globalThis !== 'undefined' ? globalThis : self);
