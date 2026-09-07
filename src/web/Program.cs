using System;
using System.Globalization;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.JSInterop;


namespace StardewValley.Web;

/// <summary>
/// Replaces Program.Main. On Blazor, Run() returns immediately, so the runner
/// lives in a static field instead of the desktop's `using` block.
/// </summary>
public static class WebProgram
{
	private static GameRunner _runner;

	private static IJSInProcessRuntime _js;

	private static DotNetObjectReference<GameLoop> _loopReference;

	public static async Task Main(string[] args)
	{
		WebAssemblyHostBuilder builder = WebAssemblyHostBuilder.CreateDefault(args);
		WebAssemblyHost host = builder.Build();

		_ = host.RunAsync();
		await Task.Yield();

		_js = host.Services.GetService(typeof(IJSRuntime)) as IJSInProcessRuntime;
		Stage("js:" + (_js != null));

		System.Threading.Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
		Program.GameTesterMode = true;

		try
		{
			Stage("constructing");
			_runner = new GameRunner();
			GameRunner.instance = _runner;

			// A fixed time step blocks waiting for the frame deadline, freezing the tab.
			_runner.IsFixedTimeStep = false;

			Stage("running");
			_runner.Run();
			Stage("run-returned");
			ClearBootMessage();

			Stage("loop-start");
			_loopReference = DotNetObjectReference.Create(new GameLoop());
			_js.InvokeVoid("startGameLoop", _loopReference);
		}
		catch (Exception exception)
		{
			// Inner stacks are lost once this is wrapped in an AggregateException.
			Report(exception.ToString());
			throw;
		}
	}

	private static void Stage(string name)
	{
		Console.WriteLine("[stage] " + name);
		try
		{
			_js?.InvokeVoid("reportBootStage", name);
		}
		catch
		{
		}
	}

	private static void Report(string text)
	{
		Console.Error.WriteLine(text);
		try
		{
			_js?.InvokeVoid("reportBootError", text);
		}
		catch
		{
		}
	}

	/// <summary>
	/// Called from requestAnimationFrame. KNI's Blazor StartGameLoop() is empty, and
	/// an await Task.Delay loop starves on Blazor's synchronization context.
	/// </summary>
	public sealed class GameLoop
	{
		private long _frames;

		[JSInvokable]
		public bool Tick()
		{
			if (_runner == null)
			{
				return false;
			}
			try
			{
				_runner.Tick();
				_frames++;
				return true;
			}
			catch (Exception exception)
			{
				_runner = null;
				Report("Game loop stopped after " + _frames + " frames: " + exception);
				return false;
			}
		}

		[JSInvokable]
		public long FrameCount() => _frames;
	}


	private static void ClearBootMessage()
	{
		try
		{
			_js?.InvokeVoid("clearBoot");
		}
		catch (Exception exception)
		{
			Console.WriteLine("Could not clear the boot message: " + exception.Message);
		}
	}
}
