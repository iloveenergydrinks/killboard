"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { runtimeCommit, runtimeDirectory, DASHBOARD_SCANNERS } = require("./runtime-bundles");
const { parseReportExact } = require("./report-json");

// A scanner's record that it could not complete a recording, kept in the recording's cache directory.
const FAILURE_MARKER = "headless-runner-error.json";
// Added to every scanner launch's environment. A scan continues past what a simulation task
// throws, as the game does. A read past a native buffer, which the game's WebGL build survives,
// faults on .NET: near address zero as a null reference that Quantum catches, elsewhere as an
// access violation that .NET lets Quantum catch only under this policy, which it reads from the
// environment alone.
const CORRUPTED_STATE_POLICY = { DOTNET_legacyCorruptedStateExceptionsPolicy: "1" };

function scanReplay(
  meta,
  outDir,
  { targetUserId = null, telemetryOnly = false, outputName = "scan-report.json", quiet = false, reuse = false, fresh = false } = {}
) {
  const { args, reportPath, runtime } = scannerInvocation(meta, outDir, {
    targetUserId,
    telemetryOnly,
    outputName,
  });
  const fingerprint = reuse ? scanFingerprint(meta, runtime, targetUserId, telemetryOnly) : null;
  if (reuse && !fresh && reusableReport(meta, reportPath, fingerprint, targetUserId))
    return reportPath;
  const result = spawnSync("dotnet", args, {
    env: scannerEnvironment(),
    encoding: quiet ? "utf8" : undefined,
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = quiet ? result.stderr?.trim() || result.stdout?.trim() : "";
    throw new Error(
      `scanner exited with status ${result.status}${detail ? `: ${detail}` : ""}`
    );
  }
  if (reuse) rememberReport(meta, reportPath, fingerprint, targetUserId);
  return reportPath;
}

function scanReplayAsync(
  meta,
  outDir,
  { targetUserId = null, telemetryOnly = false, outputName = "scan-report.json" } = {}
) {
  const { args, reportPath } = scannerInvocation(meta, outDir, {
    targetUserId,
    telemetryOnly,
    outputName,
  });
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", args, { env: scannerEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 16_384) errorText += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(reportPath);
      else
        reject(
          Object.assign(new Error(
            `scanner exited with ${signal ? `signal ${signal}` : `status ${code}`}` +
              `${errorText.trim() ? `: ${errorText.trim()}` : ""}`
          ), { exitCode: code })
        );
    });
  });
}

function scannerInvocation(meta, outDir, { targetUserId, telemetryOnly, outputName }) {
  const runtime = requireRuntime(meta.appVersion, { telemetryOnly, roomName: meta.roomName });
  const reportPath = path.join(outDir, outputName);
  const args = [
    runtime.scanner,
    path.resolve(meta.files.replay),
    "--db",
    runtime.db,
    "--lut",
    runtime.lut,
    "--out",
    reportPath,
  ];
  if (targetUserId) args.push("--target-user", targetUserId);
  if (telemetryOnly) args.push("--telemetry-only");
  return { args, reportPath, runtime };
}

function scannerEnvironment() {
  return {
    ...process.env,
    ...CORRUPTED_STATE_POLICY,
    DOTNET_gcServer: process.env.DOTNET_gcServer ?? process.env.COMPlus_gcServer ?? "1",
    DOTNET_GCHeapCount: process.env.DOTNET_GCHeapCount ?? process.env.COMPlus_GCHeapCount ?? "4",
  };
}

function hashFile(file, hash = createHash("sha256")) {
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash;
}

