/**
 * GitHub trending 三领域分类关键词（与 agents/github-trending/AGENTS.md 对齐）
 */

export const TRENDING_CATEGORIES = ["ai", "new_energy", "autonomous_driving"];

export const CATEGORY_LABELS = {
  ai: "AI",
  new_energy: "新能源",
  autonomous_driving: "自动驾驶",
};

/** 领域搜索补位 query（GitHub Search API） */
export const CATEGORY_SEARCH_QUERIES = {
  ai: "machine learning OR llm OR deep-learning OR nlp stars:>500",
  new_energy: "solar OR battery OR energy-management OR photovoltaic stars:>200",
  autonomous_driving: "autonomous OR self-driving OR adas OR openpilot stars:>200",
};

const CATEGORY_KEYWORDS = {
  ai: [
    "ai",
    "llm",
    "gpt",
    "machine learning",
    "deep learning",
    "neural",
    "nlp",
    "computer vision",
    "pytorch",
    "tensorflow",
    "transformer",
    "diffusion",
    "mlops",
    "agent",
    "embedding",
    "rag",
    "huggingface",
    "langchain",
    "openai",
    "大模型",
    "机器学习",
  ],
  new_energy: [
    "solar",
    "photovoltaic",
    "pv",
    "wind",
    "battery",
    "energy",
    "charging",
    "ev",
    "hydrogen",
    "grid",
    "power",
    "储能",
    "光伏",
    "风电",
    "电池",
    "充电桩",
    "新能源",
    "openems",
    "energyplus",
  ],
  autonomous_driving: [
    "autonomous",
    "self-driving",
    "self driving",
    "adas",
    "openpilot",
    "autoware",
    "apollo",
    "perception",
    "lidar",
    "slam",
    "ros2",
    "vehicle",
    "automotive",
    "自动驾驶",
    "车路协同",
    "感知",
    "规划",
    "控制",
  ],
};

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[_/-]/g, " ");
}

function keywordMatches(normalized, kw) {
  const k = kw.toLowerCase();
  if (/^[a-z0-9]+$/.test(k) && k.length <= 3) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(normalized);
  }
  return normalized.includes(k);
}

export function scoreCategory(text, category) {
  const normalized = normalizeText(text);
  const keywords = CATEGORY_KEYWORDS[category] || [];
  let score = 0;
  for (const kw of keywords) {
    if (keywordMatches(normalized, kw)) score += 1;
  }
  return score;
}

export function classifyRepo(name, description = "") {
  const text = `${name} ${description}`;
  let best = null;
  let bestScore = 0;
  for (const category of TRENDING_CATEGORIES) {
    const score = scoreCategory(text, category);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return bestScore > 0 ? best : null;
}

export function rankReposByCategory(repos) {
  const buckets = Object.fromEntries(TRENDING_CATEGORIES.map((c) => [c, []]));
  const used = new Set();

  for (const repo of repos) {
    const category = classifyRepo(repo.name, repo.description);
    if (!category) continue;
    buckets[category].push({ ...repo, category });
  }

  for (const category of TRENDING_CATEGORIES) {
    buckets[category].sort((a, b) => b.starsDelta - a.starsDelta);
    buckets[category] = buckets[category].slice(0, 3);
    for (const r of buckets[category]) used.add(r.name);
  }

  const unassigned = repos
    .filter((r) => !used.has(r.name))
    .sort((a, b) => b.starsDelta - a.starsDelta);

  for (const category of TRENDING_CATEGORIES) {
    while (buckets[category].length < 3 && unassigned.length > 0) {
      const repo = unassigned.shift();
      const scores = TRENDING_CATEGORIES.map((c) => ({
        c,
        s: scoreCategory(`${repo.name} ${repo.description}`, c),
      }));
      scores.sort((a, b) => b.s - a.s);
      const pick = scores[0].s > 0 ? scores[0].c : category;
      if (buckets[pick].length < 3 && !used.has(repo.name)) {
        buckets[pick].push({ ...repo, category: pick });
        used.add(repo.name);
      } else if (buckets[category].length < 3) {
        buckets[category].push({ ...repo, category });
        used.add(repo.name);
      }
    }
  }

  return buckets;
}
