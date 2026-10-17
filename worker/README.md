# Killboard worker

Records every player ship loss in Citadel into the killboard's database, which the game data API's
kill routes serve (`https://api.thecitadel.com/v1/kills…`) and wrecks.gg reads. It runs on the
replay VM (`replay-dashboard`, project `citadel-replays`) as `killboard-worker.service`, beside the
replay dashboard and the Discord kill feed, whose data folder it shares.

1. It follows live main-build recordings through their build's own replay scanner (from the
   retained runtime in R2, `REPLAY_RUNTIME_REMOTE`), breaches first, and stores every player death in
   breaches and hubs as a kill keyed `<replayId>:<sequence>`: its card facts (names, zone, ore value,
   fitting and cargo), the game's definition ids, and its attackers. Rescanning rewrites the same rows.
   A reconnect loss of a ship whose breach death is recorded within 24 hours is not a second kill.
2. It works through earlier recordings with a player death, newest first: those the dashboard's
   `analytics.sqlite` saw a ship lost in, and those in the kill feed's `posted.jsonl`. A recording
   whose build has no live scanner is imported from its cached dashboard report, without names or value.
3. When a recording is scanned to its end, its kills are grouped into battles (kills within two
   minutes of each other) and the scan is recorded in `kb_scans`, so it is not scanned again.
4. Every two minutes it copies the kill cam viewer and clip links the kill feed recorded in
   `posted.jsonl` onto their kills.

The schema, `lib/killboard/schema.sql`, is applied on every start (`--migrate` applies it and exits).
Readers see a kill once it is listed (`listed_at`): five minutes after it happened, or 30 seconds
after a late write. The API's role, `killboard_api`, reads only the public views.

## Configuration

`/etc/citadel-replays.env` on the VM: `KILLBOARD_DATABASE_URL` (the Postgres service in the Railway
project `citadel-game-data`, through its public TCP proxy, `sslmode=no-verify` for its self-signed
certificate), `REPLAY_DATABASE_URL` (the recordings, read-only, `sslmode=verify-full`),
`REPLAY_DATA_ROOT`, and `REPLAY_RUNTIME_REMOTE` with its `RCLONE_CONFIG_R2_*` credentials. The VM has
.NET for the scanners and rclone for the runtimes.

## Develop and deploy

    npm install
    npm test                  # PGlite, no database needed
    deploy/deploy.sh          # the committed worker/ to the VM; needs gcloud access to citadel-replays

One-off backfills, dry runs unless `--apply`, run on the VM from `/srv/killboard-worker/current`:
`backfill-killboard-definitions.js` (definition ids from each build's db.json) and
`backfill-killboard-regions.js` (zone ids from the recordings, zone names from `/v1/zones`).

The kill card facts themselves come from the replay scanner, `Citadel.ReplayScan` in the monorepo
(`tools/ship-restore/dotnet`), which each main build ships in its runtime; a change there reaches
recordings of the builds made after it.
