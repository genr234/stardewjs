using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json.Serialization;
using Microsoft.JSInterop;
using StardewValley.Network;
using StardewValley.Network.Compress;

namespace StardewValley.Web;

/// <summary>
/// Multiplayer over a WebSocket relay (scripts/relay.ts) instead of Lidgren UDP,
/// since a browser can't listen. Messages are Lidgren's bytes, one per frame.
/// </summary>
public static class BrowserNet
{
	private static IJSInProcessRuntime _js;

	public static void Initialize(IJSInProcessRuntime js)
	{
		_js = js;
	}

	public static bool Available => _js != null;

	internal static TResult Invoke<TResult>(string identifier, params object[] args)
	{
		return _js.Invoke<TResult>(identifier, args);
	}

	internal static void InvokeVoid(string identifier, params object[] args)
	{
		_js.InvokeVoid(identifier, args);
	}

	internal sealed class HostEvent
	{
		/// <summary>One of <c>connect</c>, <c>disconnect</c> or <c>data</c>.</summary>
		[JsonPropertyName("k")]
		public string Kind { get; set; }

		[JsonPropertyName("peer")]
		public int Peer { get; set; }

		[JsonPropertyName("b")]
		public string Body { get; set; }
	}

	internal sealed class ClientState
	{
		[JsonPropertyName("state")]
		public string State { get; set; }

		[JsonPropertyName("room")]
		public string Room { get; set; }

		[JsonPropertyName("lobby")]
		public string Lobby { get; set; }

		[JsonPropertyName("error")]
		public string Error { get; set; }
	}

	internal sealed class HostState
	{
		[JsonPropertyName("state")]
		public string State { get; set; }

		[JsonPropertyName("room")]
		public string Room { get; set; }

		[JsonPropertyName("error")]
		public string Error { get; set; }
	}

	internal static string Encode(OutgoingMessage message)
	{
		byte[] data;
		using (MemoryStream buffer = new MemoryStream())
		{
			using BinaryWriter writer = new BinaryWriter(buffer);
			message.Write(writer);
			data = buffer.ToArray();
		}
		return Convert.ToBase64String(StardewValley.Program.netCompression.CompressAbove(data, 1024));
	}

	internal static void Decode(string body, IncomingMessage into)
	{
		byte[] data = Convert.FromBase64String(body);
		using MemoryStream buffer = new MemoryStream(data);
		Stream source = buffer;
		if (StardewValley.Program.netCompression.TryDecompressStream(buffer, out byte[] decompressed))
		{
			source = new MemoryStream(decompressed);
		}
		using BinaryReader reader = new BinaryReader(source);
		into.Read(reader);
	}
}

public class WebSocketClient : HookableClient
{
	/// <summary>The invite code, where desktop takes an IP address.</summary>
	public readonly string room;

	private bool _validated;

	private bool _disconnected;

	public WebSocketClient(string room)
	{
		this.room = room?.Trim() ?? "";
	}

	/// <inheritdoc />
	public override string getUserID()
	{
		return "";
	}

	/// <inheritdoc />
	protected override string getHostUserName()
	{
		return serverName;
	}

	/// <inheritdoc />
	protected override void connectImpl()
	{
		if (!BrowserNet.Available)
		{
			connectionMessage = "The browser transport is not available.";
			timedOut = true;
			return;
		}
		Game1.log.Verbose("Joining room " + room + " through the relay.");
		BrowserNet.InvokeVoid("browserNet.clientConnect", room);
	}

	/// <inheritdoc />
	public override void disconnect(bool neatly = true)
	{
		if (_disconnected)
		{
			return;
		}
		_disconnected = true;
		if (neatly && !timedOut)
		{
			sendMessage(new OutgoingMessage(19, Game1.player));
		}
		BrowserNet.InvokeVoid("browserNet.clientClose");
		connectionMessage = null;
	}

