/**
 * Web Search Tool
 * Uses DuckDuckGo (free, no API key) or SerpAPI as fallback.
 * Returns top 5 results with title, snippet, and URL.
 */

const DDG_API = "https://api.duckduckgo.com/";

/**
 * @param {string} query - Search query
 * @returns {Promise<{success: boolean, results: Array, error?: string}>}
 */
async function webSearch(query) {
  if (!query || query.trim().length < 3) {
    return { success: false, error: "Query too short", results: [] };
  }

  try {
    // Try DuckDuckGo Instant Answer API (free, no key)
    const url = `${DDG_API}?q=${encodeURIComponent(query)}&format=json&no_redirect=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // DuckDuckGo returns RelatedTopics for web results
    const results = (data.RelatedTopics || [])
      .filter(r => r.Text && r.FirstURL)
      .slice(0, 5)
      .map(r => ({
        title: r.Text.split(" - ")[0] || r.Text.substring(0, 80),
        snippet: r.Text,
        url: r.FirstURL,
      }));

    if (results.length > 0) {
      return { success: true, results, source: "duckduckgo" };
    }

    // Fallback: try SerpAPI if key is set
    if (process.env.SERPAPI_KEY) {
      return await serpSearch(query);
    }

    return {
      success: true,
      results: [{
        title: query,
        snippet: "Tidak ada hasil ditemukan dari pencarian.",
        url: "",
      }],
      source: "duckduckgo",
    };
  } catch (err) {
    console.error("[WebSearch] Error:", err.message);

    // Try SerpAPI fallback
    if (process.env.SERPAPI_KEY) {
      try {
        return await serpSearch(query);
      } catch {}
    }

    return { success: false, error: err.message, results: [] };
  }
}

async function serpSearch(query) {
  const res = await fetch(
    `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}`,
    { signal: AbortSignal.timeout(10000) }
  );
  const data = await res.json();
  const results = (data.organic_results || []).slice(0, 5).map(r => ({
    title: r.title,
    snippet: r.snippet,
    url: r.link,
  }));
  return { success: true, results, source: "serpapi" };
}

/**
 * Format search results for LLM consumption
 */
function formatForLLM(results, query) {
  if (!results || results.length === 0) {
    return `Tidak ada hasil pencarian untuk "${query}".`;
  }
  const lines = results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.snippet}${r.url ? `\n   Sumber: ${r.url}` : ""}`
  );
  return `Hasil pencarian untuk "${query}":\n\n${lines.join("\n\n")}`;
}

module.exports = { webSearch, formatForLLM };
