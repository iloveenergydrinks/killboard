"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ensureRuntime } = require("../runtime-bundles");
const { requireLiveRuntime } = require("../scanner");
const { listLiveReplays, listReplays } = require("../kill-feed/live-replays");
const { ReplayFollower } = require("../kill-feed/replay-follower");
const { killRows } = require("./rows");

// As the kill feed: a recording is live while its newest chunk is this recent.
const LIVE_WINDOW_SECONDS = 10 * 60;
const STARTED_WITHIN_SECONDS = 3 * 24 * 60 * 60;
const RUNTIME_RETRY_MILLISECONDS = 5 * 60 * 1000;
// Loading a build's asset database briefly needs several gigabytes; stagger those peaks.
const MAX_LOADING_FOLLOWERS = 2;
const BACKLOG_REFRESH_MILLISECONDS = 10 * 60 * 1000;
const VIEWER_REFRESH_MILLISECONDS = 2 * 60 * 1000;
const STATUS_INTERVAL_MILLISECONDS = 60 * 1000;

/**
 * Keeps the killboard database current. It follows live main-build recordings through their
 * build's live scanner, as the kill feed does, so a kill is stored as soon as the simulation
 * records it, and works through earlier recordings (the backlog, newest first) with its own
 * limit. Every player death becomes a kill; NPC deaths and tutorials do not. Once a recording
 * is scanned to its end its battles are rebuilt and the scan is recorded, so it is not scanned
 * again. A recording whose build kept no live scanner is imported from the replay dashboard's
 * cached report instead, without card facts.
 */
class KillboardWorker {
  constructor({
    client,
    store,
    dataRoot,
    maxLive = 6,
    maxBacklog = 2,
    backlog = async () => [],
    reportManifests = () => null,
    viewerLinks = () => [],
    createFollower = (options) => new ReplayFollower(options),
    resolveRuntime = defaultResolveRuntime,
    listLive = listLiveReplays,
    listByIds = listReplays,
    log = console,
    now = Date.now,
  }) {
    this.client = client;
    this.store = store;
    this.directory = path.join(dataRoot, "killboard");
    fs.rmSync(path.join(this.directory, "replays"), { recursive: true, force: true });
    this.maxLive = maxLive;
    this.maxBacklog = maxBacklog;
    this.backlog = backlog;
    this.reportManifests = reportManifests;
    this.viewerLinks = viewerLinks;
    this.createFollower = createFollower;
    this.resolveRuntime = resolveRuntime;
    this.listLive = listLive;
    this.listByIds = listByIds;
    this.log = log;
    this.now = now;
    this.followers = new Map();
    this.settled = null;
    this.pending = [];
    this.backlogRefreshedAt = -Infinity;
    this.viewersRefreshedAt = -Infinity;
    this.statusAt = -Infinity;
    this.unavailableBuilds = new Map();
    this.writes = Promise.resolve();
    this.stats = { kills: 0, scans: 0, imported: 0, failed: 0 };
  }

  async tick() {
    this.settled ??= await this.serial(() => this.store.settledReplayIds());
    const live = await this.listLive(this.client, {
      windowSeconds: LIVE_WINDOW_SECONDS,
      startedWithinSeconds: STARTED_WITHIN_SECONDS,
    });
    const liveIds = new Set(live.map((row) => Number(row.replay_id)));

    // Breaches carry nearly every death, so they claim live capacity before hub rooms.
    const byKind = [...live].sort((a, b) => Number(isHubRoom(a)) - Number(isHubRoom(b)));
    for (const row of byKind) {
      const replayId = Number(row.replay_id);
      if (row.is_tutorial || this.followers.has(replayId) || this.settled.has(replayId)) continue;
      if (this.count("live") >= this.maxLive || this.loadingCount() >= MAX_LOADING_FOLLOWERS) break;
      await this.follow(row, "live");
    }
    await this.feedBacklog(liveIds);

    for (const follower of this.followers.values()) {
      if (!liveIds.has(follower.replayId) && follower.active && !follower.ending) follower.finish();
      try {
        await follower.sync(this.client);
      } catch (error) {
        follower.fail(error.message);
      }
    }
    await this.writes;
    await this.settleFollowers();
    await this.refreshViewers();
    this.reportStatus();
  }

