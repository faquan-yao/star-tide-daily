import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { parseTrendingHtml } from "../scripts/lib/github-trending-html.mjs";
import { classifyRepo, rankReposByCategory } from "../scripts/lib/trending-categories.mjs";
import { fetchTrendingItems } from "../scripts/fetch-github-trending.mjs";
import { validateStep } from "./validate-output.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = resolve(__dirname, "fixtures/trending-page.sample.html");

test("L1-FT-01 parseTrendingHtml 提取 repo 与 starsDelta", () => {
  const html = readFileSync(FIXTURE_HTML, "utf8");
  const repos = parseTrendingHtml(html);
  assert.equal(repos.length, 10);
  const openclaw = repos.find((r) => r.name === "openclaw/openclaw");
  assert.ok(openclaw);
  assert.equal(openclaw.starsDelta, 1200);
  assert.equal(openclaw.url, "https://github.com/openclaw/openclaw");
});

test("L1-FT-02 classifyRepo 识别三领域", () => {
  assert.equal(classifyRepo("openclaw/openclaw", "LLM agent"), "ai");
  assert.equal(classifyRepo("openems/openems", "battery solar energy"), "new_energy");
  assert.equal(classifyRepo("commaai/openpilot", "open source driver assistance"), "autonomous_driving");
});

test("L1-FT-03 rankReposByCategory 每领域 Top 3 且无重复", () => {
  const html = readFileSync(FIXTURE_HTML, "utf8");
  const repos = parseTrendingHtml(html);
  const buckets = rankReposByCategory(repos);
  const names = new Set();
  for (const category of ["ai", "new_energy", "autonomous_driving"]) {
    assert.equal(buckets[category].length, 3, category);
    for (const r of buckets[category]) {
      assert.ok(!names.has(r.name), `duplicate ${r.name}`);
      names.add(r.name);
    }
  }
});

test("L1-FT-04 fetchTrendingItems 从 fixture 产出合法契约", async () => {
  const result = await fetchTrendingItems({
    runDate: "2026-06-04",
    htmlFile: "tests/fixtures/trending-page.sample.html",
  });
  assert.equal(result.date, "2026-06-04");
  assert.equal(result.items.length, 9);
  const errors = validateStep("trending", result);
  assert.equal(errors.length, 0, errors.join("; "));
});
