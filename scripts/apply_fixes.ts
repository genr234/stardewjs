/**
 * Reapply the hand fixes that make ILSpy's output of Stardew Valley.dll compile.
 *
 * ILSpy 11 produces 18 errors across ~357k lines. They fall into four families:
 *   A. a missing assembly reference (handled in the csproj, not here)
 *   B. C# 12 primary-constructor field initializers that reference a *field*
 *      instead of the constructor parameter
 *   C. compiler-generated local functions ILSpy failed to re-inline
 *   D. two scope artifacts (a `goto` crossing a pattern variable, and a static
 *      local function still referencing its display class)
 * Run from anywhere; paths resolve relative to the repo root.
 */
import { join } from "node:path";
import { edit, editLines, PatchError } from "./patch.ts";

export const repoRoot = join(import.meta.dir, "..");
export const defaultSrc = join(repoRoot, "src", "decompiled", "StardewValley");

// Bodies recovered by decompiling the compiler-generated methods individually:
//   0x0600103F <MakeMapModifications>g__ShowSkillMastery|162_0
//   0x06004124 <ApplySaveFix>g__HandleItem|24
//   0x060043B9 <receiveLeftClick>g__ContinueDemolish|3
// All captured variables are already locals at the insertion point, so each one
// becomes an ordinary local function (callable before its declaration).
const SHOW_SKILL_MASTERY = String.raw`				void ShowSkillMastery(int skill, Vector2 spritePosition)
				{
					uint num = Game1.player.stats.Get(StatKeys.Mastery(skill));
					if (levelsNotSpent > 0 && num == 0)
					{
						temporarySprites.Add(new TemporaryAnimatedSprite("LooseSprites\\Cursors_1_6", new Microsoft.Xna.Framework.Rectangle(16, 110, 7, 9), spritePosition * 4f, flipped: false, 0f, Color.White)
						{
							animationLength = 15,
							interval = 50f,
							totalNumberOfLoops = 999999,
							scale = 4f,
							id = 8765 + skill
						});
					}
					else if (num != 0)
					{
						MasteryTrackerMenu.addSkillFlairPlaque(skill);
					}
					Game1.changeMusicTrack("Upper_Ambient");
				}
`;

const HANDLE_ITEM = String.raw`			bool HandleItem(in ForEachItemContext context)
			{
				if (!(context.Item is Object obj))
				{
					return true;
				}
				string value = obj.preservedParentSheetIndex.Value;
				if (value == null || value == "0")
				{
					obj.preservedParentSheetIndex.Value = null;
					return true;
				}
				if (!obj.isRecipe.Value && !(obj is ColoredObject))
				{
					Object obj2 = null;
					switch (context.Item.QualifiedItemId)
					{
					case "(O)344":
						obj2 = objTypeDefinition.CreateFlavoredJelly(ItemRegistry.Create<Object>("(O)" + value));
						break;
					case "(O)350":
						obj2 = objTypeDefinition.CreateFlavoredJuice(ItemRegistry.Create<Object>("(O)" + value));
						break;
					case "(O)342":
						obj2 = objTypeDefinition.CreateFlavoredPickle(ItemRegistry.Create<Object>("(O)" + value));
						break;
					case "(O)348":
						obj2 = objTypeDefinition.CreateFlavoredWine(ItemRegistry.Create<Object>("(O)" + value));
						break;
					}
					if (obj2 != null)
					{
						obj2.Name = obj.Name;
						obj2.Price = obj.Price;
						obj2.Stack = obj.Stack;
						obj2.Quality = obj.Quality;
						obj2.CanBeGrabbed = obj.CanBeGrabbed;
						obj2.CanBeSetDown = obj.CanBeSetDown;
						obj2.Edibility = obj.Edibility;
						obj2.Fragility = obj.Fragility;
						obj2.HasBeenInInventory = obj.HasBeenInInventory;
						obj2.questId.Value = obj.questId.Value;
						obj2.questItem.Value = obj.questItem.Value;
						foreach (KeyValuePair<string, string> pair in obj.modData.Pairs)
						{
							obj2.modData[pair.Key] = pair.Value;
						}
						context.ReplaceItemWith(obj2);
					}
				}
				return true;
			}
`;

