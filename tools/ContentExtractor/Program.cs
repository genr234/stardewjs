using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace ContentExtractor;

/// <summary>
/// Unpacks every .xnb in Content to PNG, xTile XML or JSON. Runs as a Game
/// because Texture2D deserialization needs a GraphicsDevice.
/// </summary>
public sealed class Extractor : Game
{
	private readonly Options _options;
	private readonly Dictionary<string, int> _byKind = new();
	private readonly List<string> _failures = new();
	private int _done;

	public Extractor(Options options)
	{
		_options = options;
		var gdm = new GraphicsDeviceManager(this)
		{
			PreferredBackBufferWidth = 64,
			PreferredBackBufferHeight = 64,
			GraphicsProfile = GraphicsProfile.HiDef
		};
		gdm.ApplyChanges();
		Content.RootDirectory = options.ContentRoot;
		Window.Position = new Point(-4000, -4000);
		IsFixedTimeStep = false;
	}

	protected override void LoadContent()
	{
		var assets = Directory
			.EnumerateFiles(_options.ContentRoot, "*.xnb", SearchOption.AllDirectories)
			.Select(path => Path.GetRelativePath(_options.ContentRoot, path))
			.Where(rel => _options.AllLocales || !IsLocalized(rel))
			.OrderBy(rel => rel, StringComparer.Ordinal)
			.ToList();

		Console.WriteLine($"{assets.Count} assets -> {_options.OutputRoot}");
		foreach (string rel in assets)
		{
			Extract(rel);
			if (++_done % 250 == 0)
			{
				Console.WriteLine($"  {_done}/{assets.Count}");
			}
		}

		Report();
		Exit();
	}

	/// <summary>Localized variants are named like "springobjects.ru-RU.xnb".</summary>
	private static bool IsLocalized(string relativePath)
	{
		string name = Path.GetFileNameWithoutExtension(relativePath);
		int dot = name.LastIndexOf('.');
		if (dot < 0 || name.Length - dot - 1 is not (5 or 2))
		{
			return false;
		}
		string tag = name[(dot + 1)..];
		return tag.Length == 2
			? tag.All(char.IsLower)
			: tag[2] == '-' && tag[..2].All(char.IsLower) && tag[3..].All(char.IsUpper);
	}

	private void Extract(string relativePath)
	{
		string assetName = relativePath[..^".xnb".Length];
		object asset;
		try
		{
			asset = Content.Load<object>(assetName);
		}
		catch (Exception ex)
		{
			_failures.Add($"{relativePath}: load failed: {Root(ex).Message}");
			return;
		}

		try
		{
			switch (asset)
			{
				case Texture2D texture:
					WritePng(assetName, texture);
					Count("texture");
					break;
				case xTile.Map map:
					WriteMap(assetName, map);
					Count("map");
					break;
				case SpriteFont font:
					WriteFont(assetName, font);
					Count("font");
					break;
				case Effect:
					// Shaders are HLSL bytecode; the web build needs GLSL written by hand.
					Count("effect (skipped)");
					break;
				default:
					WriteJson(assetName, asset);
					Count("data");
					break;
			}
		}
		catch (Exception ex)
		{
			_failures.Add($"{relativePath}: {asset.GetType().Name}: {Root(ex).Message}");
		}
		finally
		{
			Content.Unload();
		}
	}

	private void WritePng(string assetName, Texture2D texture)
	{
		string path = OutPath("textures", assetName, ".png");
		using var stream = File.Create(path);
		texture.SaveAsPng(stream, texture.Width, texture.Height);
	}

	/// <summary>SaveAsPng refuses compressed and single-channel formats; blit through a render target.</summary>
	private Texture2D ToColor(Texture2D texture)
	{
		if (texture.Format == SurfaceFormat.Color)
		{
			return texture;
		}

		var target = new RenderTarget2D(GraphicsDevice, texture.Width, texture.Height);
		GraphicsDevice.SetRenderTarget(target);
		GraphicsDevice.Clear(Color.Transparent);
		using (var batch = new SpriteBatch(GraphicsDevice))
		{
			batch.Begin(SpriteSortMode.Immediate, BlendState.Opaque);
			batch.Draw(texture, Vector2.Zero, Color.White);
			batch.End();
		}
		GraphicsDevice.SetRenderTarget(null);
		return target;
	}

	private void WriteMap(string assetName, xTile.Map map)
	{
		var model = new
		{
			map.Id,
			map.Description,
			Properties = Props(map.Properties),
			TileSheets = map.TileSheets.Select(sheet => new
			{
				sheet.Id,
				sheet.ImageSource,
				SheetSize = new { sheet.SheetWidth, sheet.SheetHeight },
				TileSize = new { sheet.TileWidth, sheet.TileHeight },
				Margin = new { sheet.MarginWidth, sheet.MarginHeight },
				Spacing = new { sheet.SpacingWidth, sheet.SpacingHeight },
				Properties = Props(sheet.Properties)
			}),
			Layers = map.Layers.Select(EncodeLayer)
		};
		File.WriteAllText(OutPath("maps", assetName, ".json"), JsonSerializer.Serialize(model, CompactJson));
	}

	private static object EncodeLayer(xTile.Layers.Layer layer)
	{
		var palette = new List<object>();
		var lookup = new Dictionary<string, int>();
		var indices = new int[layer.LayerWidth * layer.LayerHeight];

		for (int y = 0, i = 0; y < layer.LayerHeight; y++)
		{
			for (int x = 0; x < layer.LayerWidth; x++, i++)
			{
				object tile = Tile(layer.Tiles[x, y]);
				if (tile is null)
				{
					indices[i] = -1;
					continue;
				}
				string key = JsonSerializer.Serialize(tile, CompactJson);
				if (!lookup.TryGetValue(key, out int index))
				{
					index = palette.Count;
					lookup[key] = index;
					palette.Add(tile);
				}
				indices[i] = index;
			}
		}