	/// <inheritdoc />
	protected override void receiveMessagesImpl()
	{
		if (_disconnected || !BrowserNet.Available)
		{
			return;
		}

		BrowserNet.ClientState state = BrowserNet.Invoke<BrowserNet.ClientState>("browserNet.clientState");
		if (state == null)
		{
			return;
		}

		if (!_validated && state.State == "open")
		{
			if (!validateLobby(state))
			{
				return;
			}
		}

		if (state.State == "closed")
		{
			remotelyDisconnected(state.Error);
			return;
		}

		IncomingMessage message = new IncomingMessage();
		try
		{
			foreach (string body in BrowserNet.Invoke<string[]>("browserNet.clientPoll"))
			{
				BrowserNet.Decode(body, message);
				base.OnProcessingMessage(message, sendMessageImpl, delegate
				{
					processIncomingMessage(message);
				});
			}
		}
		finally
		{
			((IDisposable)message).Dispose();
		}
	}

	/// <summary>Stands in for Lidgren discovery: protocol version and farm name come from the relay.</summary>
	private bool validateLobby(BrowserNet.ClientState state)
	{
		Dictionary<string, string> lobby = ParseLobby(state.Lobby);
		if (!lobby.TryGetValue("protocolVersion", out string version))
		{
			// The host is up but has not published yet; try again next frame.
			return false;
		}
		if (version != Multiplayer.protocolVersion)
		{
			Game1.log.Warn($"Failed to connect. The server's protocol ({version}) does not match our own ({Multiplayer.protocolVersion}).");
			connectionMessage = Game1.content.LoadString("Strings\\UI:CoopMenu_FailedProtocolVersion");
			disconnect(neatly: false);
			timedOut = true;
			return false;
		}
		serverName = lobby.GetValueOrDefault("farmName", "Stardew Valley");
		_validated = true;
		return true;
	}

	private static Dictionary<string, string> ParseLobby(string json)
	{
		Dictionary<string, string> lobby = new Dictionary<string, string>();
		if (string.IsNullOrEmpty(json))
		{
			return lobby;
		}
		try
		{
			foreach (KeyValuePair<string, string> entry in System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(json))
			{
				lobby[entry.Key] = entry.Value;
			}
		}
		catch (Exception exception)
		{
			Game1.log.Warn("Could not read the host's lobby data: " + exception.Message);
		}
		return lobby;
	}

	private void remotelyDisconnected(string reason)
	{
		if (_disconnected)
		{
			return;
		}
		_disconnected = true;
		timedOut = true;
		pendingDisconnect = (reason == "kicked")
			? Multiplayer.DisconnectType.Kicked
			: Multiplayer.DisconnectType.LidgrenTimeout;
		if (reason == "no-such-room")
		{
			connectionMessage = null;
		}
		Game1.log.Verbose("Relay connection closed: " + (reason ?? "unknown"));
	}

	private void sendMessageImpl(OutgoingMessage message)
	{
		if (_disconnected)
		{
			return;
		}
		string body = BrowserNet.Encode(message);
		BrowserNet.InvokeVoid("browserNet.clientSend", body);
		bandwidthLogger?.RecordBytesUp(body.Length);
	}

	/// <inheritdoc />
	public override void sendMessage(OutgoingMessage message)
	{
		base.OnSendingMessage(message, sendMessageImpl, delegate
		{
			sendMessageImpl(message);
		});
	}
}

public class WebSocketServer : HookableServer
{
	/// <summary>Marks our connection ids, as "L_" marks Lidgren's.</summary>
	private const string ConnectionPrefix = "W_";

	private readonly Dictionary<long, int> _peersByFarmer = new Dictionary<long, int>();

	private readonly Dictionary<int, long> _farmersByPeer = new Dictionary<int, long>();

	private readonly HashSet<int> _connections = new HashSet<int>();

	private readonly HashSet<int> _introductionsSent = new HashSet<int>();

	private readonly Dictionary<string, string> _lobby = new Dictionary<string, string>();

	private bool _started;

	private string _room;

	public WebSocketServer(IGameServer gameServer)
		: base(gameServer)
	{
	}

	/// <inheritdoc />
	public override int connectionsCount => _connections.Count;

	/// <summary>
	/// True only once the relay answers; menus show a wait dialog until then.
	/// </summary>
	public override bool connected()
	{
		return _started && _room != null;
	}

	/// <inheritdoc />
	public override bool canAcceptIPConnections()
	{
		return true;
	}

	public override string getInviteCode()
	{
		return _room;
	}

