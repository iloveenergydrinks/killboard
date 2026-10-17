"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { ChunkSequence, loadReplay, replayHeader } = require("../reconstruct");
const { loadChunks } = require("./live-replays");
const { CORRUPTED_STATE_POLICY } = require("../scanner");

// The kill cam contract this feed speaks (KILL_CAM.md): fights of deaths, each rendered as one clip
// from the scanner's killCam line, and a viewer mode for the site's /kill-cam/<commit>/<id>. A build
// declares its own in its runtime manifest (killCamContract); older builds post their cards
// without clips.
const KILL_CAM_CONTRACT = 4;
const STDERR_TAIL_CHARACTERS = 8_192;
const EXIT_GRACE_MILLISECONDS = 10_000;
// A long hub recording's catch-up is a few megabytes; this bounds a scanner that stalls.
const MAX_BUFFERED_INPUT_BYTES = 16 * 1024 * 1024;

/**
 * Follows one recording while it streams. It owns a single live scanner process, feeds it
 * every recorded chunk in order, and reports each kill manifest the simulation records, and
 * each fight's kill cam once the fight closes and the recording has streamed through its clip.
 * A recording that stops streaming is still scanned to its end (finish): the
 * scanner can run well behind the recording, and a session's deaths come mostly at its end.
 * When the build speaks this feed's kill cam contract, the scanner writes each fight's clip, its
 * replay and checkpoint frame, under the follower's killcam directory.
 *
 * States: starting, following, complete, failed, stopped.
 */
class ReplayFollower {
  constructor({ replay, runtime, directory, onManifest, onKillCam = () => {}, spawnProcess = spawn }) {
    this.replay = replay;
    this.runtime = runtime;
    this.directory = directory;
    this.killCamDirectory = runtime.killCamContract === KILL_CAM_CONTRACT ? path.join(directory, "killcam") : null;
    this.onManifest = onManifest;
    this.onKillCam = onKillCam;
    this.spawnProcess = spawnProcess;
    this.sequence = new ChunkSequence(replay.replay_id);
    this.state = "starting";
    this.loaded = false;
    this.ending = false;
    this.error = null;
    this.simulatedTick = -1;
    this.stderrTail = "";
    this.child = null;
    this.exited = null;
  }

  get replayId() {
    return Number(this.replay.replay_id);
  }

  get active() {
    return this.state === "starting" || this.state === "following";
  }

  /** Still loading the build's asset database, the scanner's memory peak. */
  get loading() {
    return this.active && !this.loaded;
  }

  async start(client) {
    const row = await loadReplay(client, String(this.replay.replay_id));
    if (!row) throw new Error(`Replay ${this.replay.replay_id} disappeared before following.`);
    fs.mkdirSync(this.directory, { recursive: true });
    const sessionPath = path.join(this.directory, "session.json");
    fs.writeFileSync(sessionPath, JSON.stringify({ ...replayHeader(row), LastTick: 0 }));

    const child = this.spawnProcess(
      "dotnet",
      [
        this.runtime.scanner,
        "--live",
        "--session",
        sessionPath,
        "--db",
        this.runtime.db,
        "--lut",
        this.runtime.lut,
        ...(this.killCamDirectory ? ["--killcam", this.killCamDirectory] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...CORRUPTED_STATE_POLICY } }
    );
    this.child = child;
    this.exited = new Promise((resolve) => child.once("exit", resolve));
    // The scanner's log is small; keep all of it beside the session for post-mortems.
    const scannerLog = fs.createWriteStream(path.join(this.directory, "scanner.log"));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      scannerLog.write(text);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARACTERS);
    });
    child.stderr.once("end", () => scannerLog.end());
    // A closed input pipe means the scanner exited; its exit reports the cause.
    child.stdin.on("error", () => {});
    child.once("error", (error) => this.fail(`scanner did not start: ${error.message}`));
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    this.state = "following";
  }

  /**
   * Queues every chunk recorded since the previous sync and returns without waiting for the
   * scanner. A scanner that is still loading reads nothing, so Node buffers its input; past
   * MAX_BUFFERED_INPUT_BYTES the next chunks wait for a later sync.
   */
  async sync(client) {
    if (this.state !== "following" || this.sequence.complete || this.child.stdin.writableEnded) return;
    if (this.child.stdin.writableLength > MAX_BUFFERED_INPUT_BYTES) return;
    const chunks = await loadChunks(client, this.replay.game_id, this.sequence.nextChunk);
    // Every chunk of a recording that stopped streaming is in; the scanner scans them all, then exits.
    if (this.ending && chunks.length === 0) {
      this.child.stdin.end();
      return;
    }
    for (const chunk of chunks) {
      if (this.state !== "following") return;
      this.sequence.accept(chunk);
      this.child.stdin.write(
        `${JSON.stringify({
          chunk: chunk.chunk_number,
          lastTick: chunk.last_tick,
          isLast: Boolean(chunk.is_last),
          input: chunk.input,
        })}\n`
      );
    }
  }

  /**
   * Scans a recording that stopped streaming to its end: the next syncs send the scanner the
   * rest of its chunks, then end its input, and the scanner exits once it has scanned them all.
   */
  finish() {
    if (this.active) this.ending = true;
  }

  /** Stops the scanner where it is, as the feed shuts down. */
  async stop() {
    if (!this.active) return;
    this.state = "stopped";
    await this.close();
  }

  async close() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const timeout = new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MILLISECONDS).unref());
    if ((await Promise.race([this.exited.then(() => true), timeout])) !== true)
      this.child.kill("SIGKILL");
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.fail(`scanner wrote a non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (event.type === "ready") this.loaded = true;
    else if (event.type === "progress") this.simulatedTick = event.tick;
    else if (event.type === "manifest") this.onManifest(this, event);
    else if (event.type === "killCam") this.onKillCam(this, event);
    else if (event.type === "complete") {
      this.simulatedTick = event.tick;
      this.state = "complete";
      this.child.stdin.end();
    }
  }

  handleExit(code, signal) {
    if (this.state === "complete" || this.state === "stopped") return;
    if (this.ending && code === 0) {
      this.state = "complete";
      return;
    }
    this.fail(
      `scanner exited with ${signal ? `signal ${signal}` : `status ${code}`}` +
        (this.stderrTail.trim() ? `: ${this.stderrTail.trim().split("\n").slice(-5).join(" | ")}` : "")
    );
  }

  fail(message) {
    if (!this.active) return;
    this.state = "failed";
    this.error = message;
    this.child?.kill("SIGKILL");
  }
}

module.exports = { ReplayFollower, KILL_CAM_CONTRACT };