  async feedBacklog(liveIds) {
    if (this.now() - this.backlogRefreshedAt > BACKLOG_REFRESH_MILLISECONDS) {
      this.backlogRefreshedAt = this.now();
      this.pending = (await this.backlog()).map(Number).filter((replayId) => !this.settled.has(replayId));
    }
    while (this.count("backlog") < this.maxBacklog && this.loadingCount() < MAX_LOADING_FOLLOWERS && this.pending.length) {
      const replayId = this.pending.shift();
      if (this.settled.has(replayId) || this.followers.has(replayId) || liveIds.has(replayId)) continue;
      const [row] = await this.listByIds(this.client, [replayId]);
      if (!row || row.is_tutorial) {
        await this.settle(replayId, { state: "unsupported", error: row ? "tutorial" : "recording not found" });
        continue;
      }
      await this.follow(row, "backlog");
    }
  }

  async follow(row, lane) {
    const replayId = Number(row.replay_id);
    const unavailable = this.unavailableBuilds.get(row.app_version);
    if (unavailable && this.now() < unavailable.retryAt) {
      if (unavailable.permanent) await this.importReport(row, unavailable.error);
      return;
    }
    let runtime;
    try {
      runtime = await this.resolveRuntime(row);
    } catch (error) {
      // A bundle without the live scanner never gains one; a missing download may appear later.
      const permanent = error.code === "REPLAY_RUNTIME_NOT_LIVE";
      this.unavailableBuilds.set(row.app_version, {
        permanent,
        error: error.message,
        retryAt: permanent ? Infinity : this.now() + RUNTIME_RETRY_MILLISECONDS,
      });
      if (permanent) await this.importReport(row, error.message);
      else this.log.error(`killboard cannot scan replay ${replayId} yet: ${error.message}`);
      return;
    }

    const source = {
      replayId,
      buildSha: runtime.commit,
      startedAt: row.started_at,
      // The region the session was deployed to; a hub has none.
      regionId: row.region_id ?? "",
      origin: "live",
    };
    const follower = this.createFollower({
      replay: row,
      // The killboard needs no kill cam clips; the kill feed renders those.
      runtime: { ...runtime, killCamContract: null },
      directory: path.join(this.directory, "replays", String(replayId)),
      onManifest: (_follower, event) => this.accept(source, event),
    });
    follower.lane = lane;
    follower.source = source;
    follower.kills = 0;
    this.followers.set(replayId, follower);
    try {
      await follower.start(this.client);
      this.log.log(`killboard following ${lane} replay ${replayId} (${row.room_name})`);
    } catch (error) {
      follower.fail(error.message);
    }
  }

  /** Stores a recorded player death; writes run in order, behind the previous ones. */
  accept(source, event) {
    if (event.session !== "breach" && event.session !== "hub") return;
    const rows = killRows({ ...source, session: event.session }, event);
    if (!rows) return;
    const follower = this.followers.get(source.replayId);
    this.serial(() => this.store.saveKill(rows)).then(
      (saved) => {
        if (!saved) return;
        this.stats.kills++;
        if (follower) follower.kills++;
      },
      (error) => this.log.error(`killboard could not store kill ${rows.kill.id}: ${error.message}`)
    );
  }

  async settleFollowers() {
    for (const [replayId, follower] of this.followers) {
      if (follower.active) continue;
      this.followers.delete(replayId);
      fs.rmSync(follower.directory, { recursive: true, force: true });
      if (follower.state === "complete") {
        await this.serial(() => this.store.rebuildBattles(replayId));
        await this.settle(replayId, { state: "complete", buildSha: follower.source.buildSha, killCount: follower.kills });
        this.stats.scans++;
      } else if (follower.state === "failed") {
        this.log.error(`killboard scan of replay ${replayId} failed: ${follower.error}`);
        // Its kills so far stay; a failed recording is not retried until the worker restarts.
        await this.serial(() => this.store.rebuildBattles(replayId));
        await this.serial(() =>
          this.store.recordScan(replayId, {
            state: "failed",
            buildSha: follower.source.buildSha,
            killCount: follower.kills,
            error: follower.error,
          })
        );
        this.settled.add(replayId);
        this.stats.failed++;
      }
    }
  }

