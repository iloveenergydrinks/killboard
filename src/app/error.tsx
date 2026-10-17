"use client";

import { Unavailable } from "./_components/components";

/** The game data API could not answer this page: the board shows its "signal lost" state. */
export default function KillboardError() {
  return <Unavailable />;
}
