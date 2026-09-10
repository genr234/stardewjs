using Microsoft.JSInterop;

namespace StardewValley.Web;

/// <summary>
/// A page can't move the pointer, so KNI throws from SetPosition, which the game
/// calls when a controller connects. Instead we dispatch a synthetic mousemove.
/// </summary>
public static class BrowserMouse
{
	private static IJSInProcessRuntime _js;

	public static void Initialize(IJSInProcessRuntime js)
	{
		_js = js;
	}

	public static void SetPosition(int x, int y)
	{
		_js?.InvokeVoid("browserInput.setMousePosition", x, y);
	}
}