function scanFingerprint(meta, runtime, targetUserId, telemetryOnly) {
  const hash = createHash("sha256").update(JSON.stringify({
    version: 1, replayId: meta.replayId, lastTick: meta.lastTick,
    commit: runtime.commit, targetUserId: targetUserId?.toLowerCase() ?? null, telemetryOnly,
  }));
  hash.update(hashFile(meta.files.replay).digest("hex"));
  hash.update(hashFile(runtime.db).digest("hex"));
  // Kits can be rebuilt at the same simulation commit. Hash their actual code and LUTs.
  for (const directory of [runtime.lut, path.dirname(runtime.scanner)]) {
    const files = fs.readdirSync(directory, { recursive: true }).sort();
    for (const name of files) {
      const file = path.join(directory, name);
      if (!fs.statSync(file).isFile()) continue;
      if (directory !== runtime.lut && !/\.(dll|json)$/.test(name)) continue;
      hash.update(name + "\0");
      hash.update(hashFile(file).digest("hex"));
    }
  }
  return hash.digest("hex");
}

function completeReport(meta, report, targetUserId) {
  return meta.completeStream === true &&
    report.lastTick === meta.lastTick && Number.isInteger(report.scannedTick) &&
    report.scannedTick >= meta.lastTick && report.manifestCoverage === "complete" &&
    (report.targetUserId?.toLowerCase() ?? null) === (targetUserId?.toLowerCase() ?? null);
}

/**
 * Writes a scan's report to `reportPath` as trusted evidence, naming the exact runtime that
 * produced it. A report is complete when it reaches the recording's last tick, whatever
 * simulation exceptions it records on the way.
 */
function trustReport(scanPath, reportPath, lastTick, commit) {
  // The report is written back, so every recorded integer must keep its digits.
  const report = parseReportExact(fs.readFileSync(scanPath, "utf8"));
  if (report.lastTick !== lastTick || !Number.isInteger(report.scannedTick) || report.scannedTick < report.lastTick)
    throw new Error("Replay scanner did not cover the complete recording.");
  report.runtimeCommit = commit;
  report.assetSource = "QuantumUnityDB";
  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report));
  fs.renameSync(`${reportPath}.tmp`, reportPath);
}

/**
 * Records that a scanner could not complete a recording. The marker is final for the scanner
 * that failed: the dashboard never repeats it with the runtime's own scanner, and
 * rescan-failures.js retries it once per change to its own, whose fingerprint `scanner` names.
 */
function writeFailure(directory, { runtimeCommit: commit, replayId, failure, exitCode, scanner }) {
  const marker = path.join(directory, FAILURE_MARKER);
  fs.writeFileSync(`${marker}.tmp`, JSON.stringify({
    runtimeCommit: commit, replayId: Number(replayId), exitCode, failedAt: new Date().toISOString(), failure, scanner,
  }));
  fs.renameSync(`${marker}.tmp`, marker);
}

/** The dashboard status of a recording whose saved failure matches its complete recording and exact runtime. */
function cachedFailure(row, directory) {
  const metaFile = path.join(directory, "meta.json");
  const markerFile = path.join(directory, FAILURE_MARKER);
  if (!fs.existsSync(metaFile) || !fs.existsSync(markerFile)) return null;
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  const commit = runtimeCommit(row.app_version, row.room_name);
  if (
    !commit ||
    meta.replayId !== Number(row.replay_id) ||
    meta.appVersion !== row.app_version ||
    meta.completeStream !== true ||
    meta.lastTick !== Number(row.last_tick) ||
    marker.runtimeCommit !== commit ||
    String(marker.replayId) !== String(row.replay_id)
  )
    return null;
  return {
    state: "blocked",
    error: `Saved headless replay failure: ${marker.failure ?? `exit ${marker.exitCode}`}`,
  };
}

function reusableReport(meta, reportPath, fingerprint, targetUserId) {
  try {
    const receipt = JSON.parse(fs.readFileSync(`${reportPath}.restore-cache.json`, "utf8"));
    if (receipt.fingerprint !== fingerprint ||
      hashFile(reportPath).digest("hex") !== receipt.reportSha256) return false;
    return completeReport(meta, JSON.parse(fs.readFileSync(reportPath, "utf8")), targetUserId);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

function rememberReport(meta, reportPath, fingerprint, targetUserId) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!completeReport(meta, report, targetUserId)) return;
  const receiptPath = `${reportPath}.restore-cache.json`;
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint, reportSha256: hashFile(reportPath).digest("hex") }));
  fs.renameSync(temporary, receiptPath);
}

