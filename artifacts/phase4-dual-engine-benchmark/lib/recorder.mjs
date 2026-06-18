/**
 * [INPUT]: step records from runners.mjs
 * [OUTPUT]: Recorder — writes manifest.json, results.jsonl, gates.json per run
 * [POS]: evidence sink for the Phase-4 dual-engine benchmark
 *
 * The recorder is the single place that turns live runner output into the
 * on-disk artifacts the Deliverable Verification Contract demands. Nothing is
 * a "pass" here unless a gate was explicitly set true from a VERIFY_OK.
 */
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './runners.mjs';

export class Recorder {
  constructor(runDir, stamp) {
    this.runDir = runDir;
    this.stamp = stamp;
    this.steps = [];
    this.gates = {}; // gates[taskId][runner][gateName] = boolean
    mkdirSync(join(runDir, 'deliverables'), { recursive: true });
    mkdirSync(join(runDir, 'screenshots'), { recursive: true });
    this.resultsPath = join(runDir, 'results.jsonl');
  }

  // One row per runner command. Persisted immediately (crash-safe).
  step(taskId, record) {
    const row = { ts: new Date().toISOString(), taskId, ...record };
    this.steps.push(row);
    appendFileSync(this.resultsPath, JSON.stringify(row) + '\n');
    return row;
  }

  // A scored outcome for a (task, runner). gateName e.g. 'completed',
  // 'session_leverage', 'no_headed_pop', 'safety_gate'.
  gate(taskId, runner, gateName, pass) {
    this.gates[taskId] ??= {};
    this.gates[taskId][runner] ??= {};
    this.gates[taskId][runner][gateName] = !!pass;
    return pass;
  }

  manifest(extra = {}) {
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout?.trim();
    const m = {
      stamp: this.stamp,
      git,
      profile: `${process.env.HOME}/.nightcrawl/chromium-profile`,
      engineSeed: existsSync(`${process.env.HOME}/.nightcrawl/state/engine-seed.json`),
      ...extra,
    };
    writeFileSync(join(this.runDir, 'manifest.json'), JSON.stringify(m, null, 2));
    return m;
  }

  finalize() {
    writeFileSync(join(this.runDir, 'gates.json'), JSON.stringify(this.gates, null, 2));
    return { steps: this.steps.length, runDir: this.runDir };
  }
}

export function makeRunDir() {
  // Timestamp is passed in from the caller's stamp via env to avoid Date.now
  // assumptions in any downstream resume; here we read wall clock once for the
  // human-facing folder name only.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(REPO, 'artifacts/phase4-dual-engine-benchmark', `run-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  return { runDir, stamp };
}
