-- The killboard's database. The killboard worker (killboard.js) owns and applies this schema;
-- its one reader, the game data API (tools/game-data-api), reads only its public views
-- (kb_public_*) through its own role.
-- Every statement is idempotent, so the worker applies the whole file on each start.

CREATE TABLE IF NOT EXISTS kb_kills (
  id                    text PRIMARY KEY,           -- <replayId>:<sequence>
  replay_id             integer NOT NULL,
  sequence              integer NOT NULL,
  build_sha             text NOT NULL,
  session_kind          text NOT NULL,              -- breach | hub
  occurred_at           timestamptz NOT NULL,
  public_at             timestamptz NOT NULL,       -- occurred_at + the publication delay
  death_cause           text NOT NULL,
  region_id             text NOT NULL DEFAULT '',
  region_name           text NOT NULL DEFAULT '',
  tier                  integer NOT NULL DEFAULT 0,
  is_travel_lane        boolean NOT NULL DEFAULT false,
  victim_user_id        text NOT NULL,
  victim_name           text NOT NULL,
  ship_item_id          text NOT NULL DEFAULT '',
  hull_name             text NOT NULL,
  hull_class            text NOT NULL DEFAULT '',
  hull_rarity           text,
  victim_br             integer NOT NULL DEFAULT 0,
  value_hull            integer,                    -- ore; null when the build kept no card facts
  value_fitting         integer,
  value_cargo           integer,
  value_total           integer,
  total_damage          double precision NOT NULL DEFAULT 0,
  attacker_count        integer NOT NULL DEFAULT 0,
  player_attacker_count integer NOT NULL DEFAULT 0,
  is_pvp                boolean NOT NULL DEFAULT false,
  is_solo               boolean NOT NULL DEFAULT false,
  final_blow_name       text,
  final_blow_user_id    text,
  final_blow_hull       text,
  battle_id             text,
  viewer_url            text,
  clip_url              text,                       -- the kill feed's rendered clip of the fight
  card                  jsonb,                      -- the scanner's kill card, for the kill page
  source                text NOT NULL,              -- live | report
  ingested_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_kills_public_at ON kb_kills (public_at DESC);
CREATE INDEX IF NOT EXISTS kb_kills_occurred_at ON kb_kills (occurred_at DESC);
CREATE INDEX IF NOT EXISTS kb_kills_victim ON kb_kills (victim_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS kb_kills_hull ON kb_kills (hull_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS kb_kills_region ON kb_kills (region_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS kb_kills_value ON kb_kills (value_total DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS kb_kills_battle ON kb_kills (battle_id);
CREATE INDEX IF NOT EXISTS kb_kills_ship_item ON kb_kills (ship_item_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS kb_attackers (
  kill_id       text NOT NULL REFERENCES kb_kills (id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,
  is_player     boolean NOT NULL,
  user_id       text NOT NULL DEFAULT '',
  name          text NOT NULL,
  hull_name     text NOT NULL DEFAULT '',
  hull_class    text NOT NULL DEFAULT '',
  build_rating  integer NOT NULL DEFAULT 0,
  damage        double precision NOT NULL DEFAULT 0,
  shield_damage double precision NOT NULL DEFAULT 0,
  is_final_blow boolean NOT NULL DEFAULT false,
  PRIMARY KEY (kill_id, ordinal)
);

CREATE INDEX IF NOT EXISTS kb_attackers_user ON kb_attackers (user_id) WHERE is_player;

CREATE TABLE IF NOT EXISTS kb_battles (
  id          text PRIMARY KEY,                     -- <replayId>:<first sequence>
  replay_id   integer NOT NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL,
  public_at   timestamptz NOT NULL,                 -- its last kill's
  region_name text NOT NULL DEFAULT '',
  kill_count  integer NOT NULL,
  value_total bigint NOT NULL DEFAULT 0,
  pilot_count integer NOT NULL
);

CREATE INDEX IF NOT EXISTS kb_battles_public_at ON kb_battles (public_at DESC);

CREATE TABLE IF NOT EXISTS kb_scans (
  replay_id  integer PRIMARY KEY,
  state      text NOT NULL,                         -- complete | failed | unsupported
  build_sha  text,
  kill_count integer NOT NULL DEFAULT 0,
  error      text,
  scanned_at timestamptz NOT NULL DEFAULT now()
);

-- The game's definition id (the decimal asset GUID the game data API names it by) of the hull a
-- kill's victim flew, of its final blow's ship and of each attacker's ship; null for kills recorded before the scanner's
-- GUIDs were kept and not yet backfilled (backfill-killboard-definitions.js).
-- Guarded so a worker start on a migrated database takes no table lock, and bounded otherwise.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'kb_kills' AND column_name = 'hull_def')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'kb_kills' AND column_name = 'final_blow_hull_def')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'kb_attackers' AND column_name = 'hull_def') THEN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE kb_kills ADD COLUMN IF NOT EXISTS hull_def text;
    ALTER TABLE kb_kills ADD COLUMN IF NOT EXISTS final_blow_hull_def text;
    ALTER TABLE kb_attackers ADD COLUMN IF NOT EXISTS hull_def text;
  END IF;
END $$;

-- When a kill is listed: from then on readers see it, and the game data API's feed and stream order
-- kills by it. A kill scanned live lists at its public_at. A kill written after its public_at (a
-- backfill, a late scan) lists 30 seconds after the write, so its transaction has committed before a
-- reader's cursor can pass it. The trigger below sets it on every write; no writer does, and a
-- rescan never moves it earlier.
CREATE OR REPLACE FUNCTION kb_kills_listed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.listed_at := greatest(NEW.public_at, now() + interval '30 seconds');
  ELSE
    NEW.listed_at := greatest(OLD.listed_at, NEW.public_at);
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'kb_kills' AND column_name = 'listed_at') THEN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE kb_kills ADD COLUMN listed_at timestamptz;
    UPDATE kb_kills SET listed_at = public_at;
    ALTER TABLE kb_kills ALTER COLUMN listed_at SET NOT NULL;
  END IF;
END $$;

CREATE OR REPLACE TRIGGER kb_kills_listed_at BEFORE INSERT OR UPDATE ON kb_kills
  FOR EACH ROW EXECUTE FUNCTION kb_kills_listed_at();

CREATE INDEX IF NOT EXISTS kb_kills_listed ON kb_kills (listed_at, id);

-- What readers see, and the only place the publication delay is applied: a kill once it is listed,
-- its attackers with it, and a battle once its last kill is public and all its kills are listed.
CREATE OR REPLACE VIEW kb_public_kills AS
  SELECT * FROM kb_kills WHERE listed_at <= now();

CREATE OR REPLACE VIEW kb_public_attackers AS
  SELECT a.* FROM kb_attackers a JOIN kb_kills k ON k.id = a.kill_id WHERE k.listed_at <= now();

CREATE OR REPLACE VIEW kb_public_battles AS
  SELECT b.* FROM kb_battles b
  WHERE b.public_at <= now()
    AND NOT EXISTS (SELECT 1 FROM kb_kills k WHERE k.battle_id = b.id AND k.listed_at > now());

-- The reader, a Neon role made outside this file: the game data API (killboard_api,
-- docs/infrastructure.md). It reads the views and nothing else, and its statements stop after
-- 5 seconds where this role may set that.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'killboard_api') THEN
    REVOKE ALL ON kb_kills, kb_attackers, kb_battles, kb_scans FROM killboard_api;
    GRANT SELECT ON kb_public_kills, kb_public_attackers, kb_public_battles TO killboard_api;
    BEGIN
      ALTER ROLE killboard_api SET statement_timeout = '5s';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'killboard_api keeps its statement timeout: this role cannot alter it';
    END;
  END IF;
END $$;
