#!/usr/bin/env node
/**
 * Lobster 流水线步骤：读取 stdin 与提示词文件，调用 openclaw agent --json。
 * 用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>]
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
let activeChild = null;

function parseArgs(argv) {
  const out = {
    agent: null,
    promptFile: null,
    timeout: 1800,
    runDate: "",
    outputDir: "reports/daily",
    cleanupOnFail: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent" && argv[i + 1]) out.agent = argv[++i];
    else if (a === "--prompt-file" && argv[i + 1]) out.promptFile = argv[++i];
    else if (a === "--timeout" && argv[i + 1]) out.timeout = Number(argv[++i]);
    else if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--output-dir" && argv[i + 1]) out.outputDir = argv[++i];
    else if (a === "--cleanup-on-fail") out.cleanupOnFail = true;
  }
  if (!out.agent || !out.promptFile) {
    console.error(
      "用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>] [--run-date YYYY-MM-DD] [--output-dir 路径] [--cleanup-on-fail]",
    );
    process.exit(2);
  }
  return out;
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
    "\n\n所有文件路径（reportPath、clonePath、previewPath、files 等）均以 STAR_TIDE_ROOT 为根目录；勿写入 agent 工作区子目录。",
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

function runOpenClawAgent(agent, message, timeoutSec) {
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
    ({ code, stdout, stderr } = await runOpenClawAgent(opts.agent, message, opts.timeout));
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
  } else if (stdout) {
    process.stdout.write(stdout);
  } else {
    console.error("openclaw agent 返回空的 stdout");
    process.exit(1);
  }
}

export {
  PROJECT_ROOT,
  parseArgs,
  readStdin,
  resolvePromptPath,
  resolveStarTideRoot,
  buildMessage,
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
