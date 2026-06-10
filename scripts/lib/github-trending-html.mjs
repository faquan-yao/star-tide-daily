/**
 * 解析 GitHub Trending daily 页面 HTML
 */

const ARTICLE_RE = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
const REPO_LINK_RE = /<h2[^>]*>[\s\S]*?<a[^>]+href="\/([^/]+)\/([^/"]+)"[^>]*>/i;
const DESC_RE = /<p[^>]*class="[^"]*color-fgb-muted[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
const STARS_TODAY_RE = /([\d,]+)\s+stars?\s+today/i;

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseStarsDelta(block) {
  const m = block.match(STARS_TODAY_RE);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseTrendingHtml(html) {
  const repos = [];
  if (!html || typeof html !== "string") return repos;

  for (const match of html.matchAll(ARTICLE_RE)) {
    const block = match[1];
    const linkMatch = block.match(REPO_LINK_RE);
    if (!linkMatch) continue;

    const owner = linkMatch[1];
    const repo = linkMatch[2];
    const name = `${owner}/${repo}`;
    const starsDelta = parseStarsDelta(block);
    if (!starsDelta) continue;

    const descMatch = block.match(DESC_RE);
    const description = descMatch ? stripHtml(descMatch[1]) : "";

    repos.push({
      name,
      url: `https://github.com/${owner}/${repo}`,
      description,
      starsDelta,
    });
  }

  return repos;
}
