import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import {
  extractRisks,
  extractSection,
  firstMeaningfulLine,
  normalizeAnalyzeContract,
  repoSlug,
  resolveStarTideRoot,
} from "./assemble-analyze.mjs";
import { normalizePptPreviewContract } from "./assemble-ppt.mjs";
import { resolveRunDate } from "../pipeline-steps.mjs";

export function parseGithubRepo(urlOrSlug) {
  const raw = String(urlOrSlug || "").trim();
  if (!raw) throw new Error("GitHub 地址不能为空");

  let owner;
  let repo;
  let fullUrl = raw;

  const slugMatch = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if (slugMatch) {
    owner = slugMatch[1];
    repo = slugMatch[2];
    fullUrl = `https://github.com/${owner}/${repo}`;
  } else {
    const urlMatch = raw.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
    if (!urlMatch) throw new Error(`无法解析 GitHub 地址: ${raw}`);
    owner = urlMatch[1];
    repo = urlMatch[2].replace(/\.git$/, "");
    fullUrl = `https://github.com/${owner}/${repo}`;
  }

  return {
    owner,
    repo,
    name: `${owner}/${repo}`,
    url: fullUrl,
  };
}

export function buildTrendingFromGithubUrl(urlOrSlug, runDate) {
  const date = resolveRunDate(runDate);
  const repo = parseGithubRepo(urlOrSlug);
  return {
    date,
    manual: true,
    expectedCount: 1,
    items: [
      {
        category: "ai",
        rank: 1,
        name: repo.name,
        url: repo.url,
        starsDelta: 0,
      },
    ],
  };
}

function resolveInputPath(inputPath, root = resolveStarTideRoot()) {
  const abs = resolve(root, inputPath);
  if (!existsSync(abs)) throw new Error(`文件不存在: ${inputPath}`);
  return abs;
}

function inferRepoFromReportMd(md, fileName) {
  const heading = md.match(/^#\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*$/m);
  if (heading) return heading[1];

  const fromName = fileName.match(/^\d{2}-(.+)\.md$/i);
  if (fromName) return fromName[1].replace(/-/g, "/");

  return fileName.replace(/\.md$/i, "").replace(/-/g, "/");
}

export function buildAnalyzeFromReportFile(reportFile, { runDate, outputDir = "artifacts", root = resolveStarTideRoot() } = {}) {
  const abs = resolveInputPath(reportFile, root);
  const md = readFileSync(abs, "utf8");
  const date = resolveRunDate(runDate);
  const outputDirRel = `${outputDir}/${date}`;
  const repo = inferRepoFromReportMd(md, basename(abs));
  const reportPath = relative(root, abs).split("\\").join("/");
  const purpose = firstMeaningfulLine(extractSection(md, "1. 项目用途")) || `${repo} 开源项目`;
  const installation = firstMeaningfulLine(extractSection(md, "2. 安装方法")) || "见报告「安装方法」节";
  const architecture = firstMeaningfulLine(extractSection(md, "3. 软件架构")) || "见报告「软件架构」节";

  return normalizeAnalyzeContract({
    date,
    outputDir: outputDirRel,
    manual: true,
    expectedCount: 1,
    partial: true,
    reports: [
      {
        category: "ai",
        rank: 1,
        repo,
        url: `https://github.com/${repo}`,
        clonePath: `${outputDirRel}/clones/${repoSlug(repo)}`,
        reportPath,
        purpose,
        installation,
        architecture,
        structure: architecture.slice(0, 120),
        highlights: [],
        risks: extractRisks(extractSection(md, "5. 风险")),
      },
    ],
  });
}

export function buildPptPreviewFromMdFile(mdFile, { runDate, outputDir = "artifacts", root = resolveStarTideRoot() } = {}) {
  const abs = resolveInputPath(mdFile, root);
  const content = readFileSync(abs, "utf8");
  const date = resolveRunDate(runDate);
  const outputDirRel = `${outputDir}/${date}/ppt`;
  const canonicalPreview = resolve(root, outputDirRel, "preview.md");
  const sourceRel = relative(root, abs).split("\\").join("/");

  let previewPath = sourceRel;
  if (sourceRel !== `${outputDirRel}/preview.md`) {
    mkdirSync(dirname(canonicalPreview), { recursive: true });
    copyFileSync(abs, canonicalPreview);
    previewPath = `${outputDirRel}/preview.md`;
  }

  const headings = (content.match(/^#{1,3}\s+/gm) || []).length;
  return normalizePptPreviewContract({
    date,
    phase: "preview",
    outputDir: outputDirRel,
    previewPath,
    slideCount: Math.max(1, headings),
    pendingApproval: ["手动传入预览文档，请人工复核"],
    summary: `PPT 预览（${headings} 节，手动输入）`,
    manual: true,
    partial: true,
  });
}

export function resolveStepStdin(stepId, opts, fallbackStdin = "") {
  const runDate = resolveRunDate(opts.runDate);
  const common = { runDate, outputDir: opts.outputDir };

  if (stepId === "analyze" && opts.githubUrl) {
    return JSON.stringify(buildTrendingFromGithubUrl(opts.githubUrl, runDate));
  }
  if (stepId === "ppt_preview" && opts.analyzeReport) {
    return JSON.stringify(buildAnalyzeFromReportFile(opts.analyzeReport, common));
  }
  if (stepId === "ppt_finalize" && opts.previewMd) {
    return JSON.stringify(buildPptPreviewFromMdFile(opts.previewMd, common));
  }
  return fallbackStdin;
}
