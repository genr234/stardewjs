using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Microsoft.JSInterop;

namespace StardewValley.Web;

/// <summary>Copies the game's ordinary save files to durable browser storage.</summary>
public static class BrowserSaveStorage
{
    private static IJSRuntime _js;

    public static async Task RestoreAsync(IJSRuntime js)
    {
        _js = js;
        var files = await js.InvokeAsync<Dictionary<string, string>>("browserSaves.read");
        string root = Path.GetFullPath(Program.GetSavesFolder()) + Path.DirectorySeparatorChar;
        foreach (var file in files)
        {
            string path = Path.GetFullPath(Path.Combine(root, file.Key));
            if (!path.StartsWith(root, StringComparison.Ordinal))
                throw new InvalidDataException("Invalid browser save path: " + file.Key);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllBytes(path, Convert.FromBase64String(file.Value));
        }
        Console.WriteLine("[saves] Restored " + files.Count + " files from IndexedDB into " + root + ".");
    }

    public static async Task FlushAsync()
    {
        string root = Program.GetSavesFolder();
        var files = new Dictionary<string, string>();
        foreach (string path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            files.Add(Path.GetRelativePath(root, path), Convert.ToBase64String(File.ReadAllBytes(path)));
        await _js.InvokeVoidAsync("browserSaves.write", files);
        Console.WriteLine("[saves] Committed " + files.Count + " files to IndexedDB.");
    }
}
