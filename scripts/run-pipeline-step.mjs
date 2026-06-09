#!/usr/bin/env node
/**
 * 单步运行 star-tide-daily 流水线；步骤间 JSON 持久化到 artifacts/<date>/.pipeline/
 * 用法: node scripts/run-pipeline-step.mjs --step <id> [--run-date YYYY-MM-DD] [--output-dir artifacts] [--stdin-file path] [--force]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ARTIFACTS_DIR, PROJECT_ROOT, resolveStarTideRoot } from "./pipeline-agent.mjs";
import {
  getStepDef,
  pipelineStatePath,
  previousStepId,
  resolveRunDate,
  STEP_IDS,
} from "./pipeline-steps.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_AGENT = resolve(__dirname, "pipeline-agent.mjs");

function parseArgs(argv) {
  const out = {
    step: null,
    runDate: "",
    outputDir: ARTIFACTS_DIR,
    stdinFile: "",
    force: false,
    cleanupOnFail: false,
    reuseSession: false,
    maxRetries: 3,
    retryDelayMs: 60_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--step" && argv[i + 1]) out.step = argv[++i];
    else if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--output-dir" && argv[i + 1]) out.outputDir = argv[++i];
    else if (a === "--stdin-file" && argv[i + 1]) out.stdinFile = argv[++i];
    else if (a === "--max-retries" && argv[i + 1]) out.maxRetries = Number(argv[++i]);
    else if (a === "--retry-delay-ms" && argv[i + 1]) out.retryDelayMs = Number(argv[++i]);
    else if (a === "--force") out.force = true;
    else if (a === "--cleanup-on-fail") out.cleanupOnFail = true;
    else if (a === "--reuse-session") out.reuseSession = true;
  }
  if (!out.step) {
    console.error(
      `用法: node scripts/run-pipeline-step.mjs --step ${STEP_IDS.join("|")} [--run-date YYYY-MM-DD] [--output-dir 路径] [--stdin-file 路径] [--force] [--reuse-session] [--max-retries N] [--retry-delay-ms MS] [--cleanup-on-fail]`,
    );
    process.exit(2);
  }
  return out;
}

function projectRoot() {
  return resolveStarTideRoot();
}

function resolveStdinPath(opts, stepDef) {
  if (opts.stdinFile) return resolve(projectRoot(), opts.stdinFile);
  const prev = previousStepId(stepDef.id);
  if (!prev) return null;
  return resolve(projectRoot(), pipelineStatePath(opts.outputDir, opts.runDate, prev));
}

function loadStdin(opts, stepDef) {
  const path = resolveStdinPath(opts, stepDef);
  if (!path) return "";
  if (!existsSync(path)) {
    const prev = previousStepId(stepDef.id);
    console.error(
      `缺少上一步输出: ${path}\n请先运行: node scripts/run-pipeline-step.mjs --step ${prev}${opts.runDate ? ` --run-date ${opts.runDate}` : ""}`,
    );
    process.exit(2);
  }
  return readFileSync(path, "utf8").trim();
}

function runPipelineAgent(stepDef, opts, stdin) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      PIPELINE_AGENT,
      "--agent",
      stepDef.agent,
      "--prompt-file",
      stepDef.promptFile,
      "--timeout",
      String(stepDef.timeout),
      "--output-dir",
      opts.outputDir,
      "--max-retries",
      String(opts.maxRetries),
      "--retry-delay-ms",
      String(opts.retryDelayMs),
    ];
    const runDate = resolveRunDate(opts.runDate);
    if (runDate) args.push("--run-date", runDate);
    if (opts.cleanupOnFail) args.push("--cleanup-on-fail");
    if (opts.reuseSession) args.push("--reuse-session");

    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout: stdout.trim(), stderr });
    });
  });
}

function saveState(opts, stepId, stdout) {
  const statePath = resolve(projectRoot(), pipelineStatePath(opts.outputDir, opts.runDate, stepId));
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, stdout, "utf8");
  return statePath;
}

async function main() {
  const opts = parseArgs(process.argv);
  const stepDef = getStepDef(opts.step);
  const runDate = resolveRunDate(opts.runDate);
  opts.runDate = runDate;

  const statePath = resolve(projectRoot(), pipelineStatePath(opts.outputDir, runDate, stepDef.id));
  if (existsSync(statePath) && !opts.force) {
    console.error(
      `步骤 ${stepDef.id} 的状态文件已存在: ${statePath}\n加 --force 覆盖，或删除该文件后重试。`,
    );
    process.exit(2);
  }

  const stdin = loadStdin(opts, stepDef);
  const { code, stdout, stderr } = await runPipelineAgent(stepDef, opts, stdin);

  if (code !== 0) {
    console.error(`pipeline-agent 退出码: ${code}`);
    if (stderr) console.error(stderr);
    process.exit(code || 1);
  }

  if (!stdout) {
    console.error("pipeline-agent 返回空的 stdout");
    process.exit(1);
  }

  const saved = saveState(opts, stepDef.id, stdout);
  process.stderr.write(`[run-pipeline-step] 已保存 ${saved}\n`);
  process.stdout.write(stdout);
}

export {
  parseArgs,
  resolveStdinPath,
  loadStdin,
  runPipelineAgent,
  saveState,
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
