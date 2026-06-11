import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pipelineStatePath } from "../pipeline-steps.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const DATE_IN_SESSION_RE = /pipeline-(\d{4}-\d{2}-\d{2})-/;

export function resolveStarTideRoot() {
  return process.env.STAR_TIDE_ROOT || PROJECT_ROOT;
}

export function repoSlug(repo) {
  return repo.replace("/", "-");
}

export function isOpenClawEnvelope(obj) {
  return obj && typeof obj === "object" && typeof obj.runId === "string" && obj.result && typeof obj.result === "object";
}

export function hasAnalyzeReports(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.date === "string" &&
    Array.isArray(obj.reports) &&
    obj.reports.length > 0
  );
}

export function isAnalyzeContract(obj) {
  return hasAnalyzeReports(obj) && obj.reports.length === 9;
}

export function normalizeAnalyzeReport(report) {
  if (!report || typeof report !== "object") return report;
  if (!Array.isArray(report.highlights)) {
    report.highlights =
      report.highlights == null || report.highlights === "" ? [] : [String(report.highlights)];
  }
  if (!Array.isArray(report.risks)) {
    report.risks =
      report.risks == null || report.risks === "" ? ["见报告「风险」节"] : [String(report.risks)];
  }
  if (typeof report.structure !== "string" || report.structure.length === 0) {
    report.structure =
      typeof report.architecture === "string" && report.architecture.length > 0
        ? report.architecture.slice(0, 120)
        : "见报告";
  }
  return report;
}

export function normalizeAnalyzeContract(contract) {
  if (!contract || !Array.isArray(contract.reports)) return contract;
  for (const report of contract.reports) normalizeAnalyzeReport(report);
  return contract;
}

export function warnPartialAnalyze(contract, prefix = "") {
  if (!contract?.reports || contract.reports.length >= 9) return;
  const missing = contract.missing?.length
    ? contract.missing.join(", ")
    : `缺 ${9 - contract.reports.length} 份`;
  const msg = `${prefix}analyze 报告 ${contract.reports.length}/9（${missing}），继续后续步骤`;
  process.stderr.write(`[star-tide] 警告: ${msg}\n`);
}

export function extractRunDateFromEnvelope(envelope) {
  if (!envelope?.result) return "";
  const meta = envelope.result.meta || {};
  const sessionKey =
    meta.systemPromptReport?.sessionKey ||
    meta.agentMeta?.sessionKey ||
    meta.sessionKey ||
    "";
  const fromKey = sessionKey.match(DATE_IN_SESSION_RE);
  if (fromKey) return fromKey[1];
  return "";
}

function parseTrendingObjectAt(text, jsonStart) {
  if (jsonStart < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < jsonStart) return null;
  const candidate = text.slice(jsonStart, end + 1);
  const attempts = [
    candidate,
    candidate.replace(/\\"/g, '"').replace(/\\n/g, "\n"),
  ];
  for (const attempt of attempts) {
    try {
      const obj = JSON.parse(attempt);
      if (Array.isArray(obj.items) && obj.items.length > 0 && obj.items[0]?.name) return obj;
    } catch {
      // continue
    }
  }
  return null;
}

export function extractTrendingFromText(text) {
  if (!text || typeof text !== "string") return null;

  const markers = ["上一步输出（JSON）", "上一步输出（JSON）:", "starsDelta"];
  for (const marker of markers) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(marker, searchFrom);
      if (idx < 0) break;
      const jsonStart = text.lastIndexOf("{", idx);
      const obj = parseTrendingObjectAt(text, jsonStart);
      if (obj) return obj;
      searchFrom = idx + marker.length;
    }
  }

  const itemsIdx = text.lastIndexOf('"items"');
  if (itemsIdx >= 0) {
    const obj = parseTrendingObjectAt(text, text.lastIndexOf("{", itemsIdx));
    if (obj) return obj;
  }

  return null;
}

function parseTrendingRaw(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw.trim());
    if (Array.isArray(data?.items) && data.items.length > 0) return data;
    if (data?.result) {
      const fromText = extractTrendingFromText(raw);
      if (fromText) return fromText;
    }
  } catch {
    return extractTrendingFromText(raw);
  }
  return null;
}

export function loadTrendingSources({
  runDate,
  outputDir = "artifacts",
  trendingStdin,
  trendingFile,
  root = resolveStarTideRoot(),
}) {
  const candidates = [];
  if (trendingStdin) candidates.push(trendingStdin);
  if (trendingFile) {
    const abs = resolve(root, trendingFile);
    if (existsSync(abs)) candidates.push(readFileSync(abs, "utf8"));
  }
  if (runDate) {
    const statePath = resolve(root, pipelineStatePath(outputDir, runDate, "trending"));
    if (existsSync(statePath)) candidates.push(readFileSync(statePath, "utf8"));
    const tmpTrending = `/tmp/trending.out.json`;
    if (existsSync(tmpTrending)) candidates.push(readFileSync(tmpTrending, "utf8"));
  }
  for (const raw of candidates) {
    const data = parseTrendingRaw(raw);
    if (data) return data;
  }
  return null;
}

