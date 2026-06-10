#!/usr/bin/env node
/**
 * Lobster 流水线步骤：读取 stdin 与提示词文件，调用 openclaw agent --json。
 * 用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>]
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function buildMessage(template, stdin, { runDate, outputDir, starTideRoot }) {
  const parts = [template.trim()];
  if (runDate) parts.push(`\n\nrunDate: ${runDate}`);
  parts.push(`\n\nSTAR_TIDE_ROOT: ${starTideRoot}`);
  parts.push(`\n\noutputDir: ${outputDir}`);
  parts.push(
    "\n\n所有文件路径（reportPath、clonePath、previewPath、files 等）均以 STAR_TIDE_ROOT 为根目录，写入 artifacts/<date>/（报告）、artifacts/<date>/clones/（克隆）、artifacts/<date>/ppt/（PPT）；勿写入 agent 工作区子目录。",
  );
  if (stdin) {
    parts.push("\n\n---\n上一步输出（JSON）：\n");
    parts.push(stdin);
  }
  parts.push(
    "\n\n---\n仅回复单个 JSON 对象（不要用 markdown 代码块，不要附加说明文字）。遵守 AGENTS.md 中的输出契约。",
  );
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
  let sessionKey = opts.reuseSession ? undefined : buildSessionKey(agent, opts.runDate);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runOpenClawAgent(agent, message, timeoutSec, { sessionKey });
    if (!isRateLimitFailure(result)) return result;
    if (attempt === maxRetries) return result;
    const delay = baseDelayMs * 2 ** attempt;
    console.error(`[pipeline] API 限流，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
    await sleep(delay);
    sessionKey = buildSessionKey(agent, opts.runDate);
  }

  throw new Error("runOpenClawAgentWithRetry: unreachable");
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

  for (const candidate of candidates) {
    const contract = tryParseContractJson(candidate);
    if (contract) return contract;
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
  });

  let code;
  let stdout;
  let stderr;
  try {
    ({ code, stdout, stderr } = await runOpenClawAgentWithRetry(opts.agent, message, opts.timeout, {
      runDate: opts.runDate,
      reuseSession: opts.reuseSession,
      maxRetries: opts.maxRetries,
      retryDelayMs: opts.retryDelayMs,
    }));
  } catch (err) {
    if (opts.cleanupOnFail) runPipelineCleanup("--all");
    console.error(err.message || err);
    process.exit(1);
  }

  const parsed = relocateAgentArtifacts(extractJsonPayload(stdout), opts.agent);

  if (code !== 0) {
    console.error(`openclaw agent 退出码: ${code}`);
    if (stderr) console.error(stderr);
    if (opts.cleanupOnFail) runPipelineCleanup("--all");
    process.exit(code || 1);
  }

  if (parsed) {
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
