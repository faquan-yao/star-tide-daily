import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pipelineStatePath } from "../pipeline-steps.mjs";
import { hasAnalyzeReports, normalizeAnalyzeContract, resolveStarTideRoot } from "./assemble-analyze.mjs";

function parseJsonContract(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

export function hasPptPreviewContract(obj) {
  return obj && typeof obj === "object" && obj.phase === "preview" && typeof obj.date === "string";
}

export function hasPptFinalizeContract(obj) {
  return obj && typeof obj === "object" && obj.phase === "finalize" && Array.isArray(obj.files);
}

export function normalizePptPreviewContract(contract) {
  if (!contract || contract.phase !== "preview") return contract;
  if (!Array.isArray(contract.pendingApproval)) {
    contract.pendingApproval =
      contract.pendingApproval == null ? ["待人工复核"] : [String(contract.pendingApproval)];
  }
  if (!Number.isInteger(contract.slideCount) || contract.slideCount <= 0) {
    contract.slideCount = Math.max(1, contract.pendingApproval.length);
  }
  if (typeof contract.summary !== "string" || contract.summary.length === 0) {
    contract.summary = "PPT 预览草稿";
  }
  return contract;
}

export function parseAnalyzeStdin(stdin) {
  if (!stdin || !stdin.trim()) return null;
  const parsed = parseJsonContract(stdin);
  if (hasAnalyzeReports(parsed)) return normalizeAnalyzeContract(parsed);
  return null;
}

export function extractAgentFailureReason(stdout) {
  if (!stdout) return "";
  try {
    const envelope = JSON.parse(stdout);
    const payloads = envelope?.result?.payloads || [];
    for (const p of payloads) {
      if (typeof p?.text === "string" && /fail|error|timeout|abort/i.test(p.text)) return p.text.slice(0, 120);
    }
    if (envelope?.status === "timeout") return "agent 超时";
    if (envelope?.summary === "aborted") return "agent 已中止";
  } catch {
    // not envelope
  }
  return "";
}

function buildStubPreviewMarkdown(analyze, reason) {
  const lines = [
    `# Star Tide Daily — PPT 预览草稿（${analyze.date}）`,
    "",
    reason ? `> 说明：${reason}。以下为根据分析报告自动整理的提纲，需人工补全版式与图表。` : "",
    "",
    `共 ${analyze.reports.length} 份分析报告。`,
    "",
  ];
  let section = "";
  for (const r of analyze.reports) {
    if (r.category !== section) {
      section = r.category;
      lines.push(`## ${section}`, "");
    }
    lines.push(
      `### ${r.rank}. ${r.repo}`,
      "",
      `- **用途**：${r.purpose || "见报告"}`,
      `- **安装**：${r.installation || "见报告"}`,
      `- **架构**：${r.architecture || "见报告"}`,
      `- **风险**：${Array.isArray(r.risks) ? r.risks.join("；") : "见报告"}`,
      `- **报告**：${r.reportPath}`,
      "",
    );
  }
  lines.push("## 待审批", "", "- [ ] 全文版式与 Mermaid 图需人工复核", "");
  return lines.filter((l) => l !== undefined).join("\n");
}

export function recoverPptPreviewFromDisk(runDate, outputDir = "artifacts", root = resolveStarTideRoot()) {
  const outputDirRel = `${outputDir}/${runDate}/ppt`;
  const previewPath = `${outputDirRel}/preview.md`;
  const abs = resolve(root, previewPath);
  if (!existsSync(abs)) return null;

  const content = readFileSync(abs, "utf8");
  const headings = (content.match(/^#{1,3}\s+/gm) || []).length;
  return normalizePptPreviewContract({
    date: runDate,
    phase: "preview",
    outputDir: outputDirRel,
    previewPath,
    slideCount: Math.max(1, headings),
    pendingApproval: ["从磁盘 preview.md 恢复，请人工复核"],
    summary: `PPT 预览（${headings} 节）`,
    partial: true,
  });
}

export function synthesizePptPreviewFromAnalyze(analyze, { runDate, outputDir = "artifacts", reason = "" } = {}) {
  const root = resolveStarTideRoot();
  const date = analyze.date || runDate;
  const outputDirRel = `${outputDir}/${date}/ppt`;
  const previewPath = `${outputDirRel}/preview.md`;
  const abs = resolve(root, previewPath);

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buildStubPreviewMarkdown(analyze, reason), "utf8");

  const pending = ["全文需人工复核版式与架构/运行逻辑图"];
  if (reason) pending.unshift(`PPT agent 未完成: ${reason}`);

  return normalizePptPreviewContract({
    date,
    phase: "preview",
    outputDir: outputDirRel,
    previewPath,
    slideCount: Math.max(4, analyze.reports.length * 4),
    pendingApproval: pending,
    summary: `基于 ${analyze.reports.length} 份分析报告自动生成的预览提纲`,
    partial: true,
    reportCount: analyze.reports.length,
  });
}

export function findLatestRunDateWithAnalyze(root = resolveStarTideRoot(), outputDir = "artifacts") {
  const artifactsRoot = resolve(root, outputDir);
  if (!existsSync(artifactsRoot)) return "";
  const dates = readdirSync(artifactsRoot)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const date of dates) {
    const analyzePath = resolve(root, pipelineStatePath(outputDir, date, "analyze"));
    if (existsSync(analyzePath)) return date;
  }
  return dates[0] || "";
}

export function loadAnalyzeState(runDate, outputDir = "artifacts", root = resolveStarTideRoot()) {
  const candidates = [
    resolve(root, pipelineStatePath(outputDir, runDate, "analyze")),
    "/tmp/analyze.out.json",
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) continue;
    const parsed = parseJsonContract(raw);
    if (hasAnalyzeReports(parsed)) return normalizeAnalyzeContract(parsed);
  }
  return null;
}

