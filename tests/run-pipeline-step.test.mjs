#!/usr/bin/env node
/**
 * L1：run-pipeline-step.mjs 单元测试
 * 运行: node --test tests/run-pipeline-step.test.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getStepDef,
  pipelineStatePath,
  previousStepId,
  resolveRunDate,
  STEP_IDS,
  PIPELINE_STEPS,
} from "../scripts/pipeline-steps.mjs";
import { parseArgs, resolveStdinPath, saveState } from "../scripts/run-pipeline-step.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TRENDING = readFileSync(resolve(__dirname, "fixtures/trending.ok.json"), "utf8");
const STEP_SCRIPT = resolve(__dirname, "../scripts/run-pipeline-step.mjs");

function runNode(args, { env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve(__dirname, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.on("error", reject);
  });
}

test("L1-RS-01 STEP_IDS 与 lobster 四步一致", () => {
  assert.deepEqual(STEP_IDS, ["trending", "analyze", "ppt_preview", "ppt_finalize"]);
  assert.equal(getStepDef("trending").agent, "github-trending");
  assert.equal(getStepDef("analyze").stdinFrom, "trending");
  assert.equal(getStepDef("ppt_preview").stdinFrom, "analyze");
  assert.equal(getStepDef("ppt_finalize").stdinFrom, "ppt_preview");
});

test("L1-RS-02 previousStepId 链", () => {
  assert.equal(previousStepId("trending"), null);
  assert.equal(previousStepId("analyze"), "trending");
  assert.equal(previousStepId("ppt_preview"), "analyze");
  assert.equal(previousStepId("ppt_finalize"), "ppt_preview");
});

test("L1-RS-03 pipelineStatePath 格式", () => {
  const p = pipelineStatePath("artifacts", "2026-06-04", "trending");
  assert.equal(p, "artifacts/2026-06-04/.pipeline/trending.json");
});

test("L1-RS-04 resolveRunDate 默认今日", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(resolveRunDate(""), today);
  assert.equal(resolveRunDate("2026-06-04"), "2026-06-04");
});

test("L1-RS-05 缺少 --step 退出码 2", async () => {
  const { code, stderr } = await runNode([STEP_SCRIPT]);
  assert.equal(code, 2);
  assert.match(stderr, /--step/);
});

test("L1-RS-06 parseArgs 解析完整参数", () => {
  const opts = parseArgs([
    "node",
    "run-pipeline-step.mjs",
    "--step",
    "analyze",
    "--run-date",
    "2026-06-04",
    "--output-dir",
    "artifacts",
    "--stdin-file",
    "/tmp/in.json",
    "--force",
    "--reuse-session",
  ]);
  assert.equal(opts.step, "analyze");
  assert.equal(opts.runDate, "2026-06-04");
  assert.equal(opts.outputDir, "artifacts");
  assert.equal(opts.stdinFile, "/tmp/in.json");
  assert.equal(opts.force, true);
  assert.equal(opts.reuseSession, true);
});

test("L1-RS-07 resolveStdinPath analyze 指向上一步 state", () => {
  const opts = { stdinFile: "", outputDir: "artifacts", runDate: "2026-06-04" };
  const stepDef = getStepDef("analyze");
  const path = resolveStdinPath(opts, stepDef);
  assert.ok(path.endsWith("artifacts/2026-06-04/.pipeline/trending.json"));
});

test("L1-RS-08 resolveStdinPath trending 无 stdin", () => {
  const opts = { stdinFile: "", outputDir: "artifacts", runDate: "2026-06-04" };
  const path = resolveStdinPath(opts, getStepDef("trending"));
  assert.equal(path, null);
});

test("L1-RS-09 saveState 写入 JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "rs-test-"));
  const prevRoot = process.env.STAR_TIDE_ROOT;
  process.env.STAR_TIDE_ROOT = root;
  try {
    const opts = { outputDir: "artifacts", runDate: "2026-06-04" };
    const saved = saveState(opts, "trending", FIXTURE_TRENDING);
    assert.ok(existsSync(saved));
    assert.equal(readFileSync(saved, "utf8"), FIXTURE_TRENDING);
  } finally {
    if (prevRoot === undefined) delete process.env.STAR_TIDE_ROOT;
    else process.env.STAR_TIDE_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("L1-RS-10 未知步骤抛出", () => {
  assert.throws(() => getStepDef("invalid"), /未知步骤/);
});

test("L1-RS-11 各步 timeout 与 pipeline-agent 一致", () => {
  assert.equal(PIPELINE_STEPS.trending.timeout, 1800);
  assert.equal(PIPELINE_STEPS.analyze.timeout, 7200);
  assert.equal(PIPELINE_STEPS.ppt_preview.timeout, 3600);
  assert.equal(PIPELINE_STEPS.ppt_finalize.timeout, 3600);
});
