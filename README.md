# Citadel killboard

Every ship lost in Citadel: the kill feed, battles, pilots, ships, zones and leaderboards, with each
kill's fitting and cargo. It reads everything from the game data API (`https://api.thecitadel.com`),
which owns the killboard's data and its five-minute publication delay; this site keeps no data of
its own.

- `src/lib/api.ts`: the kill routes (`/v1/kills`, `/v1/battles`, `/v1/pilots`, `/v1/leaderboards`),
  shaped into the rows the pages draw.
- `src/lib/game-data.ts`: ship, item and stat names and art (`/v1/hulls`, `/v1/items`, …), cached per
  server for the API's current build.
- `src/app`: the pages (Next.js app router).

## Run

    npm install
    npm run dev          # http://localhost:3000

`GAME_DATA_API_URL` points at another API (default `https://api.thecitadel.com`);
`GAME_DATA_API_CONTACT` sets the contact in the `User-Agent` the API asks for.

## Deploy

Railway project `citadel-killboard`, service `web`: `npm run build`, then `npm start` on `$PORT`.
