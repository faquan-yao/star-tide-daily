#!/usr/bin/env node
/**
 * Lobster 流水线步骤：读取 stdin 与提示词文件，调用 openclaw agent --json。
 * 用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>]
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assembleAnalyzeContract,
  hasAnalyzeReports,
  isOpenClawEnvelope,
  loadTrendingSources,
  normalizeAnalyzeContract,
  recoverAnalyzeFromEnvelope,
  warnPartialAnalyze,
} from "./lib/assemble-analyze.mjs";
import {
  extractAgentFailureReason,
  hasPptFinalizeContract,
  hasPptPreviewContract,
  normalizePptFinalizeContract,
  normalizePptPreviewContract,
  recoverPptFinalizeFromPipeline,
  recoverPptPreviewFromPipeline,
  warnPartialPptFinalize,
  warnPartialPptPreview,
} from "./lib/assemble-ppt.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
/** 流水线运行产物根目录（相对 STAR_TIDE_ROOT）：artifacts/<date>/、artifacts/<date>/clones/、artifacts/<date>/ppt/ */
const ARTIFACTS_DIR = "artifacts";
let activeChild = null;

function parseArgs(argv) {
  const out = {
    agent: null,
    promptFile: null,
    timeout: 1800,
    runDate: "",
    outputDir: ARTIFACTS_DIR,
    cleanupOnFail: false,
    reuseSession: false,
    maxRetries: 3,
    retryDelayMs: 60_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent" && argv[i + 1]) out.agent = argv[++i];
    else if (a === "--prompt-file" && argv[i + 1]) out.promptFile = argv[++i];
    else if (a === "--timeout" && argv[i + 1]) out.timeout = Number(argv[++i]);
    else if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--output-dir" && argv[i + 1]) out.outputDir = argv[++i];
    else if (a === "--max-retries" && argv[i + 1]) out.maxRetries = Number(argv[++i]);
    else if (a === "--retry-delay-ms" && argv[i + 1]) out.retryDelayMs = Number(argv[++i]);
    else if (a === "--cleanup-on-fail") out.cleanupOnFail = true;
    else if (a === "--reuse-session") out.reuseSession = true;
  }
  if (!out.agent || !out.promptFile) {
    console.error(
      "用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>] [--run-date YYYY-MM-DD] [--output-dir 路径] [--reuse-session] [--max-retries N] [--retry-delay-ms MS] [--cleanup-on-fail]",
    );
    process.exit(2);
  }
  return out;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function buildSessionKey(agent, runDate) {
  const date = runDate || todayDate();
  const suffix = randomBytes(3).toString("hex");
  return `agent:${agent}:pipeline-${date}-${suffix}`;
}

function isRateLimitFailure({ code, stderr }) {
  if (code === 0) return false;
  return /rate.?limit|429|FailoverError/i.test(stderr);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function resolvePromptPath(promptFile) {
  return resolve(PROJECT_ROOT, promptFile);
}

function resolveStarTideRoot() {
  return process.env.STAR_TIDE_ROOT || PROJECT_ROOT;
}

const WORKSPACE_ROOT_FILES = new Set([
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
]);

function buildMessage(template, stdin, { runDate, outputDir, starTideRoot, agent }) {
  const parts = [template.trim()];
  if (runDate) parts.push(`\n\nrunDate: ${runDate}`);
  parts.push(`\n\nSTAR_TIDE_ROOT: ${starTideRoot}`);
  parts.push(`\n\noutputDir: ${outputDir}`);
  parts.push(
    "\n\n所有文件路径（reportPath、clonePath、previewPath、files 等）均以 STAR_TIDE_ROOT 为根目录，写入 artifacts/<date>/（报告）、artifacts/<date>/clones/（克隆）、artifacts/<date>/ppt/（PPT）；勿写入 agent 工作区子目录。",
  );
  if (agent === "opensource-analyzer" && runDate) {
    const clonesAbs = resolve(starTideRoot, outputDir, runDate, "clones");
    const reportsAbs = resolve(starTideRoot, outputDir, runDate);
    parts.push(
      `\n\n【路径强制】克隆必须使用绝对路径目录：${clonesAbs}/owner-repo（示例：git clone --depth 1 <url> "${clonesAbs}/owner-repo"）。`,
      `分析报告写入：${reportsAbs}/01-owner-repo.md。`,
      "禁止在 agents/opensource-analyzer/ 工作区根目录下创建仓库文件夹或报告文件。",
      "每份报告须含五节（用途、安装、架构、运行逻辑、风险）及 2 个 mermaid 图；JSON 须含 purpose、installation、architecture、risks（至少 1 条）。",
    );
    const reportTemplatePath = resolve(PROJECT_ROOT, "prompts/analyze-report-template.md");
    if (existsSync(reportTemplatePath)) {
      parts.push("\n\n---\n报告模板（reportPath 必须遵守）：\n");
      parts.push(readFileSync(reportTemplatePath, "utf8"));
    }
  }
  if (stdin) {
    parts.push("\n\n---\n上一步输出（JSON）：\n");
    parts.push(stdin);
  }
  if (agent === "opensource-analyzer") {
    parts.push(
      "\n\n---\n【执行顺序】",
      "1. 使用工具完成 9 个仓库克隆与 9 份 markdown 报告（此阶段可使用 exec/read/write）。",
      "2. 全部报告落盘后，**最后一轮回复**必须且只能输出 AGENTS.md 中的契约 JSON（禁止再调用任何工具；不要用 markdown 代码块；不要附加说明文字）。",
      "未完成全部报告前不要输出最终 JSON。",
    );
  } else {
    parts.push(
      "\n\n---\n仅回复单个 JSON 对象（不要用 markdown 代码块，不要附加说明文字）。遵守 AGENTS.md 中的输出契约。",
    );
  }
  return parts.join("");
}

function killChildTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
      return;
    }
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
}

