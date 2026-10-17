import { createArt } from "./art.mjs";
import { createGameData } from "./game-data";
import { createTooltips } from "./tooltips.mjs";

// One game data cache per server instance (game-data.ts says how it is kept fresh).
const gameData = createGameData();

/** The killboard's game art and tooltips for the API's current build; call once per request. */
export async function loadGameArt() {
  const data = await gameData.get();
  return { art: createArt(data), tooltips: createTooltips(), data };
}

export type GameArt = Awaited<ReturnType<typeof loadGameArt>>;
export type KillboardArt = GameArt["art"];
