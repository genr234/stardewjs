// Multiplayer transport, beside the managed runtime. A browser can't listen, so
// both host and farmhand dial out to scripts/relay.ts, which tags each frame
// with its peer. The game polls once per tick, so sockets only fill queues.
(function (root) {
  var RELAY_PATH = '/relay';

  function relayUrl(role, room) {
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

  Endpoint.prototype.drain = function () {
    var events = this.events;
    this.events = [];
    return events;
  };

  var host = new Endpoint();
  var client = new Endpoint();

  var browserNet = {
    // Pass the previous room to keep an invite code that was already shared.
    hostStart: function (room) {
      host.close();
      host.room = null;
      host.open(
        relayUrl('host', room || null),
        function (bytes) {
          var frame = readPeerFrame(bytes);
          if (frame) host.events.push({ k: 'data', peer: frame.peer, b: toBase64(frame.payload) });
        },
        function (message) {
          if (message.type === 'ready') host.room = message.room;
          else if (message.type === 'connect') host.events.push({ k: 'connect', peer: message.peer });
          else if (message.type === 'disconnect') host.events.push({ k: 'disconnect', peer: message.peer });
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
      return host.send(writePeerFrame(peer, fromBase64(base64)));
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
      return true;
    },

    hostStop: function () {
      host.close('stopped');
      host.room = null;
    },

    clientConnect: function (room) {
      client.close();
      client.room = room;
      client.lobby = {};
      client.open(
        relayUrl('client', room),
        function (bytes) {
          client.events.push(toBase64(bytes));
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
      return client.send(fromBase64(base64));
    },

    clientClose: function () {
      client.close('closed');
    },
  };

  root.browserNet = browserNet;
})(typeof globalThis !== 'undefined' ? globalThis : self);