  /** Imports a recording whose build has no live scanner from the dashboard's cached report. */
  async importReport(row, reason) {
    const replayId = Number(row.replay_id);
    const report = this.reportManifests(replayId);
    if (!report) {
      await this.settle(replayId, { state: "unsupported", error: reason });
      return;
    }
    const source = {
      replayId,
      buildSha: report.runtimeCommit ?? "",
      startedAt: row.started_at,
      regionId: row.region_id ?? "",
      origin: "report",
    };
    let kills = 0;
    for (const manifest of report.manifests) {
      const rows = killRows({ ...source, session: report.session ?? sessionOf(row) }, { manifest, card: null });
      if (rows && (await this.serial(() => this.store.saveKill(rows)))) kills++;
    }
    await this.serial(() => this.store.rebuildBattles(replayId));
    await this.settle(replayId, { state: "complete", buildSha: source.buildSha, killCount: kills, error: `imported from report: ${reason}` });
    this.stats.imported++;
    this.stats.kills += kills;
  }

  async settle(replayId, scan) {
    await this.serial(() => this.store.recordScan(replayId, scan));
    this.settled.add(replayId);
  }

  async refreshViewers() {
    if (this.now() - this.viewersRefreshedAt < VIEWER_REFRESH_MILLISECONDS) return;
    this.viewersRefreshedAt = this.now();
    try {
      const updated = await this.serial(() => this.store.applyViewers(this.viewerLinks()));
      if (updated) this.log.log(`killboard linked ${updated} kill(s) to their kill cam viewers`);
    } catch (error) {
      this.log.error(`killboard could not link kill cam viewers: ${error.message}`);
    }
  }

  /**
   * Runs one store operation after every earlier one. The store holds a single connection, so
   * one recording's kills and another's battle rebuild must not interleave inside a transaction.
   */
  serial(operation) {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }

  count(lane) {
    return [...this.followers.values()].filter((follower) => follower.lane === lane).length;
  }

  loadingCount() {
    return [...this.followers.values()].filter((follower) => follower.loading).length;
  }

  reportStatus() {
    if (this.now() - this.statusAt < STATUS_INTERVAL_MILLISECONDS) return;
    this.statusAt = this.now();
    const following = [...this.followers.values()].map((follower) => `${follower.replayId} ${follower.lane}${follower.loading ? " loading" : ""}`);
    this.log.log(
      `killboard: ${this.stats.kills} kill(s), ${this.stats.scans} scan(s), ${this.stats.imported} import(s), ` +
        `${this.stats.failed} failure(s); ${this.pending.length} backlog; following ${following.join(", ") || "none"}`
    );
  }

  async close() {
    await Promise.all([...this.followers.values()].map((follower) => follower.stop()));
    await this.writes;
  }
}

async function defaultResolveRuntime(row) {
  await ensureRuntime(row.app_version, row.room_name);
  return requireLiveRuntime(row.app_version, row.room_name);
}

function isHubRoom(row) {
  return String(row.room_name).startsWith("hub:");
}

function sessionOf(row) {
  return isHubRoom(row) ? "hub" : "breach";
}

/**
 * The kill cam viewer and clip links the kill feed recorded in its posted.jsonl. Only a fight's
 * last card carries them, so every death of that fight gets them.
 */
function readViewerLinks(postedFile) {
  if (!fs.existsSync(postedFile)) return [];
  const records = fs
    .readFileSync(postedFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((record) => record.outcome === "posted");
  const ofFight = new Map();
  for (const record of records)
    if (record.viewer && record.fight) ofFight.set(record.fight, { url: record.viewer, clipUrl: record.clipUrl ?? null });
  const links = [];
  for (const record of records) {
    const published = record.viewer ? { url: record.viewer, clipUrl: record.clipUrl ?? null } : record.fight ? ofFight.get(record.fight) : null;
    if (published) links.push({ id: record.key, ...published });
  }
  return links;
}

/** A cached replay dashboard report's player-death manifests, or null without a report. */
function readReportManifests(dashboardCache, replayId) {
  const file = path.join(dashboardCache, String(replayId), "telemetry-report.json");
  if (!fs.existsSync(file)) return null;
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const manifests = (report.manifests ?? []).filter((manifest) => !(manifest.victimIsNpc ?? manifest.VictimIsNpc));
  return { runtimeCommit: report.runtimeCommit, manifests };
}

module.exports = { KillboardWorker, readViewerLinks, readReportManifests };
