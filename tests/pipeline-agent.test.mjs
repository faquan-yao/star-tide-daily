#!/usr/bin/env node
/**
 * L1：pipeline-agent.mjs 单元测试（mock openclaw）
 * 运行: node --test tests/pipeline-agent.test.mjs
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { PROJECT_ROOT, buildMessage, extractJsonPayload } from "../scripts/pipeline-agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_SCRIPT = resolve(PROJECT_ROOT, "scripts/pipeline-agent.mjs");

function runNode(args, { env = {}, input = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    if (input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", reject);
  });
}

function createMockOpenclawDir({ exitCode = 0, stdout = '{"ok":true}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mock-openclaw-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "openclaw");
  const body = `#!/usr/bin/env bash
set -euo pipefail
MESSAGE=""
ARGS=("$@")
i=0
while [[ $i -lt \${#ARGS[@]} ]]; do
  if [[ "\${ARGS[$i]}" == "--message" ]]; then
    MESSAGE="\${ARGS[$((i+1))]}"
    break
  fi
  i=$((i+1))
done
if [[ -n "\${MOCK_OPENCLAW_CAPTURE:-}" ]]; then
  printf '%s' "$MESSAGE" > "\${MOCK_OPENCLAW_CAPTURE}"
fi
printf '%s' '${stdout.replace(/'/g, "'\\''")}'
exit ${exitCode}
`;
  writeFileSync(scriptPath, body, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { dir: binDir };
}

test("L1-01 missing --agent exits 2", async () => {
  const { code, stderr } = await runNode([PIPELINE_SCRIPT, "--prompt-file", "prompts/trending.md"]);
  assert.equal(code, 2);
  assert.match(stderr, /用法/);
});

test("L1-06 missing prompt file exits 2", async () => {
  const mock = createMockOpenclawDir();
  const { code, stderr } = await runNode(
    [PIPELINE_SCRIPT, "--agent", "github-trending", "--prompt-file", "prompts/no-such-file.md"],
    { env: { PATH: `${mock.dir}:${process.env.PATH}` } },
  );
  assert.equal(code, 2);
  assert.match(stderr, /无法读取提示词文件/);
});

test("L1-04 extractJsonPayload parses wrapped JSON", () => {
  const raw = 'log prefix\n{"date":"2026-06-04","items":[]}\ntrailer';
  const parsed = extractJsonPayload(raw);
  assert.equal(parsed.date, "2026-06-04");
});

test("L1-03 buildMessage includes stdin JSON section", () => {
  const msg = buildMessage("# task", '{"rank":1}', { runDate: "2026-06-04", outputDir: "reports/daily" });
  assert.match(msg, /上一步输出/);
  assert.match(msg, /\{"rank":1\}/);
  assert.match(msg, /runDate: 2026-06-04/);
});

test("L1-03 piped stdin reaches openclaw --message", async () => {
  const capture = join(tmpdir(), `msg-${Date.now()}.txt`);
  const mock = createMockOpenclawDir({ stdout: '{"piped":true}' });
  const { code, stdout } = await runNode(
    [
      PIPELINE_SCRIPT,
      "--agent",
      "github-trending",
      "--prompt-file",
      "prompts/trending.md",
      "--timeout",
      "30",
    ],
    {
      env: {
        PATH: `${mock.dir}:${process.env.PATH}`,
        MOCK_OPENCLAW_CAPTURE: capture,
      },
      input: '{"from":"stdin"}',
    },
  );
  assert.equal(code, 0);
  assert.match(stdout, /"piped":true/);
  const { readFileSync } = await import("node:fs");
  const captured = readFileSync(capture, "utf8");
  assert.match(captured, /上一步输出/);
  assert.match(captured, /\{"from":"stdin"\}/);
});

test("L1-05 non-zero openclaw exit propagates", async () => {
  const mock = createMockOpenclawDir({ exitCode: 1, stdout: "" });
  const { code, stderr } = await runNode(
    [PIPELINE_SCRIPT, "--agent", "github-trending", "--prompt-file", "prompts/trending.md", "--timeout", "5"],
    { env: { PATH: `${mock.dir}:${process.env.PATH}` } },
  );
  assert.equal(code, 1);
  assert.match(stderr, /openclaw agent 退出码/);
});

test("L1-02 TTY stdin does not block (mock openclaw invoked quickly)", async () => {
  const mock = createMockOpenclawDir({ stdout: '{"tty":true}' });
  const cmd = `timeout 5 node ${JSON.stringify(PIPELINE_SCRIPT)} --agent github-trending --prompt-file prompts/trending.md --timeout 5`;
  const { code, stdout } = await new Promise((resolvePromise, reject) => {
    const child = spawn("script", ["-q", "-c", cmd, "/dev/null"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATH: `${mock.dir}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (c) => resolvePromise({ code: c ?? 1, stdout: out }));
  });
  assert.notEqual(code, 124, "should not hit timeout 124");
  assert.match(stdout + "", /"tty":true|"tty": true/);
});