	/// <inheritdoc />
	public override void initialize()
	{
		if (!BrowserNet.Available)
		{
			Game1.log.Error("Cannot host: the browser transport is not available.");
			return;
		}
		Game1.log.Verbose("Starting relay server");
		BrowserNet.InvokeVoid("browserNet.hostStart", (object)null);
		_started = true;
		setLobbyData("protocolVersion", Multiplayer.protocolVersion);
	}

	/// <inheritdoc />
	public override void stopServer()
	{
		Game1.log.Verbose("Stopping relay server");
		if (BrowserNet.Available)
		{
			BrowserNet.InvokeVoid("browserNet.hostStop");
		}
		_started = false;
		_room = null;
		_connections.Clear();
		_introductionsSent.Clear();
		_peersByFarmer.Clear();
		_farmersByPeer.Clear();
	}

	/// <inheritdoc />
	public override void setPrivacy(ServerPrivacy privacy)
	{
	}

	/// <inheritdoc />
	public override void setLobbyData(string key, string value)
	{
		_lobby[key] = value ?? "";
		publishLobby();
	}

	private void publishLobby()
	{
		if (!_started || _room == null || _lobby.Count == 0)
		{
			return;
		}
		try
		{
			BrowserNet.Invoke<bool>("browserNet.hostLobby", System.Text.Json.JsonSerializer.Serialize(_lobby));
		}
		catch (Exception exception)
		{
			Game1.log.Warn("Could not publish lobby data: " + exception.Message);
		}
	}

	/// <inheritdoc />
	public override void receiveMessages()
	{
		if (!_started || !BrowserNet.Available)
		{
			return;
		}

		BrowserNet.HostState state = BrowserNet.Invoke<BrowserNet.HostState>("browserNet.hostState");
		if (state?.Room != null && state.Room != _room)
		{
			_room = state.Room;
			Game1.log.Verbose("Relay room ready. Invite code: " + _room);
			publishLobby();
		}
		if (state?.State == "closed")
		{
			// No room ever assigned usually means the server has no relay (the
			// ASP.NET DevServer doesn't; only the Bun host does).
			Game1.log.Error(_room == null
				? "The relay never answered (" + (state.Error ?? "unknown") + "). Multiplayer needs the Bun host - run `bun run web` or `bun run serve` rather than `dotnet run`."
				: "The relay connection closed: " + (state.Error ?? "unknown"));
			_started = false;
			_room = null;
			return;
		}

		IncomingMessage message = new IncomingMessage();
		try
		{
			foreach (BrowserNet.HostEvent relayEvent in BrowserNet.Invoke<BrowserNet.HostEvent[]>("browserNet.hostPoll"))
			{
				switch (relayEvent.Kind)
				{
				case "connect":
					peerConnected(relayEvent.Peer);
					break;
				case "disconnect":
					peerDisconnected(relayEvent.Peer);
					break;
				case "data":
					bandwidthLogger?.RecordBytesDown(relayEvent.Body.Length);
					BrowserNet.Decode(relayEvent.Body, message);
					receiveFromPeer(relayEvent.Peer, message);
					break;
				}
			}
		}
		finally
		{
			((IDisposable)message).Dispose();
		}

		sendPendingIntroductions();
		bandwidthLogger?.Update();
	}

	private void peerConnected(int peer)
	{
		// Same gate as LidgrenServer's connection approval.
		if (!Game1.options.ipConnectionsEnabled && !gameServer.IsLocalMultiplayerInitiatedServer())
		{
			BrowserNet.Invoke<bool>("browserNet.hostKick", peer);
			return;
		}
		_connections.Add(peer);
		onConnect(ConnectionPrefix + peer);
	}

	private void peerDisconnected(int peer)
	{
		_connections.Remove(peer);
		_introductionsSent.Remove(peer);
		onDisconnect(ConnectionPrefix + peer);
		if (_farmersByPeer.TryGetValue(peer, out long farmerId))
		{
			playerDisconnected(farmerId);
		}
	}