export function recoverPptPreviewFromPipeline({ runDate, outputDir = "artifacts", stdin, reason = "" } = {}) {
  const root = resolveStarTideRoot();
  const date = runDate || findLatestRunDateWithAnalyze(root, outputDir);
  if (!date) return null;

  const fromDisk = recoverPptPreviewFromDisk(date, outputDir, root);
  if (fromDisk) return fromDisk;

  const analyze = parseAnalyzeStdin(stdin) || loadAnalyzeState(date, outputDir, root);
  if (!analyze) return null;

  return synthesizePptPreviewFromAnalyze(analyze, {
    runDate: date,
    outputDir,
    reason: reason || "上游 PPT agent 未产出契约 JSON",
  });
}

export function warnPartialPptPreview(contract, prefix = "") {
  if (!contract?.partial) return;
  process.stderr.write(
    `[star-tide] 警告: ${prefix}ppt_preview 使用降级草稿（${contract.summary || "partial"}），继续后续步骤\n`,
  );
}

export function normalizePptFinalizeContract(contract) {
  if (!contract || contract.phase !== "finalize") return contract;
  if (!Array.isArray(contract.files)) contract.files = [];
  if (!contract.delivery || typeof contract.delivery !== "object") {
    contract.delivery = { ready: false, notes: "待人工定稿" };
  }
  if (typeof contract.delivery.notes !== "string") {
    contract.delivery.notes = String(contract.delivery.notes || "待人工定稿");
  }
  if (typeof contract.outputDir !== "string" || !contract.outputDir) {
    contract.outputDir = `artifacts/${contract.date}/ppt`;
  }
  return contract;
}

export function parsePptPreviewStdin(stdin) {
  if (!stdin || !stdin.trim()) return null;
  const parsed = parseJsonContract(stdin);
  if (hasPptPreviewContract(parsed)) return normalizePptPreviewContract(parsed);
  return null;
}

export function loadPptPreviewState(runDate, outputDir = "artifacts", root = resolveStarTideRoot()) {
  const candidates = [
    resolve(root, pipelineStatePath(outputDir, runDate, "ppt_preview")),
    "/tmp/ppt-preview.out.json",
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) continue;
    const parsed = parseJsonContract(raw);
    if (hasPptPreviewContract(parsed)) return normalizePptPreviewContract(parsed);
  }
  return null;
}

export function recoverPptFinalizeFromDisk(runDate, outputDir = "artifacts", root = resolveStarTideRoot()) {
  const outputDirRel = `${outputDir}/${runDate}/ppt`;
  const pptDir = resolve(root, outputDirRel);
  if (!existsSync(pptDir)) return null;

  const pptxNames = readdirSync(pptDir).filter((f) => f.endsWith(".pptx")).sort();
  if (pptxNames.length === 0) return null;

  return normalizePptFinalizeContract({
    date: runDate,
    phase: "finalize",
    outputDir: outputDirRel,
    files: pptxNames.map((f) => `${outputDirRel}/${f}`),
    delivery: {
      ready: true,
      notes: "从磁盘 .pptx 恢复；对外发布前请复核",
    },
  });
}

export function synthesizePptFinalizeFallback({
  runDate,
  outputDir = "artifacts",
  preview,
  reason = "",
} = {}) {
  const date = preview?.date || runDate;
  const outputDirRel = preview?.outputDir || `${outputDir}/${date}/ppt`;
  const pptxPath = `${outputDirRel}/daily-report-${date}.pptx`;
  const root = resolveStarTideRoot();
  const pptxAbs = resolve(root, pptxPath);
  const hasPptx = existsSync(pptxAbs);

  const notes = [
    reason || "PPT finalize agent 未生成 .pptx",
    preview?.partial ? "预览为降级草稿" : "",
    hasPptx ? "已检测到 pptx 文件" : "请基于 preview.md 人工导出 .pptx",
    preview?.pendingApproval?.length ? `待复核: ${preview.pendingApproval.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("；");

  return normalizePptFinalizeContract({
    date,
    phase: "finalize",
    outputDir: outputDirRel,
    files: [pptxPath],
    delivery: {
      ready: hasPptx,
      notes,
    },
    partial: !hasPptx,
    previewPath: preview?.previewPath,
  });
}

export function recoverPptFinalizeFromPipeline({
  runDate,
  outputDir = "artifacts",
  stdin,
  reason = "",
} = {}) {
  const root = resolveStarTideRoot();
  const date = runDate || findLatestRunDateWithAnalyze(root, outputDir);
  if (!date) return null;

  const fromDisk = recoverPptFinalizeFromDisk(date, outputDir, root);
  if (fromDisk) return fromDisk;

  const preview = parsePptPreviewStdin(stdin) || loadPptPreviewState(date, outputDir, root);
  if (!preview) {
    const previewDisk = recoverPptPreviewFromDisk(date, outputDir, root);
    if (previewDisk) {
      return synthesizePptFinalizeFallback({
        runDate: date,
        outputDir,
        preview: previewDisk,
        reason: reason || "上游 finalize agent 未产出契约 JSON",
      });
    }
    return null;
  }

  return synthesizePptFinalizeFallback({
    runDate: date,
    outputDir,
    preview,
    reason: reason || "上游 finalize agent 未产出契约 JSON",
  });
}

export function warnPartialPptFinalize(contract, prefix = "") {
  if (!contract?.partial) return;
  process.stderr.write(
    `[star-tide] 警告: ${prefix}ppt_finalize 降级（${contract.delivery?.notes || "partial"}），继续后续步骤\n`,
  );
}