const CONTINUE_DEMOLISH = String.raw`			void ContinueDemolish()
			{
				if (Action != CarpentryAction.Demolish || destroyed == null || !farm.buildings.Contains(destroyed))
				{
					return;
				}
				if (destroyed.daysOfConstructionLeft.Value > 0 || destroyed.daysUntilUpgrade.Value > 0)
				{
					Game1.addHUDMessage(new HUDMessage(Game1.content.LoadString("Strings\\UI:Carpenter_CantDemolish_DuringConstruction"), 3));
					return;
				}
				if (interior is AnimalHouse animalHouse && animalHouse.animalsThatLiveHere.Count > 0)
				{
					Game1.addHUDMessage(new HUDMessage(Game1.content.LoadString("Strings\\UI:Carpenter_CantDemolish_AnimalsHere"), 3));
					return;
				}
				if (interior != null && interior.farmers.Any())
				{
					Game1.addHUDMessage(new HUDMessage(Game1.content.LoadString("Strings\\UI:Carpenter_CantDemolish_PlayerHere"), 3));
					return;
				}
				if (cabin != null)
				{
					foreach (Farmer allFarmer in Game1.getAllFarmers())
					{
						if (allFarmer.currentLocation != null && allFarmer.currentLocation.Name == cabin.GetCellarName())
						{
							Game1.addHUDMessage(new HUDMessage(Game1.content.LoadString("Strings\\UI:Carpenter_CantDemolish_PlayerHere"), 3));
							return;
						}
					}
					if (cabin.IsOwnerActivated)
					{
						Game1.addHUDMessage(new HUDMessage(Game1.content.LoadString("Strings\\UI:Carpenter_CantDemolish_FarmhandOnline"), 3));
						return;
					}
				}
				destroyed.BeforeDemolish();
				Chest chest = null;
				if (cabin != null)
				{
					List<Item> list = cabin.demolish();
					if (list.Count > 0)
					{
						chest = new Chest(playerChest: true);
						chest.fixLidFrame();
						chest.Items.OverwriteWith(list);
					}
				}
				if (farm.destroyStructure(destroyed))
				{
					Game1.flashAlpha = 1f;
					destroyed.showDestroyedAnimation(TargetLocation);
					Game1.playSound("explosion");
					Utility.spreadAnimalsAround(destroyed, farm);
					DelayedAction.functionAfterDelay(returnToCarpentryMenu, 1500);
					freeze = true;
					if (chest != null)
					{
						farm.objects[new Vector2(destroyed.tileX.Value + destroyed.tilesWide.Value / 2, destroyed.tileY.Value + destroyed.tilesHigh.Value / 2)] = chest;
					}
				}
			}
`;

export function applyFixes(srcRoot = defaultSrc): void {
  // --- B. primary-constructor field initializers -------------------------------
  // Only the field-initializer lines are illegal, so target those lines.
  editLines(srcRoot, "StardewValley/InteriorDoorDictionary.cs", [
    [18, "_dict.FieldDict", "dict.FieldDict"],
  ]);
  editLines(srcRoot, "Netcode/NetRootDictionary.cs", [
    [15, "_roots.GetEnumerator", "roots.GetEnumerator"],
  ]);
  editLines(srcRoot, "Netcode/NetDictionary.cs", [
    [68, "_net.dict", "net.dict"],
    [160, "_net.dict", "net.dict"],
    [229, "_dict.GetEnumerator", "dict.GetEnumerator"],
  ]);

  // --- D. scope artifacts ------------------------------------------------------
  edit(srcRoot, "StardewValley.Internal/ForEachItemHelper.cs", [
    [
      "return CombinePath(((_003C_003Ec__DisplayClass4_0<TItem>)this).getParentPath, ((_003C_003Ec__DisplayClass4_0<TItem>)this).list);",
      "return CombinePath(getParentPath, list);",
      1,
    ],
  ]);

  // `goto IL_0207` jumps out of the "(O)" case into a shared tail that still uses
  // `objectData`, so hoist the declaration above the switch.
  edit(srcRoot, "StardewValley/ItemContextTagManager.cs", [
    [
      '\t\t\tswitch (itemType.Identifier)\n\t\t\t{\n\t\t\tcase "(BC)":',
      '\t\t\tObjectData objectData = dataOrErrorItem.RawData as ObjectData;\n\t\t\tswitch (itemType.Identifier)\n\t\t\t{\n\t\t\tcase "(BC)":',
      1,
    ],
    [
      "\t\t\t\tif (!(dataOrErrorItem.RawData is ObjectData objectData))\n\t\t\t\t{\n\t\t\t\t\tbreak;\n\t\t\t\t}",
      "\t\t\t\tif (objectData == null)\n\t\t\t\t{\n\t\t\t\t\tbreak;\n\t\t\t\t}",
      1,
    ],
  ]);

  // --- C. local functions ILSpy dropped ---------------------------------------
  edit(srcRoot, "StardewValley/GameLocation.cs", [
    [
      "\t\t\t\tShowSkillMastery(4, new Vector2(54f, 98f));\n",
      SHOW_SKILL_MASTERY + "\t\t\t\tShowSkillMastery(4, new Vector2(54f, 98f));\n",
      1,
    ],
  ]);

  edit(srcRoot, "StardewValley.SaveMigrations/SaveMigrator_1_6.cs", [
    [
      "\t\t\tUtility.ForEachItemContext(HandleItem);\n",
      HANDLE_ITEM + "\t\t\tUtility.ForEachItemContext(HandleItem);\n",
      1,
    ],
    [
      "using StardewValley.ItemTypeDefinitions;",
      "using StardewValley.Internal;\nusing StardewValley.ItemTypeDefinitions;",
      1,
    ],
  ]);

  edit(srcRoot, "StardewValley.Menus/CarpenterMenu.cs", [
    [
      "\t\t\tCabin cabin2 = cabin;\n",
      CONTINUE_DEMOLISH + "\t\t\tCabin cabin2 = cabin;\n",
      1,
    ],
    [
      "using StardewValley.Locations;",
      "using StardewValley.Locations;\nusing StardewValley.Objects;",
      1,
    ],
  ]);

  // --- platform: no Steam / GOG in a browser (or in this prototype) ------------
  edit(srcRoot, "StardewValley/Program.cs", [
    ["_sdk = new SteamHelper();", "_sdk = new NullSDKHelper();", 1],
  ]);
}

function runCli(): void {
  try {
    applyFixes();
    console.log("all fixes applied");
  } catch (error) {
    if (error instanceof PatchError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

if (import.meta.main) runCli();