	/// <summary>
	/// The farmhand list needs the host's game loaded, so early peers are told to wait.
	/// </summary>
	private void sendPendingIntroductions()
	{
		foreach (int peer in _connections)
		{
			if (_introductionsSent.Contains(peer))
			{
				continue;
			}
			int captured = peer;
			if (!gameServer.whenGameAvailable(delegate
			{
				gameServer.sendAvailableFarmhands("", ConnectionPrefix + captured, delegate(OutgoingMessage msg)
				{
					sendToPeer(captured, msg);
				});
			}, () => Game1.gameMode != 6))
			{
				Game1.log.Verbose("Postponing introduction message");
				sendToPeer(peer, new OutgoingMessage(11, Game1.player, "Strings\\UI:Client_WaitForHostLoad"));
			}
			_introductionsSent.Add(peer);
		}
	}

	private void receiveFromPeer(int peer, IncomingMessage message)
	{
		base.OnProcessingMessage(message, delegate(OutgoingMessage outgoing)
		{
			sendToPeer(peer, outgoing);
		}, delegate
		{
			if (_peersByFarmer.TryGetValue(message.FarmerID, out int known) && known == peer)
			{
				gameServer.processIncomingMessage(message);
			}
			else if (message.MessageType == 2)
			{
				// Approving the farmhand request is what binds the peer to a farmer.
				NetFarmerRoot farmer = Game1.multiplayer.readFarmer(message.Reader);
				gameServer.checkFarmhandRequest("", ConnectionPrefix + peer, farmer, delegate(OutgoingMessage msg)
				{
					sendToPeer(peer, msg);
				}, delegate
				{
					bind(farmer.Value.UniqueMultiplayerID, peer);
				});
			}
		});
	}

	private void bind(long farmerId, int peer)
	{
		if (_peersByFarmer.TryGetValue(farmerId, out int previous))
		{
			_farmersByPeer.Remove(previous);
		}
		if (_farmersByPeer.TryGetValue(peer, out long previousFarmer))
		{
			_peersByFarmer.Remove(previousFarmer);
		}
		_peersByFarmer[farmerId] = peer;
		_farmersByPeer[peer] = farmerId;
	}

	/// <inheritdoc />
	public override void sendMessage(long peerId, OutgoingMessage message)
	{
		if (_peersByFarmer.TryGetValue(peerId, out int peer))
		{
			sendToPeer(peer, message);
		}
	}

	private void sendToPeer(int peer, OutgoingMessage message)
	{
		string body = BrowserNet.Encode(message);
		BrowserNet.Invoke<bool>("browserNet.hostSend", peer, body);
		bandwidthLogger?.RecordBytesUp(body.Length);
	}

	/// <inheritdoc />
	public override void kick(long disconnectee)
	{
		base.kick(disconnectee);
		if (_peersByFarmer.TryGetValue(disconnectee, out int peer))
		{
			BrowserNet.Invoke<bool>("browserNet.hostKick", peer);
			playerDisconnected(disconnectee);
		}
	}

	/// <inheritdoc />
	public override void playerDisconnected(long disconnectee)
	{
		base.playerDisconnected(disconnectee);
		if (_peersByFarmer.TryGetValue(disconnectee, out int peer))
		{
			_farmersByPeer.Remove(peer);
			_introductionsSent.Remove(peer);
		}
		_peersByFarmer.Remove(disconnectee);
	}

	/// <inheritdoc />
	public override bool isConnectionActive(string connectionId)
	{
		return TryParsePeer(connectionId, out int peer) && _connections.Contains(peer);
	}

	/// <inheritdoc />
	public override string getUserId(long farmerId)
	{
		return _peersByFarmer.TryGetValue(farmerId, out int peer) ? ConnectionPrefix + peer : null;
	}

	/// <inheritdoc />
	public override bool hasUserId(string userId)
	{
		return TryParsePeer(userId, out int peer) && _farmersByPeer.ContainsKey(peer);
	}

	/// <inheritdoc />
	public override string getUserName(long farmerId)
	{
		return getUserId(farmerId);
	}

	private static bool TryParsePeer(string connectionId, out int peer)
	{
		peer = 0;
		return connectionId != null
			&& connectionId.StartsWith(ConnectionPrefix, StringComparison.Ordinal)
			&& int.TryParse(connectionId.Substring(ConnectionPrefix.Length), out peer);
	}
}
