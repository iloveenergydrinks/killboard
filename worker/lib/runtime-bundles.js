"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DATA_ROOT } = require("./config");
const historicalCommits = require("./historical-runtime-commits.json");

const run = promisify(execFile);
const downloads = new Map();
const RETRY_DELAY = 5 * 60_000;
const CACHE_MARKER = ".r2-cache";
const FREE_BYTES = Number(process.env.REPLAY_RUNTIME_FREE_GIB || 0) * 1024 ** 3;
if (!Number.isFinite(FREE_BYTES) || FREE_BYTES < 0)
  throw new Error("REPLAY_RUNTIME_FREE_GIB must be a nonnegative number.");
const DASHBOARD_SCANNERS = new Set([
  "scanner/Citadel.ReplayScan.dll",
  "telemetry-scanner/Citadel.ReplayTelemetry.dll",
]);

function runtimeCommit(appVersion, roomName) {
  const version = String(appVersion ?? "");
  const full = version.match(/(?:^|:)([0-9a-f]{40})$/i)?.[1];
  if (full) return full.toLowerCase();

  const abbreviated = version.match(/^(?:b-main|main|b-proto-main|proto\/main):([0-9a-f]{7})$/i)?.[1];
  // Historical clients put the CI release revision in the room, not the machine ID.
  const roomRevision = /^(?:CPHMGL5Z|AKNLEL44)$/i.test(version)
    ? String(roomName ?? "").match(/^(?:BREACH|HUB)-\d+(?:-.*)?-([0-9a-f]{7})$/i)?.[1]
    : null;
  return historicalCommits[(abbreviated ?? roomRevision)?.toLowerCase()] ?? null;
}

function runtimeDirectory(appVersion, roomName) {
  const commit = runtimeCommit(appVersion, roomName);
  if (!commit) throw Object.assign(
    new Error(`Replay app version '${appVersion}' in room '${roomName ?? "unknown"}' has no verified Git commit. Its exact recorded runtime must be identified before playback.`),
    { code: "REPLAY_RUNTIME_UNKNOWN" }
  );
  return path.join(DATA_ROOT, "runtime", commit);
}

async function ensureRuntime(appVersion, roomName) {
  const root = runtimeDirectory(appVersion, roomName);
  if (fs.existsSync(path.join(root, "manifest.json"))) {
    const marker = path.join(root, CACHE_MARKER);
    if (fs.existsSync(marker)) fs.utimesSync(marker, new Date(), new Date());
    return;
  }

  const previous = downloads.get(root);
  if (previous && Date.now() < previous.retryAt) return previous.promise;

  // ponytail: one download per build in this single service; failed builds retry after five minutes.
  const entry = { retryAt: Infinity };
  entry.promise = installBundle(root).then(
    () => downloads.delete(root),
    (cause) => {
      entry.retryAt = Date.now() + RETRY_DELAY;
      throw Object.assign(new Error(`No runtime bundle for ${appVersion}: ${cause.message}`), {
        code: "REPLAY_RUNTIME_UNAVAILABLE",
        retryAt: entry.retryAt,
      });
    }
  );
  downloads.set(root, entry);
  return entry.promise;
}

async function installBundle(root) {
  const remote = process.env.REPLAY_RUNTIME_REMOTE?.replace(/\/$/, "");
  if (!remote) throw new Error("Set REPLAY_RUNTIME_REMOTE to the retained R2 runtime prefix, or install the exact bundle locally.");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(root), ".download-"));
  const commit = path.basename(root);
  const filename = `replay-runtime-${commit}.tar.gz`;
  const archive = path.join(temporary, filename);
  try {
    for (const suffix of [".sha256", ""]) {
      await run("rclone", [
        "copyto", `${remote}/${commit}/${filename}${suffix}`, `${archive}${suffix}`,
        "--error-on-no-transfer",
        "--retries", "2", "--low-level-retries", "2", "--contimeout", "20s", "--timeout", "1m",
      ], { timeout: 15 * 60_000 });
    }
    const checksum = fs.readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/);
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (checksum.length !== 2 || checksum[1] !== filename || hash.digest("hex") !== checksum[0])
      throw new Error(`Checksum mismatch for ${filename}.`);

    const { stdout } = await run("tar", ["-tzf", archive], { maxBuffer: 16 * 1024 * 1024 });
    for (const name of stdout.trim().split("\n")) {
      if (!name.startsWith(`${commit}/`) || name.split("/").includes(".."))
        throw new Error(`Runtime archive contains a path outside ${commit}.`);
    }
    await run("tar", ["-xzf", archive, "-C", temporary, "--no-same-owner", "--no-same-permissions"]);
    const extracted = path.join(temporary, commit);
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"));
    if (manifest.commit?.toLowerCase() !== commit)
      throw new Error(`Retained runtime manifest does not target ${commit}.`);
    if (!DASHBOARD_SCANNERS.has(manifest.dashboardScanner))
      throw new Error(`Retained runtime ${commit} has no supported dashboard scanner declaration.`);
    for (const file of ["db.json", "lut/LUT", manifest.dashboardScanner])
      if (!fs.existsSync(path.join(extracted, file))) throw new Error(`Retained runtime is missing ${file}.`);
    fs.writeFileSync(path.join(extracted, CACHE_MARKER), remote);
    try {
      fs.renameSync(extracted, root);
    } catch (error) {
      // The dashboard and kill feed share a data root; another process installed it first.
      if (!fs.existsSync(path.join(root, "manifest.json"))) throw error;
      return;
    }
    console.log(`installed retained replay runtime ${commit}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// ponytail: the single dashboard drains its workers before deleting whole cached kits.
// Keep the originals in R2 and never evict unmarked, locally authored runtimes.
function prepareRuntimeCache(activeWorkers) {
  if (!FREE_BYTES || !process.env.REPLAY_RUNTIME_REMOTE) return true;
  const runtime = path.join(DATA_ROOT, "runtime");
  if (!fs.existsSync(runtime)) return true;
  const available = () => {
    const { bavail, bsize } = fs.statfsSync(runtime);
    return bavail * bsize;
  };
  if (available() >= FREE_BYTES) return true;
  if (activeWorkers > 0 || [...downloads.values()].some((entry) => entry.retryAt === Infinity)) return false;
  const remote = process.env.REPLAY_RUNTIME_REMOTE.replace(/\/$/, "");
  const candidates = fs.readdirSync(runtime, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/.test(entry.name))
    .map((entry) => path.join(runtime, entry.name))
    .filter((root) => fs.existsSync(path.join(root, CACHE_MARKER)))
    .filter((root) => fs.readFileSync(path.join(root, CACHE_MARKER), "utf8") === remote)
    .map((root) => ({ root, used: fs.statSync(path.join(root, CACHE_MARKER)).mtimeMs }))
    .sort((a, b) => a.used - b.used);
  for (const { root } of candidates) {
    if (available() >= FREE_BYTES) break;
    fs.rmSync(root, { recursive: true });
    console.log(`evicted downloaded replay runtime ${path.basename(root)}`);
  }
  return true;
}

module.exports = { runtimeCommit, runtimeDirectory, ensureRuntime, prepareRuntimeCache, DASHBOARD_SCANNERS, CACHE_MARKER };
