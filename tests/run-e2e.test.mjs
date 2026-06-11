#!/usr/bin/env node
/**
 * L1：run-e2e.mjs 单元测试
 * 运行: node --test tests/run-e2e.test.mjs
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPipelineOpts,
  defaultPreviewMd,
  findFirstAnalyzeReport,
  normalizeCommand,
  parseArgs,
  resolveManualInputs,
  resolveRunDateFromOpts,
} from "./run-e2e.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("L1-E2E-01 normalizeCommand 支持别名", () => {
  assert.equal(normalizeCommand("ppt-preview"), "ppt_preview");
  assert.equal(normalizeCommand("ppt_finalize"), "ppt_finalize");
  assert.equal(normalizeCommand("ALL"), "all");
});

test("L1-E2E-02 parseArgs 仅保留可变参数", () => {
  const opts = parseArgs([
    "node",
    "run-e2e.mjs",
    "analyze",
    "--date",
    "2026-06-04",
    "--github-url",
    "openclaw/openclaw",
  ]);
  assert.equal(opts.command, "analyze");
  assert.equal(opts.runDate, "2026-06-04");
  assert.equal(opts.githubUrl, "openclaw/openclaw");
});

test("L1-E2E-03 parseArgs validate 子命令", () => {
  const opts = parseArgs(["node", "run-e2e.mjs", "validate", "trending", "--date", "2026-06-04"]);
  assert.equal(opts.command, "validate");
  assert.equal(opts.validateStep, "trending");
});

test("L1-E2E-04 buildPipelineOpts 固定默认 force 与 outputDir", () => {
  const opts = buildPipelineOpts("trending", { runDate: "2026-06-04", noForce: false }, "2026-06-04");
  assert.equal(opts.outputDir, "artifacts");
  assert.equal(opts.force, true);
  assert.equal(opts.step, "trending");
});

test("L1-E2E-05 findFirstAnalyzeReport 自动发现报告", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-report-"));
  const prevRoot = process.env.STAR_TIDE_ROOT;
  process.env.STAR_TIDE_ROOT = root;
  try {
    const dateDir = resolve(root, "artifacts/2026-06-04");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(resolve(dateDir, "01-openclaw-openclaw.md"), "# openclaw/openclaw\n", "utf8");
    assert.equal(findFirstAnalyzeReport("2026-06-04"), "artifacts/2026-06-04/01-openclaw-openclaw.md");
  } finally {
    if (prevRoot === undefined) delete process.env.STAR_TIDE_ROOT;
    else process.env.STAR_TIDE_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("L1-E2E-06 resolveManualInputs ppt_preview 自动 report", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-auto-"));
  const prevRoot = process.env.STAR_TIDE_ROOT;
  process.env.STAR_TIDE_ROOT = root;
  try {
    const dateDir = resolve(root, "artifacts/2026-06-04");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(resolve(dateDir, "02-demo-repo.md"), "# demo/repo\n", "utf8");
    const manual = resolveManualInputs("ppt_preview", { analyzeReport: "" }, "2026-06-04");
    assert.equal(manual.analyzeReport, "artifacts/2026-06-04/02-demo-repo.md");
  } finally {
    if (prevRoot === undefined) delete process.env.STAR_TIDE_ROOT;
    else process.env.STAR_TIDE_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("L1-E2E-07 defaultPreviewMd 路径", () => {
  assert.equal(defaultPreviewMd("2026-06-04"), "artifacts/2026-06-04/ppt/preview.md");
});

test("L1-E2E-08 resolveRunDateFromOpts 回退今日", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(resolveRunDateFromOpts({ runDate: "" }), today);
  assert.equal(resolveRunDateFromOpts({ runDate: "2026-06-04" }), "2026-06-04");
});
