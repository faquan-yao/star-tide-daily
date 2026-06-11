#!/usr/bin/env node
/**
 * L1：build-step-input.mjs 单元测试
 * 运行: node --test tests/build-step-input.test.mjs
 */

import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalyzeFromReportFile,
  buildPptPreviewFromMdFile,
  buildTrendingFromGithubUrl,
  parseGithubRepo,
  resolveStepStdin,
} from "../scripts/lib/build-step-input.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_REPORT = resolve(__dirname, "fixtures/analyze-report.sample.md");

test("L1-BSI-01 parseGithubRepo 支持 slug 与 URL", () => {
  assert.deepEqual(parseGithubRepo("openclaw/openclaw"), {
    owner: "openclaw",
    repo: "openclaw",
    name: "openclaw/openclaw",
    url: "https://github.com/openclaw/openclaw",
  });
  assert.equal(parseGithubRepo("https://github.com/lobehub/lobe-chat/").name, "lobehub/lobe-chat");
});

test("L1-BSI-02 buildTrendingFromGithubUrl 单仓库 trending", () => {
  const trending = buildTrendingFromGithubUrl("openclaw/openclaw", "2026-06-04");
  assert.equal(trending.date, "2026-06-04");
  assert.equal(trending.manual, true);
  assert.equal(trending.expectedCount, 1);
  assert.equal(trending.items.length, 1);
  assert.equal(trending.items[0].name, "openclaw/openclaw");
});

test("L1-BSI-03 buildAnalyzeFromReportFile 从 markdown 组装 analyze 契约", () => {
  const root = mkdtempSync(join(tmpdir(), "bsi-analyze-"));
  const prevRoot = process.env.STAR_TIDE_ROOT;
  process.env.STAR_TIDE_ROOT = root;
  try {
    const reportRel = "artifacts/2026-06-04/01-openclaw-openclaw.md";
    const reportAbs = resolve(root, reportRel);
    mkdirSync(dirname(reportAbs), { recursive: true });
    copyFileSync(SAMPLE_REPORT, reportAbs);

    const analyze = buildAnalyzeFromReportFile(reportRel, {
      runDate: "2026-06-04",
      outputDir: "artifacts",
      root,
    });
    assert.equal(analyze.manual, true);
    assert.equal(analyze.reports.length, 1);
    assert.equal(analyze.reports[0].repo, "openclaw/openclaw");
    assert.equal(analyze.reports[0].reportPath, reportRel);
    assert.match(analyze.reports[0].purpose, /Personal AI assistant/i);
  } finally {
    if (prevRoot === undefined) delete process.env.STAR_TIDE_ROOT;
    else process.env.STAR_TIDE_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("L1-BSI-04 buildPptPreviewFromMdFile 从 markdown 组装 preview 契约", () => {
  const root = mkdtempSync(join(tmpdir(), "bsi-preview-"));
  const prevRoot = process.env.STAR_TIDE_ROOT;
  process.env.STAR_TIDE_ROOT = root;
  try {
    const previewRel = "custom/preview-draft.md";
    const previewAbs = resolve(root, previewRel);
    mkdirSync(dirname(previewAbs), { recursive: true });
    writeFileSync(
      previewAbs,
      "# Cover\n\n## AI\n\n### Project A\n\n## Summary\n",
      "utf8",
    );

    const preview = buildPptPreviewFromMdFile(previewRel, {
      runDate: "2026-06-04",
      outputDir: "artifacts",
      root,
    });
    assert.equal(preview.phase, "preview");
    assert.equal(preview.previewPath, "artifacts/2026-06-04/ppt/preview.md");
    assert.ok(preview.slideCount >= 1);
    assert.equal(preview.manual, true);
  } finally {
    if (prevRoot === undefined) delete process.env.STAR_TIDE_ROOT;
    else process.env.STAR_TIDE_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("L1-BSI-05 resolveStepStdin 手动输入优先于 fallback", () => {
  const opts = {
    runDate: "2026-06-04",
    outputDir: "artifacts",
    githubUrl: "openclaw/openclaw",
    analyzeReport: "",
    previewMd: "",
  };
  const stdin = resolveStepStdin("analyze", opts, '{"from":"fallback"}');
  const parsed = JSON.parse(stdin);
  assert.equal(parsed.manual, true);
  assert.equal(parsed.items[0].name, "openclaw/openclaw");
});
