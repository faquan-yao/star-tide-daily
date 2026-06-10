#!/usr/bin/env node
/**
 * L2：校验 star-tide-daily 各步骤 JSON 输出契约
 * 用法:
 *   node tests/validate-output.mjs --step trending --file tests/fixtures/trending.ok.json
 *   node tests/validate-output.mjs --all
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJsonPayload, relocateAgentArtifacts } from "../scripts/pipeline-agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const FIXTURES_DIR = resolve(__dirname, "fixtures");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/;

function parseArgs(argv) {
  const out = { step: null, file: null, all: false, checkFiles: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--step" && argv[i + 1]) out.step = argv[++i];
    else if (a === "--file" && argv[i + 1]) out.file = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--check-files") out.checkFiles = true;
  }
  return out;
}

function resolveInputPath(filePath) {
  if (isAbsolute(filePath)) return filePath;
  const fromCwd = resolve(process.cwd(), filePath);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(PROJECT_ROOT, filePath);
}

function loadJson(filePath) {
  const abs = resolveInputPath(filePath);
  if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const raw = readFileSync(abs, "utf8").trim();
  if (!raw) {
    throw new Error(`file is empty: ${abs} (上游 pipeline 步骤可能失败，请先确认再校验)`);
  }
  const parsed = extractJsonPayload(raw);
  if (!parsed) throw new Error(`invalid JSON in: ${abs}`);
  if (parsed.runId && parsed.result) {
    throw new Error(
      `OpenClaw 信封未能拆出步骤契约 JSON: ${abs}（请通过 pipeline-agent.mjs 输出，或检查 session 中的完整回复）`,
    );
  }
  return parsed;
}

function loadFixture(name) {
  const abs = resolve(FIXTURES_DIR, name);
  if (!existsSync(abs)) throw new Error(`fixture not found: ${abs}`);
  return JSON.parse(readFileSync(abs, "utf8"));
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

const TRENDING_CATEGORIES = ["ai", "new_energy", "autonomous_driving"];

function validateTrending(data, { expectError = false } = {}) {
  const errors = [];
  assert(typeof data === "object" && data !== null, "root must be object", errors);
  assert(typeof data.date === "string" && DATE_RE.test(data.date), "date must be YYYY-MM-DD", errors);
  assert(Array.isArray(data.items), "items must be array", errors);
  if (!Array.isArray(data.items)) return errors;

  if (expectError) {
    assert(typeof data.error === "string" && data.error.length > 0, "error response needs error string", errors);
    assert(data.items.length === 0, "error response items must be empty", errors);
    return errors;
  }

  assert(!data.error, "success response must not have error field", errors);
  assert(data.items.length === 9, "items must have exactly 9 entries", errors);
  const names = new Set();
  for (const category of TRENDING_CATEGORIES) {
    const group = data.items.filter((i) => i.category === category);
    assert(group.length === 3, `category ${category} must have exactly 3 entries`, errors);
    const ranks = group.map((i) => i.rank).sort((a, b) => a - b);
    assert(ranks.join(",") === "1,2,3", `rank in ${category} must be 1,2,3`, errors);
  }
  for (const item of data.items) {
    assert(TRENDING_CATEGORIES.includes(item.category), `invalid category: ${item.category}`, errors);
    assert(typeof item.name === "string" && item.name.includes("/"), "name must be owner/repo", errors);
    assert(!names.has(item.name), `duplicate repo: ${item.name}`, errors);
    names.add(item.name);
    assert(typeof item.url === "string" && GITHUB_URL_RE.test(item.url), `invalid url: ${item.url}`, errors);
    assert(Number.isInteger(item.starsDelta) && item.starsDelta > 0, "starsDelta must be positive integer", errors);
  }
  return errors;
}

function validateAnalyze(data, { checkFiles = false } = {}) {
  const errors = [];
  assert(typeof data === "object" && data !== null, "root must be object", errors);
  assert(typeof data.date === "string" && DATE_RE.test(data.date), "date must be YYYY-MM-DD", errors);
  assert(Array.isArray(data.reports), "reports must be array", errors);
  if (!Array.isArray(data.reports)) return errors;

  if (data.error) {
    assert(data.reports.length === 0, "error response reports must be empty", errors);
    return errors;
  }

  assert(data.reports.length === 9, "reports must have exactly 9 entries", errors);
  assert(typeof data.outputDir === "string" && data.outputDir.length > 0, "outputDir required", errors);
  const repos = new Set();
  for (const category of TRENDING_CATEGORIES) {
    const group = data.reports.filter((r) => r.category === category);
    assert(group.length === 3, `category ${category} must have exactly 3 reports`, errors);
    const ranks = group.map((r) => r.rank).sort((a, b) => a - b);
    assert(ranks.join(",") === "1,2,3", `rank in ${category} must be 1,2,3`, errors);
  }
  for (const r of data.reports) {
    assert(TRENDING_CATEGORIES.includes(r.category), `invalid category: ${r.category}`, errors);
    assert(Number.isInteger(r.rank) && r.rank >= 1 && r.rank <= 3, "report rank 1-3 within category", errors);
    assert(typeof r.repo === "string" && r.repo.includes("/"), "repo must be owner/repo", errors);
    assert(!repos.has(r.repo), `duplicate repo: ${r.repo}`, errors);
    repos.add(r.repo);
    assert(typeof r.url === "string" && GITHUB_URL_RE.test(r.url), `invalid url: ${r.url}`, errors);
    assert(typeof r.clonePath === "string" && r.clonePath.length > 0, "clonePath required", errors);
    assert(typeof r.reportPath === "string" && r.reportPath.endsWith(".md"), "reportPath must be .md", errors);
    assert(typeof r.structure === "string", "structure required", errors);
    assert(Array.isArray(r.highlights) && r.highlights.length > 0, "highlights required", errors);
    assert(Array.isArray(r.risks), "risks must be array", errors);
    if (checkFiles) {
      const abs = resolve(PROJECT_ROOT, r.reportPath);
      const agentAbs = resolve(PROJECT_ROOT, "agents", "opensource-analyzer", r.reportPath);
      if (!existsSync(abs) && existsSync(agentAbs)) {
        assert(
          false,
          `report file under agent workspace (${agentAbs}); rerun pipeline-agent to relocate to ${r.reportPath}`,
          errors,
        );
      } else {
        assert(existsSync(abs), `report file missing on disk: ${r.reportPath}`, errors);
      }
    }
  }
  return errors;
}

function validatePptPreview(data, { checkFiles = false } = {}) {
  const errors = [];
  assert(typeof data === "object" && data !== null, "root must be object", errors);
  assert(data.phase === "preview", 'phase must be "preview"', errors);
  if (data.phase !== "preview") return errors;
  assert(typeof data.date === "string" && DATE_RE.test(data.date), "date must be YYYY-MM-DD", errors);
  assert(typeof data.outputDir === "string", "outputDir required", errors);
  assert(typeof data.previewPath === "string" && data.previewPath.endsWith(".md"), "previewPath must be .md", errors);
  assert(Number.isInteger(data.slideCount) && data.slideCount > 0, "slideCount must be positive integer", errors);
  assert(Array.isArray(data.pendingApproval) && data.pendingApproval.length > 0, "pendingApproval must be non-empty", errors);
  assert(typeof data.summary === "string" && data.summary.length > 0, "summary required", errors);
  if (checkFiles) {
    const abs = resolve(PROJECT_ROOT, data.previewPath);
    assert(existsSync(abs), `preview file missing on disk: ${data.previewPath}`, errors);
  }
  return errors;
}

function validatePptFinalize(data, { checkFiles = false } = {}) {
  const errors = [];
  assert(typeof data === "object" && data !== null, "root must be object", errors);
  assert(data.phase === "finalize", 'phase must be "finalize"', errors);
  if (data.phase !== "finalize") return errors;
  assert(typeof data.date === "string" && DATE_RE.test(data.date), "date must be YYYY-MM-DD", errors);
  assert(Array.isArray(data.files) && data.files.length > 0, "files must be non-empty array", errors);
  if (!Array.isArray(data.files)) return errors;
  assert(data.files.every((f) => typeof f === "string" && f.endsWith(".pptx")), "files must be .pptx paths", errors);
  assert(typeof data.delivery === "object" && data.delivery !== null, "delivery object required", errors);
  if (!data.delivery || typeof data.delivery !== "object") return errors;
  assert(data.delivery.ready === true, "delivery.ready must be true", errors);
  assert(typeof data.delivery.notes === "string", "delivery.notes required", errors);
  if (checkFiles) {
    for (const f of data.files) {
      const abs = resolve(PROJECT_ROOT, f);
      assert(existsSync(abs), `pptx missing on disk: ${f}`, errors);
    }
  }
  return errors;
}

const VALIDATORS = {
  trending: (d, opts) => validateTrending(d, opts),
  analyze: (d, opts) => validateAnalyze(d, opts),
  ppt_preview: (d, opts) => validatePptPreview(d, opts),
  ppt_finalize: (d, opts) => validatePptFinalize(d, opts),
};

function validateStep(step, data, opts = {}) {
  const fn = VALIDATORS[step];
  if (!fn) throw new Error(`unknown step: ${step}`);
  return fn(data, opts);
}

function validateLobsterChain() {
  const errors = [];
  const lobsterPath = resolve(PROJECT_ROOT, "workflows/star-tide-daily.lobster");
  const content = readFileSync(lobsterPath, "utf8");
  const checks = [
    ["stdin: $trending.stdout", "analyze.stdin"],
    ["stdin: $analyze.stdout", "ppt_preview.stdin"],
    ["stdin: $ppt_preview.stdout", "ppt_finalize.stdin"],
    ["approval: required", "ppt_preview.approval"],
    ["condition: $ppt_preview.approved", "ppt_finalize.condition"],
  ];
  for (const [needle, label] of checks) {
    if (!content.includes(needle)) errors.push(`lobster missing: ${label}`);
  }
  return errors;
}

function runOne(label, fn) {
  try {
    const errors = fn();
    if (errors.length === 0) {
      console.log(`OK   ${label}`);
      return true;
    }
    console.error(`FAIL ${label}`);
    for (const e of errors) console.error(`     - ${e}`);
    return false;
  } catch (err) {
    console.error(`FAIL ${label}: ${err.message}`);
    return false;
  }
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.all) {
    let ok = true;
    ok = runOne("L2-07 lobster stdin chain", validateLobsterChain) && ok;
    ok = runOne("L2-01 trending.ok", () => validateStep("trending", loadFixture("trending.ok.json"))) && ok;
    ok = runOne("L2-02 analyze.ok", () => validateStep("analyze", loadFixture("analyze.ok.json"))) && ok;
    ok =
      runOne("L2-03 ppt_preview.ok", () => validateStep("ppt_preview", loadFixture("ppt-preview.ok.json"))) && ok;
    ok =
      runOne("L2-04 ppt_finalize.ok", () => validateStep("ppt_finalize", loadFixture("ppt-finalize.ok.json"))) && ok;
    ok =
      runOne("L2-05 trending.error schema", () =>
        validateStep("trending", loadFixture("trending.error.json"), { expectError: true }),
      ) && ok;
    ok =
      runOne("L2-05b trending.error must fail success schema", () => {
        const errors = validateStep("trending", loadFixture("trending.error.json"));
        return errors.length > 0 ? [] : ["error fixture should fail success trending schema"];
      }) && ok;
    process.exit(ok ? 0 : 1);
  }

  if (!opts.step || !opts.file) {
    console.error(
      "用法: node tests/validate-output.mjs --step <trending|analyze|ppt_preview|ppt_finalize> --file <path>",
    );
    console.error("      node tests/validate-output.mjs --all");
    process.exit(2);
  }

  let data = loadJson(opts.file);
  if (opts.checkFiles) {
    const agentByStep = {
      analyze: "opensource-analyzer",
      ppt_preview: "ppt-maker",
      ppt_finalize: "ppt-maker",
    };
    const agent = agentByStep[opts.step];
    if (agent) data = relocateAgentArtifacts(data, agent);
  }
  const errors = validateStep(opts.step, data, {
    expectError: Boolean(data.error),
    checkFiles: opts.checkFiles,
  });
  if (errors.length === 0) {
    console.log(`OK ${opts.step}: ${opts.file}`);
    process.exit(0);
  }
  console.error(`FAIL ${opts.step}: ${opts.file}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();

export {
  TRENDING_CATEGORIES,
  validateTrending,
  validateAnalyze,
  validatePptPreview,
  validatePptFinalize,
  validateStep,
  validateLobsterChain,
};
