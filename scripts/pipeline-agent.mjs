#!/usr/bin/env node
/**
 * Lobster 流水线步骤：读取 stdin 与提示词文件，调用 openclaw agent --json。
 * 用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>]
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { agent: null, promptFile: null, timeout: 1800, runDate: "", outputDir: "reports/daily" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent" && argv[i + 1]) out.agent = argv[++i];
    else if (a === "--prompt-file" && argv[i + 1]) out.promptFile = argv[++i];
    else if (a === "--timeout" && argv[i + 1]) out.timeout = Number(argv[++i]);
    else if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--output-dir" && argv[i + 1]) out.outputDir = argv[++i];
  }
  if (!out.agent || !out.promptFile) {
    console.error(
      "用法: node scripts/pipeline-agent.mjs --agent <id> --prompt-file <path> [--timeout <秒>] [--run-date YYYY-MM-DD] [--output-dir 路径]",
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

function buildMessage(template, stdin, { runDate, outputDir }) {
  const parts = [template.trim()];
  if (runDate) parts.push(`\n\nrunDate: ${runDate}`);
  parts.push(`\n\noutputDir: ${outputDir}`);
  if (stdin) {
    parts.push("\n\n---\n上一步输出（JSON）：\n");
    parts.push(stdin);
  }
  parts.push(
    "\n\n---\n仅回复单个 JSON 对象（不要用 markdown 代码块，不要附加说明文字）。遵守 AGENTS.md 中的输出契约。",
  );
  return parts.join("");
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
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout: stdout.trim(), stderr });
    });
  });
}

function extractJsonPayload(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stdout.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const promptPath = resolvePromptPath(opts.promptFile);
  let template;
  try {
    template = readFileSync(promptPath, "utf8");
  } catch (err) {
    console.error(`无法读取提示词文件: ${promptPath}`, err.message);
    process.exit(2);
  }

  const stdin = await readStdin();
  const message = buildMessage(template, stdin, {
    runDate: opts.runDate,
    outputDir: opts.outputDir,
  });

  const { code, stdout, stderr } = await runOpenClawAgent(opts.agent, message, opts.timeout);
  const parsed = extractJsonPayload(stdout);

  if (code !== 0) {
    console.error(`openclaw agent 退出码: ${code}`);
    if (stderr) console.error(stderr);
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
  buildMessage,
  extractJsonPayload,
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