export function extractSection(md, heading) {
  const re = new RegExp(`^## ${heading}\\s*$`, "m");
  const match = re.exec(md);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^## \d+\./m);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return body.trim();
}

export function firstMeaningfulLine(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("```") || t === "---") continue;
    if (t.startsWith("#")) continue;
    return t.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").slice(0, 240);
  }
  return "";
}

export function extractRisks(sectionText) {
  const risks = [];
  for (const line of sectionText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("-") && !t.startsWith("*")) continue;
    const item = t.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim();
    if (item) risks.push(item.slice(0, 240));
  }
  return risks.length > 0 ? risks.slice(0, 5) : ["见报告「风险」节"];
}

function findReportFile(artifactsDir, index, repo) {
  const numbered = resolve(artifactsDir, `${String(index).padStart(2, "0")}-${repoSlug(repo)}.md`);
  if (existsSync(numbered)) return numbered;
  const suffix = `-${repoSlug(repo)}.md`;
  const hit = readdirSync(artifactsDir)
    .filter((f) => f.endsWith(suffix))
    .sort()[0];
  if (hit) return resolve(artifactsDir, hit);
  return null;
}

export function countAnalyzeReportsOnDisk(runDate, outputDir = "artifacts", root = resolveStarTideRoot()) {
  const artifactsDir = resolve(root, outputDir, runDate);
  if (!existsSync(artifactsDir)) return 0;
  return readdirSync(artifactsDir).filter((f) => /^\d{2}-.+\.md$/i.test(f)).length;
}

export function listMissingAnalyzeReports(trending, runDate, outputDir = "artifacts", root = resolveStarTideRoot()) {
  const artifactsDir = resolve(root, outputDir, runDate);
  const missing = [];
  for (let i = 0; i < trending.items.length; i++) {
    const repo = trending.items[i].name;
    if (!findReportFile(artifactsDir, i + 1, repo)) missing.push(repo);
  }
  return missing;
}

export function assembleAnalyzeContract({
  runDate,
  outputDir = "artifacts",
  trendingStdin,
  trendingFile,
  root = resolveStarTideRoot(),
}) {
  const trending = loadTrendingSources({ runDate, outputDir, trendingStdin, trendingFile, root });
  if (!trending) {
    throw new Error(
      `找不到 trending 输入（需 trending stdin、--trending-file 或 ${pipelineStatePath(outputDir, runDate, "trending")}）`,
    );
  }

  const date = trending.date || runDate;
  const outputDirRel = `${outputDir}/${date}`;
  const artifactsDir = resolve(root, outputDirRel);
  if (!existsSync(artifactsDir)) throw new Error(`artifacts 目录不存在: ${artifactsDir}`);

  const reports = [];
  const missing = [];
  for (let i = 0; i < trending.items.length; i++) {
    const item = trending.items[i];
    const repo = item.name;
    const reportFile = findReportFile(artifactsDir, i + 1, repo);
    if (!reportFile) {
      missing.push(repo);
      continue;
    }
    const md = readFileSync(reportFile, "utf8");
    const purpose = firstMeaningfulLine(extractSection(md, "1. 项目用途")) || `${repo} 开源项目`;
    const installation = firstMeaningfulLine(extractSection(md, "2. 安装方法")) || "见报告「安装方法」节";
    const architecture = firstMeaningfulLine(extractSection(md, "3. 软件架构")) || "见报告「软件架构」节";
    const reportName = reportFile.split("/").pop();

    reports.push({
      category: item.category,
      rank: item.rank,
      repo,
      url: item.url,
      clonePath: `${outputDirRel}/clones/${repoSlug(repo)}`,
      reportPath: `${outputDirRel}/${reportName}`,
      purpose,
      installation,
      architecture,
      structure: architecture.slice(0, 120),
      highlights: [],
      risks: extractRisks(extractSection(md, "5. 风险")),
    });
  }

  if (reports.length === 0) {
    throw new Error(`磁盘上无任何分析报告: ${artifactsDir}`);
  }

  const result = { date, outputDir: outputDirRel, reports };
  if (missing.length > 0) {
    result.partial = true;
    result.missing = missing;
    result.expectedCount = trending.items.length;
  }
  return result;
}

export function recoverAnalyzeFromEnvelope(raw, { trendingStdin } = {}) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isOpenClawEnvelope(envelope)) return null;

  const runDate = extractRunDateFromEnvelope(envelope);
  if (!runDate) return null;

  const trendingStdinResolved =
    trendingStdin || extractTrendingFromText(raw) || extractTrendingFromText(JSON.stringify(envelope));

  try {
    const contract = assembleAnalyzeContract({
      runDate,
      trendingStdin: trendingStdinResolved ? JSON.stringify(trendingStdinResolved) : undefined,
    });
    return hasAnalyzeReports(contract) ? contract : null;
  } catch {
    return null;
  }
}
