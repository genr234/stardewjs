using System;
using System.Threading.Tasks;
using Microsoft.JSInterop;

namespace StardewValley.Web;

/// <summary>
/// KNI's Game.Exit() throws and a page can't close itself, so quitting runs the
/// desktop teardown, flushes saves to IndexedDB, and stops the frame loop.
/// Exit() is called mid-update, so this only records the request; the loop in
/// <see cref="WebProgram" /> does the teardown between frames.
/// </summary>
public static class BrowserExit
{
	private static IJSInProcessRuntime _js;

	private static bool _shuttingDown;

	public static bool Requested { get; private set; }

	public static void Initialize(IJSInProcessRuntime js)
	{
		_js = js;
	}

	/// <summary>Replaces GameRunner.Exit(). Called every frame while Game1.quit is set.</summary>
	public static void Request()
	{
		Requested = true;
	}

	public static async Task ShutdownAsync()
	{
		if (_shuttingDown)
		{
			return;
		}
		_shuttingDown = true;
		Console.WriteLine("[exit] The game asked to quit; shutting down.");
		Notify("exiting", null);

		// Same as the desktop Exiting handler: drop multiplayer peers now, not on timeout.
		try
		{
			GameRunner.instance?.ExecuteForInstances(delegate(Game1 instance)
			{
				instance.exitEvent(null, null);
			});
		}
		catch (Exception exception)
		{
			Console.WriteLine("[exit] Teardown failed: " + exception.Message);
		}

		// Voices live on the page, so looping cues would outlive the stopped runtime.
		try
		{
			_js?.InvokeVoid("browserAudio.stopAll");
		}
		catch (Exception exception)
		{
			Console.WriteLine("[exit] Could not stop audio: " + exception.Message);
		}

		// Saves are in an in-memory filesystem the tab takes with it; this is the
		// last chance to commit them, and the one failure worth showing.
		string error = null;
		try
		{
			await BrowserSaveStorage.FlushAsync();
		}
		catch (Exception exception)
		{
			error = exception.Message;
			Console.WriteLine("[exit] Could not commit saves: " + exception);
		}
		Notify("exited", error);
	}

	private static void Notify(string phase, string error)
	{
		try
		{
			_js?.InvokeVoid("browserExit.report", phase, error ?? string.Empty);
		}
		catch (Exception exception)
		{
			Console.WriteLine("[exit] Could not report '" + phase + "': " + exception.Message);
		}
	}
}