function cachedReplayReport(meta, outDir, { targetUserId = null, outputName = "scan-report.json" } = {}) {
  const reportPath = path.join(outDir, outputName);
  if (!fs.existsSync(`${reportPath}.restore-cache.json`)) return null;
  let scope;
  try {
    scope = JSON.parse(fs.readFileSync(reportPath, "utf8")).targetUserId ?? null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (scope && scope.toLowerCase() !== targetUserId?.toLowerCase()) return null;
  const { runtime } = scannerInvocation(meta, outDir, { targetUserId:scope, telemetryOnly:false, outputName });
  const fingerprint = scanFingerprint(meta, runtime, scope, false);
  return reusableReport(meta, reportPath, fingerprint, scope) ? reportPath : null;
}

// Called by the dashboard only after its terminal full scan and provenance ingestion.
function rememberScannedReport(meta, outDir, { outputName = "scan-report.json" } = {}) {
  const { runtime, reportPath } = scannerInvocation(meta, outDir, {
    targetUserId:null, telemetryOnly:false, outputName,
  });
  rememberReport(meta, reportPath, scanFingerprint(meta, runtime, null, false), null);
}

function requireRuntime(appVersion, { telemetryOnly = false, roomName } = {}) {
  const root = runtimeDirectory(appVersion, roomName);
  const commit = path.basename(root);
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath))
    throw new Error(
      `No runtime bundle for ${appVersion}. Retrieve the retained build artifact ` +
        `at monorepo/replay-runtime/${commit}/ and extract it under ${root}.`
    );

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.commit?.toLowerCase() !== commit)
    throw new Error(
      `Runtime bundle ${manifestPath} targets '${manifest.commit}', not '${commit}'.`
    );

  if (telemetryOnly && !DASHBOARD_SCANNERS.has(manifest.dashboardScanner))
    throw new Error(
      `Runtime bundle ${commit} has no supported dashboard scanner declaration.`
    );

  const runtime = {
    db: path.join(root, "db.json"),
    lut: path.join(root, "lut", "LUT"),
    scanner: path.join(root, telemetryOnly ? manifest.dashboardScanner : "scanner/Citadel.ReplayScan.dll"),
  };
  for (const [kind, requiredPath] of Object.entries(runtime))
    if (!fs.existsSync(requiredPath))
      throw new Error(`Runtime bundle ${commit} is missing ${kind}: ${requiredPath}`);
  return {
    ...runtime,
    commit,
    // The build's web deployment, where its kill cams render; older runtimes predate it.
    deploymentUrl: manifest.deploymentUrl ?? null,
    liveScanner: manifest.liveScanner === true,
    // A recovered historical build: its simulation predates the current scanner's state reads.
    nativeEventsOnly: manifest.nativeEventsOnly === true,
    // The kill cam contract its scanner and web deployment speak (KILL_CAM.md); 0 for none.
    killCamContract: Number.isInteger(manifest.killCamContract) ? manifest.killCamContract : 0,
  };
}

/** The exact build's full scanner, required to follow a recording while it streams. */
function requireLiveRuntime(appVersion, roomName) {
  const runtime = requireRuntime(appVersion, { roomName });
  if (!runtime.liveScanner)
    throw Object.assign(
      new Error(`Runtime bundle ${runtime.commit} predates live kill manifest streaming.`),
      { code: "REPLAY_RUNTIME_NOT_LIVE" }
    );
  return runtime;
}

module.exports = {
  FAILURE_MARKER, CORRUPTED_STATE_POLICY, requireRuntime, requireLiveRuntime, scanReplay, scanReplayAsync, cachedReplayReport,
  rememberScannedReport, trustReport, writeFailure, cachedFailure,
};
