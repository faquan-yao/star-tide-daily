#!/usr/bin/env node
/**
 * L1：pipeline-agent.mjs 单元测试（mock openclaw）
 * 运行: node --test tests/pipeline-agent.test.mjs
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROJECT_ROOT,
  buildMessage,
  buildSessionKey,
  extractJsonPayload,
  isRateLimitFailure,
  relocateAgentArtifacts,
  tryParseContractJson,
  tryRepairTruncatedJson,
} from "../scripts/pipeline-agent.mjs";

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
SESSION_KEY=""
ARGS=("$@")
i=0
while [[ $i -lt \${#ARGS[@]} ]]; do
  if [[ "\${ARGS[$i]}" == "--message" ]]; then
    MESSAGE="\${ARGS[$((i+1))]}"
  elif [[ "\${ARGS[$i]}" == "--session-key" ]]; then
    SESSION_KEY="\${ARGS[$((i+1))]}"
  fi
  i=$((i+1))
done
if [[ -n "\${MOCK_OPENCLAW_CAPTURE:-}" ]]; then
  printf '%s' "$MESSAGE" > "\${MOCK_OPENCLAW_CAPTURE}"
fi
if [[ -n "\${MOCK_OPENCLAW_ARGS_CAPTURE:-}" ]]; then
  printf '%s' "$SESSION_KEY" > "\${MOCK_OPENCLAW_ARGS_CAPTURE}"
fi
printf '%s' '${stdout.replace(/'/g, "'\\''")}'
exit ${exitCode}
`;
  writeFileSync(scriptPath, body, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { dir: binDir };
}

function createRetryMockOpenclawDir({ failUntil = 2, stdout = '{"retried":true}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mock-openclaw-retry-"));
  const binDir = join(dir, "bin");
  const counterFile = join(dir, "counter");
  writeFileSync(counterFile, "0", "utf8");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "openclaw");
  const body = `#!/usr/bin/env bash
set -euo pipefail
count=$(cat "${counterFile}")
count=$((count + 1))
echo "$count" > "${counterFile}"
if [[ $count -le ${failUntil} ]]; then
  echo "GatewayClientRequestError: FailoverError: API rate limit reached" >&2
  exit 1
fi
printf '%s' '${stdout.replace(/'/g, "'\\''")}'
exit 0
`;
  writeFileSync(scriptPath, body, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { dir: binDir, counterFile };
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

test("L1-04 tryRepairTruncatedJson closes missing braces", () => {
  const broken = '{"date":"2026-06-04","items":[{"rank":1}]';
  const repaired = tryRepairTruncatedJson(broken);
  assert.equal(repaired.date, "2026-06-04");
  assert.equal(repaired.items.length, 1);
});

test("L1-04 extractJsonPayload unwraps truncated openclaw payload text", () => {
  const contract = {
    date: "2026-06-04",
    reports: [{ rank: 1, repo: "a/b" }],
  };
  const full = JSON.stringify(contract);
  const truncated = full.slice(0, -1);
  const envelope = {
    runId: "x",
    status: "ok",
    result: { payloads: [{ text: truncated }] },
  };
  const parsed = extractJsonPayload(JSON.stringify(envelope));
  assert.equal(parsed.date, "2026-06-04");
  assert.equal(parsed.reports.length, 1);
  assert.equal(tryParseContractJson(truncated).date, "2026-06-04");
});

test("L1-04 extractJsonPayload unwraps openclaw agent envelope", () => {
  const contract = {
    date: "2026-06-04",
    items: [{ rank: 1, name: "owner/repo", url: "https://github.com/owner/repo", starsDelta: 100 }],
  };
  const envelope = {
    runId: "test-run",
    status: "ok",
    result: {
      payloads: [{ text: JSON.stringify(contract) }],
      finalAssistantVisibleText: JSON.stringify(contract),
    },
  };
  const parsed = extractJsonPayload(JSON.stringify(envelope));
  assert.equal(parsed.date, "2026-06-04");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].name, "owner/repo");
  assert.equal(parsed.runId, undefined);
});

test("L1-03 buildMessage includes stdin JSON section", () => {
  const msg = buildMessage("# task", '{"rank":1}', {
    runDate: "2026-06-04",
    outputDir: "reports/daily",
    starTideRoot: PROJECT_ROOT,
  });
  assert.match(msg, /上一步输出/);
  assert.match(msg, /\{"rank":1\}/);
  assert.match(msg, /runDate: 2026-06-04/);
  assert.match(msg, new RegExp(`STAR_TIDE_ROOT: ${PROJECT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("L1-07 relocateAgentArtifacts copies report files from agent workspace", () => {
  const rel = "reports/daily/2099-01-01/01-relocate-test.md";
  const agentDir = join(PROJECT_ROOT, "agents", "opensource-analyzer", rel);
  const dest = join(PROJECT_ROOT, rel);
  mkdirSync(dirname(agentDir), { recursive: true });
  writeFileSync(agentDir, "# relocate test\n", "utf8");
  try {
    relocateAgentArtifacts({ reports: [{ reportPath: rel }] }, "opensource-analyzer");
    assert.ok(existsSync(dest));
    assert.match(readFileSync(dest, "utf8"), /relocate test/);
    assert.ok(lstatSync(dest).isFile());
  } finally {
    rmSync(join(PROJECT_ROOT, "agents", "opensource-analyzer", "reports", "daily", "2099-01-01"), {
      recursive: true,
      force: true,
    });
    rmSync(join(PROJECT_ROOT, "reports", "daily", "2099-01-01"), { recursive: true, force: true });
  }
});

test("L1-07b relocateAgentArtifacts symlinks directories from agent workspace", () => {
  const relDir = "tmp/clones/2099-01-01/demo-repo";
  const agentDir = join(PROJECT_ROOT, "agents", "opensource-analyzer", relDir);
  const dest = join(PROJECT_ROOT, relDir);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "README.md"), "demo\n", "utf8");
  try {
    relocateAgentArtifacts({ reports: [{ clonePath: relDir }] }, "opensource-analyzer");
    assert.ok(existsSync(dest));
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.match(readFileSync(join(dest, "README.md"), "utf8"), /demo/);
  } finally {
    rmSync(join(PROJECT_ROOT, "agents", "opensource-analyzer", "tmp"), { recursive: true, force: true });
    rmSync(join(PROJECT_ROOT, "tmp", "clones", "2099-01-01"), { recursive: true, force: true });
  }
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
    [
      PIPELINE_SCRIPT,
      "--agent",
      "github-trending",
      "--prompt-file",
      "prompts/trending.md",
      "--timeout",
      "5",
      "--max-retries",
      "0",
    ],
    { env: { PATH: `${mock.dir}:${process.env.PATH}` } },
  );
  assert.equal(code, 1);
  assert.match(stderr, /openclaw agent 退出码/);
});

test("L1-08 buildSessionKey uses agent and runDate", () => {
  const key = buildSessionKey("github-trending", "2026-06-04");
  assert.match(key, /^agent:github-trending:pipeline-2026-06-04-[0-9a-f]{6}$/);
});

test("L1-08 isRateLimitFailure detects rate limit errors", () => {
  assert.equal(isRateLimitFailure({ code: 0, stderr: "" }), false);
  assert.equal(
    isRateLimitFailure({ code: 1, stderr: "FailoverError: API rate limit reached" }),
    true,
  );
  assert.equal(isRateLimitFailure({ code: 1, stderr: "429 status code" }), true);
  assert.equal(isRateLimitFailure({ code: 1, stderr: "unknown agent id" }), false);
});

test("L1-08 passes isolated session key to openclaw by default", async () => {
  const argsCapture = join(tmpdir(), `session-key-${Date.now()}.txt`);
  const mock = createMockOpenclawDir({ stdout: '{"session":true}' });
  const { code } = await runNode(
    [
      PIPELINE_SCRIPT,
      "--agent",
      "github-trending",
      "--prompt-file",
      "prompts/trending.md",
      "--run-date",
      "2026-06-04",
      "--timeout",
      "30",
      "--max-retries",
      "0",
    ],
    {
      env: {
        PATH: `${mock.dir}:${process.env.PATH}`,
        MOCK_OPENCLAW_ARGS_CAPTURE: argsCapture,
      },
    },
  );
  assert.equal(code, 0);
  const sessionKey = readFileSync(argsCapture, "utf8");
  assert.match(sessionKey, /^agent:github-trending:pipeline-2026-06-04-[0-9a-f]{6}$/);
});

test("L1-08 retries on rate limit and succeeds", async () => {
  const mock = createRetryMockOpenclawDir({ failUntil: 2, stdout: '{"retried":true}' });
  const { code, stdout, stderr } = await runNode(
    [
      PIPELINE_SCRIPT,
      "--agent",
      "github-trending",
      "--prompt-file",
      "prompts/trending.md",
      "--timeout",
      "30",
      "--max-retries",
      "3",
      "--retry-delay-ms",
      "10",
    ],
    { env: { PATH: `${mock.dir}:${process.env.PATH}` }, timeoutMs: 15000 },
  );
  assert.equal(code, 0);
  assert.match(stdout, /"retried":true/);
  assert.match(stderr, /API 限流/);
  assert.equal(Number(readFileSync(mock.counterFile, "utf8")), 3);
});

test("L1-08 non-rate-limit errors are not retried", async () => {
  const mock = createMockOpenclawDir({ exitCode: 1, stdout: "" });
  const scriptPath = join(mock.dir, "openclaw");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
echo "unknown agent id github-trending" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const counterFile = join(tmpdir(), `no-retry-${Date.now()}.txt`);
  writeFileSync(counterFile, "0", "utf8");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
count=$(cat "${counterFile}")
count=$((count + 1))
echo "$count" > "${counterFile}"
echo "unknown agent id github-trending" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const { code } = await runNode(
    [
      PIPELINE_SCRIPT,
      "--agent",
      "github-trending",
      "--prompt-file",
      "prompts/trending.md",
      "--timeout",
      "5",
      "--max-retries",
      "3",
      "--retry-delay-ms",
      "10",
    ],
    { env: { PATH: `${mock.dir}:${process.env.PATH}` } },
  );
  assert.equal(code, 1);
  assert.equal(readFileSync(counterFile, "utf8").trim(), "1");
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