function runOpenClawAgent(agent, message, timeoutSec, { sessionKey } = {}) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "agent",
      "--agent",
      agent,
      "--message",
      message,
      "--json",
      "--timeout",
      String(timeoutSec),
    ];
    if (sessionKey) {
      args.push("--session-key", sessionKey);
    }
    const child = spawn("openclaw", args, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      finish(reject, new Error(`openclaw agent 超时 (${timeoutSec}s)，已终止子进程`));
    }, Math.max(1, timeoutSec) * 1000);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (activeChild === child) activeChild = null;
      finish(resolvePromise, { code: code ?? 1, stdout: stdout.trim(), stderr });
    });
  });
}

async function runOpenClawAgentWithRetry(agent, message, timeoutSec, opts) {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.retryDelayMs ?? 60_000;
  let sessionKey = opts.sessionKey || (opts.reuseSession ? undefined : buildSessionKey(agent, opts.runDate));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runOpenClawAgent(agent, message, timeoutSec, { sessionKey });
    if (!isRateLimitFailure(result)) return { ...result, sessionKey };
    if (attempt === maxRetries) return { ...result, sessionKey };
    const delay = baseDelayMs * 2 ** attempt;
    console.error(`[pipeline] API 限流，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
    await sleep(delay);
    sessionKey = buildSessionKey(agent, opts.runDate);
  }

  throw new Error("runOpenClawAgentWithRetry: unreachable");
}

function isPptPreviewRun(opts) {
  return opts.agent === "ppt-maker" && String(opts.promptFile || "").includes("ppt-preview");
}

function isPptFinalizeRun(opts) {
  return opts.agent === "ppt-maker" && String(opts.promptFile || "").includes("ppt-finalize");
}

function isContractOk(parsed, opts) {
  if (!parsed || isOpenClawEnvelope(parsed)) return false;
  if (opts.agent === "opensource-analyzer") return hasAnalyzeReports(parsed);
  if (isPptPreviewRun(opts)) return hasPptPreviewContract(parsed);
  if (isPptFinalizeRun(opts)) return hasPptFinalizeContract(parsed);
  return true;
}

function finalizePptPreviewContract(parsed, agent) {
  if (!hasPptPreviewContract(parsed)) return parsed;
  const out = normalizePptPreviewContract(relocateAgentArtifacts(parsed, agent));
  warnPartialPptPreview(out, "pipeline-agent ");
  return out;
}

function ensurePptPreviewContract(opts, stdin, firstResult) {
  let parsed = normalizePptPreviewContract(extractJsonPayload(firstResult.stdout));
  if (hasPptPreviewContract(parsed) && !isOpenClawEnvelope(parsed)) {
    return finalizePptPreviewContract(parsed, opts.agent);
  }

  const reason =
    extractAgentFailureReason(firstResult.stdout) ||
    (firstResult.code !== 0 ? `agent 退出码 ${firstResult.code}` : "未返回契约 JSON");

  const fallback = recoverPptPreviewFromPipeline({
    runDate: opts.runDate,
    outputDir: opts.outputDir,
    stdin,
    reason,
  });
  if (fallback) {
    process.stderr.write(`[pipeline-agent] ppt_preview 降级草稿: ${fallback.summary}\n`);
    return finalizePptPreviewContract(fallback, opts.agent);
  }

  return parsed;
}

function finalizePptFinalizeContract(parsed, agent) {
  if (!hasPptFinalizeContract(parsed)) return parsed;
  const out = normalizePptFinalizeContract(relocateAgentArtifacts(parsed, agent));
  warnPartialPptFinalize(out, "pipeline-agent ");
  return out;
}

function ensurePptFinalizeContract(opts, stdin, firstResult) {
  let parsed = normalizePptFinalizeContract(extractJsonPayload(firstResult.stdout));
  if (hasPptFinalizeContract(parsed) && !isOpenClawEnvelope(parsed)) {
    return finalizePptFinalizeContract(parsed, opts.agent);
  }

  const reason =
    extractAgentFailureReason(firstResult.stdout) ||
    (firstResult.code !== 0 ? `agent 退出码 ${firstResult.code}` : "未返回契约 JSON");

  const fallback = recoverPptFinalizeFromPipeline({
    runDate: opts.runDate,
    outputDir: opts.outputDir,
    stdin,
    reason,
  });
  if (fallback) {
    process.stderr.write(`[pipeline-agent] ppt_finalize 降级: ${fallback.delivery?.notes}\n`);
    return finalizePptFinalizeContract(fallback, opts.agent);
  }

  return parsed;
}

function finalizeAnalyzeContract(parsed, agent) {
  if (!hasAnalyzeReports(parsed)) return parsed;
  const out = normalizeAnalyzeContract(relocateAgentArtifacts(parsed, agent));
  warnPartialAnalyze(out, "pipeline-agent ");
  return out;
}

async function ensureAnalyzeContract(opts, stdin, firstResult) {
  const starTideRoot = resolveStarTideRoot();
  const runDate = opts.runDate || todayDate();
  let parsed = relocateAgentArtifacts(extractJsonPayload(firstResult.stdout), opts.agent);

  if (hasAnalyzeReports(parsed)) return finalizeAnalyzeContract(parsed, opts.agent);

  relocateMisplacedAnalyzerWorkspace(opts.agent, runDate, opts.outputDir);

  const trending = loadTrendingSources({
    runDate,
    outputDir: opts.outputDir,
    trendingStdin: stdin,
    root: starTideRoot,
  });

  if (trending) {
    try {
      parsed = assembleAnalyzeContract({
        runDate,
        outputDir: opts.outputDir,
        trendingStdin: stdin,
        root: starTideRoot,
      });
      process.stderr.write(
        `[pipeline-agent] 已从磁盘组装 analyze 契约（${parsed.reports.length}/${parsed.expectedCount || 9} 份报告）\n`,
      );
      return finalizeAnalyzeContract(parsed, opts.agent);
    } catch {
      // fall through
    }
  }

  const fromEnvelope = recoverAnalyzeFromEnvelope(firstResult.stdout, { trendingStdin: stdin });
  if (hasAnalyzeReports(fromEnvelope)) {
    process.stderr.write("[pipeline-agent] 已从信封上下文组装 analyze 契约 JSON\n");
    return finalizeAnalyzeContract(fromEnvelope, opts.agent);
  }

  return parsed;
}

function registerSignalHandlers(cleanupOnFail) {
  const onSignal = (signal) => {
    if (activeChild) killChildTree(activeChild);
    if (cleanupOnFail) runPipelineCleanup("--all");
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

function runPipelineCleanup(mode = "") {
  const script = resolve(PROJECT_ROOT, "scripts/cleanup-pipeline.sh");
  if (!existsSync(script)) return;
  const args = mode ? [script, mode] : [script];
  spawnSync("bash", args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: "inherit",
  });
}

function tryRepairTruncatedJson(text) {
  let open = 0;
  for (const ch of text) {
    if (ch === "{") open++;
    else if (ch === "}") open--;
  }
  if (open <= 0) return null;
  try {
    return JSON.parse(text + "}".repeat(open));
  } catch {
    return null;
  }
}

function tryParseContractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const candidate = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return tryRepairTruncatedJson(candidate);
  }
}

function loadContractFromSession(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return null;
  const hints = ["reports", "items", "phase", "pendingApproval"];
  const lines = readFileSync(sessionFile, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    for (const part of row.message.content || []) {
      if (part.type !== "text" || typeof part.text !== "string") continue;
      const trimmed = part.text.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart < 0) continue;
      const candidate = trimmed.slice(jsonStart);
      if (!hints.some((h) => candidate.includes(`"${h}"`))) continue;
      const parsed = tryParseContractJson(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    }
  }
  return null;
}

function unwrapOpenClawAgentResponse(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const result = parsed.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return parsed;

  const candidates = [
    result.payloads?.[0]?.text,
    result.finalAssistantVisibleText,
    result.finalAssistantRawText,
  ];

  for (const payload of result.payloads || []) {
    if (typeof payload?.text === "string") {
      const fromPayload = tryParseContractJson(payload.text);
      if (fromPayload && (fromPayload.reports || fromPayload.items || fromPayload.phase)) return fromPayload;
    }
  }

  for (const candidate of candidates) {
    const contract = tryParseContractJson(candidate);
    if (contract && (contract.reports || contract.items || contract.phase)) return contract;
  }

  const fromSession = loadContractFromSession(result.meta?.agentMeta?.sessionFile);
  if (fromSession) return fromSession;

  return parsed;
}

function extractJsonPayload(stdout) {
  if (!stdout) return null;
  const tryParse = (text) => {
    try {
      return unwrapOpenClawAgentResponse(JSON.parse(text));
    } catch {
      return null;
    }
  };

  const direct = tryParse(stdout);
  if (direct) return direct;

  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParse(stdout.slice(start, end + 1));
  }
  return null;
}

function relocateFromAgentWorkspace(relativePath, agent) {
  if (!relativePath || !agent) return;
  const dest = resolve(PROJECT_ROOT, relativePath);
  if (existsSync(dest)) return;
  const src = resolve(PROJECT_ROOT, "agents", agent, relativePath);
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  if (lstatSync(src).isDirectory()) {
    symlinkSync(src, dest, "dir");
  } else {
    copyFileSync(src, dest);
  }
}

function relocateAgentArtifacts(payload, agent) {
  if (!payload || typeof payload !== "object" || !agent) return payload;

  if (typeof payload.outputDir === "string") {
    relocateFromAgentWorkspace(payload.outputDir, agent);
  }
  if (Array.isArray(payload.reports)) {
    for (const report of payload.reports) {
      if (report.reportPath) relocateFromAgentWorkspace(report.reportPath, agent);
      if (report.clonePath) relocateFromAgentWorkspace(report.clonePath, agent);
    }
  }
  if (typeof payload.previewPath === "string") {
    relocateFromAgentWorkspace(payload.previewPath, agent);
  }
  if (Array.isArray(payload.files)) {
    for (const file of payload.files) {
      if (typeof file === "string") relocateFromAgentWorkspace(file, agent);
    }
  }

  return payload;
}

/** 将误放在 agents/<agent>/ 根下的克隆目录与报告迁到 artifacts/<date>/ */
function relocateMisplacedAnalyzerWorkspace(agent, runDate, outputDir = ARTIFACTS_DIR) {
  if (agent !== "opensource-analyzer" || !runDate) return [];
  const workspace = resolve(PROJECT_ROOT, "agents", agent);
  if (!existsSync(workspace)) return [];

  const root = resolveStarTideRoot();
  const dateDir = resolve(root, outputDir, runDate);
  const clonesDir = resolve(dateDir, "clones");
  mkdirSync(clonesDir, { recursive: true });
  mkdirSync(dateDir, { recursive: true });

  const moved = [];
  for (const name of readdirSync(workspace)) {
    if (name === ".openclaw" || WORKSPACE_ROOT_FILES.has(name)) continue;

    const src = resolve(workspace, name);
    if (!existsSync(src)) continue;

    let dest;
    if (lstatSync(src).isDirectory()) {
      if (!existsSync(resolve(src, ".git"))) continue;
      dest = resolve(clonesDir, name);
    } else if (/^\d{2}-.+\.md$/i.test(name)) {
      dest = resolve(dateDir, name);
    } else {
      continue;
    }

    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    moved.push({ from: src, to: dest });
  }
  return moved;
}

async function main() {
  const opts = parseArgs(process.argv);
  registerSignalHandlers(opts.cleanupOnFail);
  const promptPath = resolvePromptPath(opts.promptFile);
  let template;
  try {
    template = readFileSync(promptPath, "utf8");
  } catch (err) {
    console.error(`无法读取提示词文件: ${promptPath}`, err.message);
    process.exit(2);
  }

  const stdin = await readStdin();
  const starTideRoot = resolveStarTideRoot();
  const message = buildMessage(template, stdin, {
    runDate: opts.runDate,
    outputDir: opts.outputDir,
    starTideRoot,
    agent: opts.agent,
  });

  let code;
  let stdout;
  let stderr;
  let sessionKey;
  try {
    ({ code, stdout, stderr, sessionKey } = await runOpenClawAgentWithRetry(opts.agent, message, opts.timeout, {
      runDate: opts.runDate,
      reuseSession: opts.reuseSession,
      maxRetries: opts.maxRetries,
      retryDelayMs: opts.retryDelayMs,
    }));
  } catch (err) {
    if (isPptPreviewRun(opts)) {
      const fallback = recoverPptPreviewFromPipeline({
        runDate: opts.runDate,
        outputDir: opts.outputDir,
        stdin,
        reason: err.message || "agent 异常",
      });
      if (fallback) {
        process.stderr.write("[pipeline-agent] ppt agent 异常，已输出 ppt_preview 降级契约 JSON\n");
        process.stdout.write(JSON.stringify(finalizePptPreviewContract(fallback, opts.agent), null, 0));
        return;
      }
    }
    if (isPptFinalizeRun(opts)) {
      const fallback = recoverPptFinalizeFromPipeline({
        runDate: opts.runDate,
        outputDir: opts.outputDir,
        stdin,
        reason: err.message || "agent 异常",
      });
      if (fallback) {
        process.stderr.write("[pipeline-agent] ppt agent 异常，已输出 ppt_finalize 降级契约 JSON\n");
        process.stdout.write(JSON.stringify(finalizePptFinalizeContract(fallback, opts.agent), null, 0));
        return;
      }
    }
    if (opts.cleanupOnFail) runPipelineCleanup("--all");
    console.error(err.message || err);
    process.exit(1);
  }

  let parsed = relocateAgentArtifacts(extractJsonPayload(stdout), opts.agent);
  if (opts.agent === "opensource-analyzer") {
    parsed = await ensureAnalyzeContract(opts, stdin, { stdout, sessionKey });
    const runDate = parsed?.date || opts.runDate || todayDate();
    const moved = relocateMisplacedAnalyzerWorkspace(opts.agent, runDate, opts.outputDir);
    if (moved.length > 0) {
      process.stderr.write(
        `[pipeline-agent] 已从 agent 工作区迁出 ${moved.length} 项到 artifacts/${runDate}/\n`,
      );
      parsed = relocateAgentArtifacts(parsed, opts.agent);
    }
  } else if (isPptPreviewRun(opts)) {
    parsed = ensurePptPreviewContract(opts, stdin, { stdout, code });
  } else if (isPptFinalizeRun(opts)) {
    parsed = ensurePptFinalizeContract(opts, stdin, { stdout, code });
  }

  const contractOk = isContractOk(parsed, opts);

  if (code !== 0 && !contractOk) {
    console.error(`openclaw agent 退出码: ${code}`);
    if (stderr) console.error(stderr);
    if (opts.cleanupOnFail) runPipelineCleanup("--all");
    process.exit(code || 1);
  }

  if (code !== 0 && contractOk) {
    process.stderr.write(`[pipeline-agent] agent 退出码 ${code}，已输出降级契约 JSON\n`);
  }

  if (contractOk) {
    process.stdout.write(JSON.stringify(parsed, null, 0));
  } else {
    console.error("openclaw agent 未能拆出步骤契约 JSON");
    if (stdout) console.error(stdout.slice(0, 500));
    if (opts.cleanupOnFail) runPipelineCleanup("--all");
    process.exit(1);
  }
}

export {
  PROJECT_ROOT,
  ARTIFACTS_DIR,
  parseArgs,
  readStdin,
  resolvePromptPath,
  resolveStarTideRoot,
  buildMessage,
  buildSessionKey,
  isRateLimitFailure,
  sleep,
  runOpenClawAgent,
  runOpenClawAgentWithRetry,
  tryParseContractJson,
  tryRepairTruncatedJson,
  loadContractFromSession,
  unwrapOpenClawAgentResponse,
  extractJsonPayload,
  relocateFromAgentWorkspace,
  relocateAgentArtifacts,
  relocateMisplacedAnalyzerWorkspace,
  killChildTree,
  runPipelineCleanup,
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
