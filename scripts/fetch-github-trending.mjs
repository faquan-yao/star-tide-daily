#!/usr/bin/env node
/**
 * 确定性抓取 GitHub Trending（分领域 Top 3，共 9 条）— 替代 LLM github-trending agent
 * 用法: node scripts/fetch-github-trending.mjs [--run-date YYYY-MM-DD]
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrendingHtml } from "./lib/github-trending-html.mjs";
import {
  TRENDING_CATEGORIES,
  CATEGORY_SEARCH_QUERIES,
  rankReposByCategory,
} from "./lib/trending-categories.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const TRENDING_URL = "https://github.com/trending?since=daily";
const USER_AGENT = "star-tide-daily/1.0 (+https://github.com/faquan-yao/star-tide-daily)";

function parseArgs(argv) {
  const out = { runDate: "", htmlFile: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-date" && argv[i + 1]) out.runDate = argv[++i];
    else if (a === "--html-file" && argv[i + 1]) out.htmlFile = argv[++i];
  }
  return out;
}

/** Asia/Shanghai 日历下的「昨日」YYYY-MM-DD */
export function yesterdayInShanghai(runDate) {
  if (runDate && /^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    return runDate;
  }
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  shanghai.setDate(shanghai.getDate() - 1);
  const y = shanghai.getFullYear();
  const m = String(shanghai.getMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function fetchTrendingHtml(htmlFile) {
  if (htmlFile) {
    const { readFileSync } = await import("node:fs");
    return readFileSync(resolve(PROJECT_ROOT, htmlFile), "utf8");
  }
  const res = await fetch(TRENDING_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub Trending HTTP ${res.status}`);
  return res.text();
}

function estimateStarsDelta(stargazersCount) {
  return Math.max(1, Math.min(Math.floor(stargazersCount / 500) || 1, 5000));
}

async function searchGithubRepos(query, token, excludeNames) {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "15");

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub Search API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = [];
  for (const item of items) {
    const name = item.full_name;
    if (!name || excludeNames.has(name) || item.fork) continue;
    repos.push({
      name,
      url: item.html_url || `https://github.com/${name}`,
      description: item.description || "",
      starsDelta: estimateStarsDelta(item.stargazers_count || 0),
    });
    if (repos.length >= 5) break;
  }
  return repos;
}

async function fillCategoryGaps(buckets, allTrendingRepos, token) {
  const used = new Set();
  for (const category of TRENDING_CATEGORIES) {
    for (const r of buckets[category]) used.add(r.name);
  }

  for (const category of TRENDING_CATEGORIES) {
    if (buckets[category].length >= 3) continue;

    if (token) {
      try {
        const query = CATEGORY_SEARCH_QUERIES[category];
        const found = await searchGithubRepos(query, token, used);
        for (const repo of found) {
          if (buckets[category].length >= 3) break;
          if (used.has(repo.name)) continue;
          buckets[category].push({ ...repo, category });
          used.add(repo.name);
        }
      } catch (err) {
        console.error(`[fetch-github-trending] Search API 补位失败 (${category}): ${err.message}`);
      }
    }

    const pool = allTrendingRepos
      .filter((r) => !used.has(r.name))
      .sort((a, b) => b.starsDelta - a.starsDelta);
    while (buckets[category].length < 3 && pool.length > 0) {
      const repo = pool.shift();
      buckets[category].push({ ...repo, category });
      used.add(repo.name);
    }
  }

  if (!token) {
    const short = TRENDING_CATEGORIES.filter((c) => buckets[c].length < 3);
    if (short.length > 0) {
      console.error(
        `[fetch-github-trending] 部分领域不足 3 条（${short.join(", ")}）；设置 GITHUB_TOKEN 可启用 Search API 补位`,
      );
    }
  }
}

export function buildTrendingResult(repos, date) {
  const buckets = rankReposByCategory(repos);
  return { buckets, date, allTrendingRepos: repos };
}

export async function fetchTrendingItems(opts = {}) {
  const date = yesterdayInShanghai(opts.runDate);
  const html = await fetchTrendingHtml(opts.htmlFile);
  const repos = parseTrendingHtml(html);
  if (repos.length === 0) throw new Error("未能从 Trending 页面解析到仓库");

  const buckets = rankReposByCategory(repos);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  await fillCategoryGaps(buckets, repos, token);

  const items = [];
  for (const category of TRENDING_CATEGORIES) {
    const group = buckets[category].slice(0, 3);
    group.forEach((repo, idx) => {
      items.push({
        category,
        rank: idx + 1,
        name: repo.name,
        url: repo.url,
        starsDelta: repo.starsDelta,
      });
    });
  }

  if (items.length < 9) {
    return {
      error: `仅凑齐 ${items.length} 条有效记录`,
      date,
      items: [],
    };
  }

  return { date, items };
}

async function main() {
  const opts = parseArgs(process.argv);
  try {
    const result = await fetchTrendingItems(opts);
    const json = JSON.stringify(result);
    process.stdout.write(json);
    if (result.error) process.exit(1);
  } catch (err) {
    const date = yesterdayInShanghai(opts.runDate);
    const payload = { error: err.message || String(err), date, items: [] };
    process.stdout.write(JSON.stringify(payload));
    process.exit(1);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