		return new
		{
			layer.Id,
			layer.Visible,
			LayerSize = new { layer.LayerWidth, layer.LayerHeight },
			TileSize = new { layer.TileWidth, layer.TileHeight },
			Properties = Props(layer.Properties),
			Palette = palette,
			Tiles = indices
		};
	}

	private static object Tile(xTile.Tiles.Tile tile) => tile switch
	{
		null => null,
		xTile.Tiles.AnimatedTile animated => new
		{
			Sheet = animated.TileSheet?.Id,
			Index = animated.TileIndex,
			Blend = Blend(animated.BlendMode),
			animated.FrameInterval,
			Frames = animated.TileFrames.Select(frame => new { Sheet = frame.TileSheet?.Id, frame.TileIndex }),
			Properties = Props(animated.Properties)
		},
		_ => new
		{
			Sheet = tile.TileSheet?.Id,
			Index = tile.TileIndex,
			Blend = Blend(tile.BlendMode),
			Properties = Props(tile.Properties)
		}
	};

	private static string Blend(xTile.Tiles.BlendMode mode) =>
		mode == xTile.Tiles.BlendMode.Alpha ? null : mode.ToString();

	private static Dictionary<string, string> Props(xTile.ObjectModel.IPropertyCollection properties)
	{
		if (properties is null || properties.Count == 0)
		{
			return null;
		}
		var result = new Dictionary<string, string>(properties.Count);
		foreach (var pair in properties)
		{
			result[pair.Key] = pair.Value?.ToString();
		}
		return result;
	}

	private void WriteFont(string assetName, SpriteFont font)
	{
		using (var stream = File.Create(OutPath("fonts", assetName, ".png")))
		{
			using Texture2D rgba = ToColor(font.Texture);
			rgba.SaveAsPng(stream, rgba.Width, rgba.Height);
		}

		var glyphs = font.GetGlyphs();
		var metrics = new
		{
			font.LineSpacing,
			font.Spacing,
			DefaultCharacter = font.DefaultCharacter?.ToString(),
			Glyphs = glyphs.Select(pair => new
			{
				Character = pair.Key.ToString(),
				Source = Rect(pair.Value.BoundsInTexture),
				Cropping = Rect(pair.Value.Cropping),
				pair.Value.LeftSideBearing,
				pair.Value.RightSideBearing,
				pair.Value.WidthIncludingBearings
			})
		};
		File.WriteAllText(OutPath("fonts", assetName, ".json"), JsonSerializer.Serialize(metrics, JsonOptions));
	}

	private static object Rect(Rectangle r) => new { r.X, r.Y, r.Width, r.Height };

	private void WriteJson(string assetName, object asset)
	{
		File.WriteAllText(OutPath("data", assetName, ".json"), JsonSerializer.Serialize(asset, JsonOptions));
	}

	private static readonly JsonSerializerOptions CompactJson = new()
	{
		WriteIndented = false,
		DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
		ReferenceHandler = ReferenceHandler.IgnoreCycles,
		IncludeFields = true,
		Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
	};

	private static readonly JsonSerializerOptions JsonOptions = new()
	{
		WriteIndented = true,
		DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
		ReferenceHandler = ReferenceHandler.IgnoreCycles,
		IncludeFields = true,
		Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
	};

	private string OutPath(string kind, string assetName, string extension)
	{
		string path = Path.Combine(_options.OutputRoot, kind, assetName + extension);
		Directory.CreateDirectory(Path.GetDirectoryName(path)!);
		return path;
	}

	private void Count(string kind) => _byKind[kind] = _byKind.GetValueOrDefault(kind) + 1;

	private static Exception Root(Exception ex) => ex.InnerException is null ? ex : Root(ex.InnerException);

	private void Report()
	{
		Console.WriteLine();
		foreach ((string kind, int count) in _byKind.OrderByDescending(pair => pair.Value))
		{
			Console.WriteLine($"{count,6}  {kind}");
		}
		Console.WriteLine($"{_failures.Count,6}  failed");

		if (_failures.Count > 0)
		{
			string log = Path.Combine(_options.OutputRoot, "extract-failures.txt");
			File.WriteAllLines(log, _failures);
			Console.WriteLine($"\nfirst failures:");
			foreach (string failure in _failures.Take(15))
			{
				Console.WriteLine($"  {failure}");
			}
			Console.WriteLine($"full list: {log}");
		}
	}

	public sealed record Options(string ContentRoot, string OutputRoot, bool AllLocales);

	public static void Main(string[] args)
	{
		// ContentManager resolves RootDirectory against the app directory, not the
		// working directory, so both roots have to be absolute.
		string content = Path.GetFullPath(Arg(args, "--content") ?? "vendor/game/Content");
		string output = Path.GetFullPath(Arg(args, "--out") ?? "build/web-content");
		bool allLocales = args.Contains("--all-locales");

		if (!Directory.Exists(content))
		{
			Console.Error.WriteLine($"content directory not found: {content}");
			Environment.Exit(1);
		}

		Directory.CreateDirectory(output);

		if (args.Contains("--sounds"))
		{
			SoundBankDump.Run(Path.Combine(content, "XACT"), Path.Combine(output, "audio", "cues.json"));
			return;
		}

		using var extractor = new Extractor(new Options(content, output, allLocales));
		extractor.Run();
	}

	private static string Arg(string[] args, string name)
	{
		int i = Array.IndexOf(args, name);
		return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
	}
}
