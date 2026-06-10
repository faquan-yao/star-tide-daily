#!/usr/bin/env node
/**
 * 当 analyze agent 已写出报告但未输出契约 JSON 时，从磁盘报告 + trending 输入重建 analyze 契约。
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { assembleAnalyzeContract } from "./lib/assemble-analyze.mjs";

function parseArgs(argv) {
  const out = { runDate: "", trendingFile: "", outputDir: "artifacts", out: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--trending-file" && argv[i + 1]) out.trendingFile = argv[++i];
    else if (a === "--output-dir" && argv[i + 1]) out.outputDir = argv[++i];
    else if (a === "--out" && argv[i + 1]) out.out = argv[++i];
  }
  if (!out.runDate) {
    console.error(
      "用法: node scripts/assemble-analyze-json.mjs --run-date YYYY-MM-DD [--trending-file 路径] [--output-dir artifacts] [--out 路径]",
    );
    process.exit(2);
  }
  return out;
}

const opts = parseArgs(process.argv);
const contract = assembleAnalyzeContract({
  runDate: opts.runDate,
  outputDir: opts.outputDir,
  trendingFile: opts.trendingFile || undefined,
});
const json = JSON.stringify(contract, null, 2);
if (opts.out) {
  writeFileSync(resolve(process.cwd(), opts.out), json);
  console.error(`已写入: ${resolve(process.cwd(), opts.out)}`);
}
process.stdout.write(json);
