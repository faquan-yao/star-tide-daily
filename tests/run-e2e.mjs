#!/usr/bin/env node
/**
 * L3 E2E 测试入口：只需步骤名与可变参数，其余（路径、校验、force 等）自动处理。
 *
 * 用法:
 *   node tests/run-e2e.mjs preflight [--static]
 *   node tests/run-e2e.mjs trending [--date YYYY-MM-DD]
 *   node tests/run-e2e.mjs analyze [--date YYYY-MM-DD] [--github-url URL]
 *   node tests/run-e2e.mjs ppt-preview [--date YYYY-MM-DD] [--report 路径]
 *   node tests/run-e2e.mjs ppt-finalize [--date YYYY-MM-DD] [--preview 路径]
 *   node tests/run-e2e.mjs all [--date YYYY-MM-DD]
 *   node tests/run-e2e.mjs validate <step> [--date YYYY-MM-DD]
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveStarTideRoot } from "../scripts/pipeline-agent.mjs";
import { getStepDef, pipelineStatePath, resolveRunDate, STEP_IDS } from "../scripts/pipeline-steps.mjs";
import { loadStdin, runStep, saveState, validateStepOutput } from "../scripts/run-pipeline-step.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const VALIDATE_SCRIPT = resolve(__dirname, "validate-output.mjs");
const PREFLIGHT_SCRIPT = resolve(__dirname, "preflight.sh");
const OUTPUT_DIR = "artifacts";

const STEP_ALIASES = {
  preflight: "preflight",
  trending: "trending",
  analyze: "analyze",
  "ppt-preview": "ppt_preview",
  ppt_preview: "ppt_preview",
  preview: "ppt_preview",
  "ppt-finalize": "ppt_finalize",
  ppt_finalize: "ppt_finalize",
  finalize: "ppt_finalize",
  all: "all",
  validate: "validate",
};

const PIPELINE_STEPS = ["trending", "analyze", "ppt_preview", "ppt_finalize"];

function usage() {
  return `用法: node tests/run-e2e.mjs <command> [可变参数]

命令:
  preflight [--static]              L0 环境检查
  trending [--date DATE]            L3-A 趋势抓取
  analyze [--date DATE] [--github-url URL]
  ppt-preview [--date DATE] [--report 路径]
  ppt-finalize [--date DATE] [--preview 路径]
  all [--date DATE]                 顺序执行四步（链式）
  validate <step> [--date DATE]     仅校验已保存的 .pipeline state

可变参数（均可省略，有默认值）:
  --date, --run-date    运行日期（默认: 今日或环境变量 RUN_DATE）
  --github-url          analyze 单仓库冒烟
  --report              ppt_preview 分析报告 .md（省略时自动发现或读上一步 state）
  --preview             ppt_finalize 预览 .md（省略时自动发现或读上一步 state）

固定默认（无需输入）: outputDir=artifacts, --force, 步骤后自动 validate --check-files
`;
}

export function normalizeCommand(raw) {
  if (!raw) return "";
  return STEP_ALIASES[String(raw).trim().toLowerCase()] || "";
}

export function parseArgs(argv) {
  const out = {
    command: "",
    validateStep: "",
    runDate: process.env.RUN_DATE || "",
    githubUrl: "",
    analyzeReport: "",
    previewMd: "",
    staticPreflight: false,
    noForce: false,
    cleanupOnFail: false,
    help: false,
  };

  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if ((a === "--date" || a === "--run-date") && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--github-url" && argv[i + 1]) out.githubUrl = argv[++i];
    else if (a === "--report" && argv[i + 1]) out.analyzeReport = argv[++i];
    else if (a === "--preview" && argv[i + 1]) out.previewMd = argv[++i];
    else if (a === "--static") out.staticPreflight = true;
    else if (a === "--no-force") out.noForce = true;
    else if (a === "--cleanup-on-fail") out.cleanupOnFail = true;
    else if (a.startsWith("-")) throw new Error(`未知参数: ${a}`);
    else positional.push(a);
  }

  if (positional[0]) out.command = normalizeCommand(positional[0]);
  if (out.command === "validate" && positional[1]) {
    out.validateStep = normalizeCommand(positional[1]);
    if (!STEP_IDS.includes(out.validateStep)) {
      throw new Error(`validate 步骤无效: ${positional[1]}（可选: ${STEP_IDS.join(", ")}）`);
    }
  }

  return out;
}

export function resolveRunDateFromOpts(opts) {
  return resolveRunDate(opts.runDate);
}

function projectRoot() {
  return process.env.STAR_TIDE_ROOT || resolveStarTideRoot() || PROJECT_ROOT;
}

export function findFirstAnalyzeReport(runDate, outputDir = OUTPUT_DIR, root = projectRoot()) {
  const dir = resolve(root, outputDir, runDate);
  if (!existsSync(dir)) return "";
  const hit = readdirSync(dir)
    .filter((f) => /^\d{2}-.+\.md$/i.test(f))
    .sort()[0];
  return hit ? `${outputDir}/${runDate}/${hit}` : "";
}

export function defaultPreviewMd(runDate, outputDir = OUTPUT_DIR) {
  return `${outputDir}/${runDate}/ppt/preview.md`;
}

export function hasPipelineState(stepId, runDate, outputDir = OUTPUT_DIR, root = projectRoot()) {
  return existsSync(resolve(root, pipelineStatePath(outputDir, runDate, stepId)));
}

export function resolveManualInputs(command, opts, runDate) {
  const resolved = {
    githubUrl: opts.githubUrl,
    analyzeReport: opts.analyzeReport,
    previewMd: opts.previewMd,
  };

  if (command === "ppt_preview" && !resolved.analyzeReport && !hasPipelineState("analyze", runDate)) {
    const autoReport = findFirstAnalyzeReport(runDate);
    if (autoReport) {
      resolved.analyzeReport = autoReport;
      process.stderr.write(`[run-e2e] 自动选用分析报告: ${autoReport}\n`);
    }
  }

  if (command === "ppt_finalize" && !resolved.previewMd && !hasPipelineState("ppt_preview", runDate)) {
    const autoPreview = defaultPreviewMd(runDate);
    if (existsSync(resolve(projectRoot(), autoPreview))) {
      resolved.previewMd = autoPreview;
      process.stderr.write(`[run-e2e] 自动选用预览文档: ${autoPreview}\n`);
    }
  }

  return resolved;
}

export function buildPipelineOpts(command, opts, runDate) {
  const manual = resolveManualInputs(command, opts, runDate);
  return {
    step: command,
    runDate,
    outputDir: OUTPUT_DIR,
    stdinFile: "",
    githubUrl: manual.githubUrl,
    analyzeReport: manual.analyzeReport,
    previewMd: manual.previewMd,
    force: !opts.noForce,
    cleanupOnFail: opts.cleanupOnFail,
    reuseSession: false,
    useLlm: false,
    maxRetries: 3,
    retryDelayMs: 60_000,
  };
}

function runPreflight(staticOnly) {
  const args = staticOnly ? ["--static"] : [];
  const result = spawnSync("bash", [PREFLIGHT_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, STAR_TIDE_ROOT: projectRoot() },
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function runValidateFile(stepId, filePath, { checkFiles = true } = {}) {
  const args = [VALIDATE_SCRIPT, "--step", stepId, "--file", filePath];
  if (checkFiles) args.push("--check-files");
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, STAR_TIDE_ROOT: projectRoot() },
    stdio: "inherit",
  });
  return result.status ?? 1;
}

async function executePipelineStep(command, opts) {
  const runDate = resolveRunDateFromOpts(opts);
  const pipelineOpts = buildPipelineOpts(command, opts, runDate);
  const stepDef = getStepDef(command);

  process.stderr.write(
    `[run-e2e] 步骤=${command} date=${runDate} outputDir=${OUTPUT_DIR} force=${pipelineOpts.force}\n`,
  );

  const stdin = loadStdin(pipelineOpts, stepDef);
  let code;
  let stdout;
  let stderr;
  try {
    ({ code, stdout, stderr } = await runStep(stepDef, pipelineOpts, stdin));
  } catch (err) {
    console.error(err.message || err);
    return 1;
  }

  if (code !== 0) {
    console.error(`[run-e2e] 步骤 ${command} 失败，退出码: ${code}`);
    if (stderr) console.error(stderr);
    return code || 1;
  }

  if (!stdout) {
    console.error(`[run-e2e] 步骤 ${command} 返回空 stdout`);
    return 1;
  }

  const validation = validateStepOutput(command, stdout);
  for (const w of validation.warnings || []) {
    process.stderr.write(`[run-e2e] 警告: ${w}\n`);
  }
  if (!validation.ok) {
    console.error(`[run-e2e] 步骤 ${command} 契约校验失败:`);
    for (const e of validation.errors) console.error(`  - ${e}`);
    return 1;
  }

  const normalizedStdout = JSON.stringify(validation.parsed);
  const saved = saveState(pipelineOpts, command, normalizedStdout);
  process.stderr.write(`[run-e2e] 已保存 state: ${saved}\n`);

  const validateCode = runValidateFile(command, saved, { checkFiles: true });
  if (validateCode !== 0) return validateCode;

  console.log(`OK   ${command} (${runDate})`);
  return 0;
}

async function runValidateOnly(opts) {
  const runDate = resolveRunDateFromOpts(opts);
  const stepId = opts.validateStep;
  const stateFile = resolve(projectRoot(), pipelineStatePath(OUTPUT_DIR, runDate, stepId));
  if (!existsSync(stateFile)) {
    console.error(`[run-e2e] 缺少 state 文件: ${stateFile}`);
    return 2;
  }
  process.stderr.write(`[run-e2e] 校验 ${stepId} state: ${stateFile}\n`);
  const code = runValidateFile(stepId, stateFile, { checkFiles: true });
  if (code === 0) console.log(`OK   validate ${stepId} (${runDate})`);
  return code;
}

async function runAll(opts) {
  for (const step of PIPELINE_STEPS) {
    const code = await executePipelineStep(step, opts);
    if (code !== 0) return code;
  }
  console.log(`OK   all (${resolveRunDateFromOpts(opts)})`);
  return 0;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message || err);
    console.error(usage());
    process.exit(2);
  }

  if (opts.help || !opts.command) {
    console.error(usage());
    process.exit(opts.help ? 0 : 2);
  }

  if (!process.env.STAR_TIDE_ROOT) {
    process.env.STAR_TIDE_ROOT = projectRoot();
  }

  let code = 1;
  if (opts.command === "preflight") {
    code = runPreflight(opts.staticPreflight);
    if (code === 0) console.log("OK   preflight");
  } else if (opts.command === "validate") {
    if (!opts.validateStep) {
      console.error("validate 需要指定步骤，例如: node tests/run-e2e.mjs validate trending");
      process.exit(2);
    }
    code = await runValidateOnly(opts);
  } else if (opts.command === "all") {
    code = await runAll(opts);
  } else if (STEP_IDS.includes(opts.command)) {
    code = await executePipelineStep(opts.command, opts);
  } else {
    console.error(`未知命令: ${process.argv[2]}`);
    console.error(usage());
    process.exit(2);
  }

  process.exit(code);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
