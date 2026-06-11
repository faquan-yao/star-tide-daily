#!/usr/bin/env node
/**
 * 单步运行 star-tide-daily 流水线；步骤间 JSON 持久化到 artifacts/<date>/.pipeline/
 * 用法: node scripts/run-pipeline-step.mjs --step <id> [--run-date YYYY-MM-DD] [--output-dir artifacts]
 *       [--stdin-file path] [--github-url URL] [--analyze-report path] [--preview-md path] [--force] [--use-llm]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ARTIFACTS_DIR, PROJECT_ROOT, extractJsonPayload, resolveStarTideRoot } from "./pipeline-agent.mjs";
import { hasAnalyzeReports, normalizeAnalyzeContract } from "./lib/assemble-analyze.mjs";
import {
  hasPptFinalizeContract,
  hasPptPreviewContract,
  normalizePptFinalizeContract,
  normalizePptPreviewContract,
} from "./lib/assemble-ppt.mjs";
import {
  getStepDef,
  pipelineStatePath,
  previousStepId,
  resolveRunDate,
  STEP_IDS,
} from "./pipeline-steps.mjs";
import { resolveStepStdin } from "./lib/build-step-input.mjs";
import { validateStep } from "../tests/validate-output.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_AGENT = resolve(__dirname, "pipeline-agent.mjs");

function parseArgs(argv) {
  const out = {
    step: null,
    runDate: "",
    outputDir: ARTIFACTS_DIR,
    stdinFile: "",
    githubUrl: "",
    analyzeReport: "",
    previewMd: "",
    force: false,
    cleanupOnFail: false,
    reuseSession: false,
    useLlm: false,
    maxRetries: 3,
    retryDelayMs: 60_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--step" && argv[i + 1]) out.step = argv[++i];
    else if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--output-dir" && argv[i + 1]) out.outputDir = argv[++i];
    else if (a === "--stdin-file" && argv[i + 1]) out.stdinFile = argv[++i];
    else if (a === "--github-url" && argv[i + 1]) out.githubUrl = argv[++i];
    else if (a === "--analyze-report" && argv[i + 1]) out.analyzeReport = argv[++i];
    else if (a === "--preview-md" && argv[i + 1]) out.previewMd = argv[++i];
    else if (a === "--max-retries" && argv[i + 1]) out.maxRetries = Number(argv[++i]);
    else if (a === "--retry-delay-ms" && argv[i + 1]) out.retryDelayMs = Number(argv[++i]);
    else if (a === "--force") out.force = true;
    else if (a === "--cleanup-on-fail") out.cleanupOnFail = true;
    else if (a === "--reuse-session") out.reuseSession = true;
    else if (a === "--use-llm") out.useLlm = true;
  }
  if (!out.step) {
    console.error(
      `用法: node scripts/run-pipeline-step.mjs --step ${STEP_IDS.join("|")} [--run-date YYYY-MM-DD] [--output-dir 路径] [--stdin-file 路径] [--github-url URL] [--analyze-report 路径] [--preview-md 路径] [--force] [--use-llm] [--reuse-session] [--max-retries N] [--retry-delay-ms MS] [--cleanup-on-fail]`,
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

function hasManualInput(opts, stepId) {
  if (stepId === "analyze" && opts.githubUrl) return true;
  if (stepId === "ppt_preview" && opts.analyzeReport) return true;
  if (stepId === "ppt_finalize" && opts.previewMd) return true;
  return false;
}

function manualInputHint(stepId) {
  if (stepId === "analyze") return "--github-url <GitHub 项目地址>";
  if (stepId === "ppt_preview") return "--analyze-report <分析报告.md>";
  if (stepId === "ppt_finalize") return "--preview-md <预览.md>";
  return "--stdin-file <上一步 JSON>";
}

function loadStdin(opts, stepDef) {
  if (hasManualInput(opts, stepDef.id)) {
    return resolveStepStdin(stepDef.id, opts, "");
  }

  if (opts.stdinFile) {
    const path = resolve(projectRoot(), opts.stdinFile);
    if (!existsSync(path)) {
      console.error(`stdin 文件不存在: ${path}`);
      process.exit(2);
    }
    return readFileSync(path, "utf8").trim();
  }

  const path = resolveStdinPath(opts, stepDef);
  let fallback = "";
  if (path) {
    if (!existsSync(path) && !hasManualInput(opts, stepDef.id)) {
      const prev = previousStepId(stepDef.id);
      console.error(
        `缺少上一步输出: ${path}\n请先运行: node scripts/run-pipeline-step.mjs --step ${prev}${opts.runDate ? ` --run-date ${opts.runDate}` : ""}\n或手动传入: ${manualInputHint(stepDef.id)}`,
      );
      process.exit(2);
    }
    if (existsSync(path)) fallback = readFileSync(path, "utf8").trim();
  }

  return resolveStepStdin(stepDef.id, opts, fallback);
}

function resolveRunner(stepDef, opts) {
  if (opts.useLlm) return "agent";
  return stepDef.runner || "agent";
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
    if (opts.githubUrl) args.push("--github-url", opts.githubUrl);
    if (opts.analyzeReport) args.push("--analyze-report", opts.analyzeReport);
    if (opts.previewMd) args.push("--preview-md", opts.previewMd);
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

function runStepScript(stepDef, opts) {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = resolve(PROJECT_ROOT, stepDef.script);
    const args = [scriptPath];
    const runDate = resolveRunDate(opts.runDate);
    if (runDate) args.push("--run-date", runDate);

    const timeoutSec = stepDef.timeout || 120;
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, Math.max(1, timeoutSec) * 1000);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`脚本超时 (${timeoutSec}s): ${stepDef.script}`));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout: stdout.trim(), stderr });
    });
  });
}

function parseStepOutput(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return extractJsonPayload(stdout);
  }
}

function validateStepOutput(stepId, stdout) {
  const parsed = parseStepOutput(stdout);
  if (!parsed) {
    return { ok: false, errors: ["stdout 不是合法 JSON 或步骤契约"], parsed: null };
  }
  if (parsed.error) {
    return {
      ok: false,
      errors: [`步骤返回 error: ${parsed.error}`],
      parsed,
    };
  }
  if (stepId === "analyze" && hasAnalyzeReports(parsed)) {
    parsed = normalizeAnalyzeContract(parsed);
  }
  if (stepId === "ppt_preview" && hasPptPreviewContract(parsed)) {
    parsed = normalizePptPreviewContract(parsed);
  }
  if (stepId === "ppt_finalize" && hasPptFinalizeContract(parsed)) {
    parsed = normalizePptFinalizeContract(parsed);
  }
  const warnings = [];
  const errors = validateStep(stepId, parsed, {
    warnings,
    strict: !["analyze", "ppt_preview", "ppt_finalize"].includes(stepId),
  });
  return { ok: errors.length === 0, errors, warnings, parsed };
}

function saveState(opts, stepId, stdout) {
  const statePath = resolve(projectRoot(), pipelineStatePath(opts.outputDir, opts.runDate, stepId));
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, stdout, "utf8");
  return statePath;
}

async function runStep(stepDef, opts, stdin) {
  const runner = resolveRunner(stepDef, opts);
  if (runner === "script" && stepDef.script) {
    return runStepScript(stepDef, opts);
  }
  return runPipelineAgent(stepDef, opts, stdin);
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
  const runner = resolveRunner(stepDef, opts);
  let code;
  let stdout;
  let stderr;
  try {
    ({ code, stdout, stderr } = await runStep(stepDef, opts, stdin));
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  if (code !== 0) {
    console.error(`${runner === "script" ? "脚本" : "pipeline-agent"} 退出码: ${code}`);
    if (stderr) console.error(stderr);
    process.exit(code || 1);
  }

  if (!stdout) {
    console.error(`${runner === "script" ? "脚本" : "pipeline-agent"} 返回空的 stdout`);
    process.exit(1);
  }

  const validation = validateStepOutput(stepDef.id, stdout);
  for (const w of validation.warnings || []) {
    process.stderr.write(`[run-pipeline-step] 警告: ${w}\n`);
  }
  if (!validation.ok) {
    console.error(`步骤 ${stepDef.id} 输出未通过契约校验:`);
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const normalizedStdout = JSON.stringify(validation.parsed);
  const saved = saveState(opts, stepDef.id, normalizedStdout);
  process.stderr.write(`[run-pipeline-step] 已保存 ${saved}\n`);
  process.stdout.write(normalizedStdout);
}

export {
  parseArgs,
  resolveStdinPath,
  loadStdin,
  resolveRunner,
  runPipelineAgent,
  runStepScript,
  validateStepOutput,
  saveState,
  runStep,
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
