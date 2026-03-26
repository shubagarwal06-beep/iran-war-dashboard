

const INTEL_CACHE_MS = Number(process.env.INTEL_CACHE_MS || 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12_000);
const USER_AGENT = process.env.USER_AGENT || "BASIS-Macro-Dashboard/0.3";
const FORCE_DEMO = /^(1|true)$/i.test(process.env.FORCE_DEMO || "");

const NEWS_QUERIES = (process.env.NEWS_QUERIES || [
  "Iran Strait of Hormuz oil shipping",
  "Iran Hormuz tanker shipping crude",
  "Middle East oil treasury yields"
].join("||")).split("||").map((part) => part.trim()).filter(Boolean);

const NEWSAPI_API_KEY = process.env.NEWSAPI_API_KEY || "";
const NEWSAPI_DOMAINS = (process.env.NEWSAPI_DOMAINS || [
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "cnbc.com",
  "apnews.com",
  "marketwatch.com",
  "nytimes.com",
  "axios.com"
].join(",")).split(",").map((part) => part.trim()).filter(Boolean);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const ARTICLE_FETCH_CONCURRENCY = 3;
const OPENAI_CALL_CONCURRENCY = 2;
const CLASSIFICATION_CACHE_MS = 600_000;
const MIN_CONTEXT_PARAGRAPH_WORDS = 30;

const cache = {
  intel:{ expiresAt:0, payload:null, inflight:null },
  classification:new Map(),
  articleSnapshot:new Map()
};

const PROBABILITY_PRIORS = {
  deescalation:18,
  contained:38,
  escalation:44
};

const ANALYSIS_FORMULA = {
  summary:"Scenario score = prior + sum of live-headline weights + trigger bonuses, then normalized to 100%.",
  steps:[
    "Priors start at 18 de-escalation / 38 contained / 44 escalation so the dashboard does not assume a clean unwind while the conflict is still active.",
    "Each headline adds impact bucket x 10, recency, source quality, fixed-income relevance, and development weight.",
    "Trigger bonuses then adjust the branch: troop deployments, mocked/rejected talks, and fresh strikes lift escalation; selective transit and insurer/backlog stress lift contained; actual ceasefire / reopening / shipping normalization lift de-escalation.",
    "Probabilities shown on the dashboard are the normalized scores after those adjustments."
  ],
  assumptions:[
    "Diplomacy only counts as de-escalatory when the same headline is not also describing rejection, mockery, denial, or a Trump-only negotiating condition.",
    "Shipping friction without a clean reopening maps to contained risk rather than a full unwind.",
    "UK / Europe / Asia local-market reaction headlines are penalized unless they clearly change U.S. rates, oil, or Hormuz conditions."
  ]
};

const CURVE_FORMULA = {
  summary:"The gold curve is a probability-weighted overlay of the three scenario curves on top of the current baseline curve.",
  steps:[
    "Each tenor uses: de-escalation curve x probability + contained curve x probability + escalation curve x probability.",
    "Curve driver cards are selected separately from the top news feed so the projector can prioritize Treasury, inflation, oil-supply, and shipping transmission headlines.",
    "The event timeline orders those rate-relevant drivers by publication time, then links each one to the curve channel it is feeding."
  ],
  assumptions:[
    "Scenario curves are analog-based estimates rather than live Treasury recalibrations.",
    "The weekly change strip in the fullscreen view is a static week-ago Treasury baseline snapshot, separate from the scenario overlay."
  ]
};

const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "smid",
  "cmpid",
  "ocid",
  "ref_src",
  "ref_url",
  "igshid"
]);


async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal:controller.signal,
      headers:{
        "User-Agent":USER_AGENT,
        "Accept":"application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal:controller.signal,
      headers:{
        "User-Agent":USER_AGENT,
        "Accept":"application/rss+xml, application/xml, text/xml, text/plain",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal:controller.signal,
      headers:{
        "User-Agent":USER_AGENT,
        "Accept":"text/html, application/xhtml+xml, application/xml;q=0.9, text/plain;q=0.8",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  return words.length;
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  const drain = () => {
    if (active >= limit || !queue.length) {
      return;
    }
    const next = queue.shift();
    active += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        active -= 1;
        drain();
      });
  };

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

const articleFetchLimiter = createLimiter(ARTICLE_FETCH_CONCURRENCY);
const openAiLimiter = createLimiter(OPENAI_CALL_CONCURRENCY);

function canonicalizeArticleUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    const keys = [...url.searchParams.keys()];
    keys.forEach((key) => {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(normalized)) {
        url.searchParams.delete(key);
      }
    });
    return url.toString();
  } catch {
    return "";
  }
}

function pruneExpiredClassificationCache() {
  const now = Date.now();
  for (const [key, entry] of cache.classification.entries()) {
    if (!entry || entry.expiresAt <= now) {
      cache.classification.delete(key);
    }
  }
}

function getCachedClassification(key) {
  if (!key) {
    return null;
  }
  pruneExpiredClassificationCache();
  const entry = cache.classification.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.value : null;
}

function setCachedClassification(key, value) {
  if (!key) {
    return;
  }
  cache.classification.set(key, {
    value,
    expiresAt:Date.now() + CLASSIFICATION_CACHE_MS
  });
}

function pruneExpiredArticleSnapshotCache() {
  const now = Date.now();
  for (const [key, entry] of cache.articleSnapshot.entries()) {
    if (!entry || entry.expiresAt <= now) {
      cache.articleSnapshot.delete(key);
    }
  }
}

function getCachedArticleSnapshot(key) {
  if (!key) {
    return null;
  }
  pruneExpiredArticleSnapshotCache();
  const entry = cache.articleSnapshot.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.value : null;
}

function setCachedArticleSnapshot(key, value) {
  if (!key) {
    return;
  }
  cache.articleSnapshot.set(key, {
    value,
    expiresAt:Date.now() + CLASSIFICATION_CACHE_MS
  });
}

function encodeNewsQuery(query) {
  return "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function extractSource(block) {
  const match = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  return match ? cleanText(match[1]) : "";
}

function parseRssItems(xmlText) {
  return [...xmlText.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    return {
      title:extractTag(item, "title"),
      link:extractTag(item, "link"),
      pubDate:extractTag(item, "pubDate"),
      source:extractSource(item),
      description:extractTag(item, "description")
    };
  }).filter((item) => item.title);
}

function normalizeArticle(raw) {
  return {
    title:String(raw.title || "").trim(),
    link:String(raw.link || raw.url || "").trim(),
    pubDate:String(raw.pubDate || raw.publishedAt || "").trim(),
    source:String(raw.source || "").trim(),
    description:String(raw.description || raw.content || "").trim()
  };
}

function dedupeArticles(articles) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = article.title.toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const TITLE_SIMILARITY_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "on", "in", "as", "after",
  "over", "more", "than", "from", "into", "its", "his", "her", "their", "this", "that",
  "says", "say", "show", "shows", "showing", "report", "reports", "reported", "amid",
  "update", "updates", "live", "news"
]);

function normalizeTitleForSimilarity(title) {
  return String(title || "")
    .replace(/\s+-\s+[^-]+$/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\bprices?\b/g, "price")
    .replace(/\bnegotiations?\b|\bnegotiating\b|\btalks?\b|\bdiplomatic\b|\bdiplomacy\b/g, "talk")
    .replace(/\bfalls?\b|\bdrops?\b|\btumbles?\b|\bslides?\b|\bslumps?\b/g, "down")
    .replace(/\brises?\b|\bsurges?\b|\bjumps?\b|\bgains?\b/g, "up")
    .replace(/\bships?\b|\bvessels?\b/g, "ship")
    .replace(/\btroops?\b|\bdeployment\b|\bdeploys?\b/g, "troop")
    .replace(/\bmissiles?\b/g, "missile")
    .replace(/\bstrikes?\b/g, "strike")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function eventSignature(articleOrText) {
  const text = normalizeTitleForSimilarity(typeof articleOrText === "string"
    ? articleOrText
    : `${articleOrText && articleOrText.title ? articleOrText.title : ""} ${articleOrText && articleOrText.description ? articleOrText.description : ""}`);
  if (!text) {
    return "";
  }
  if (/(oil|price|crude).*(down|talk).*(iran|trump)|talk.*end war.*oil|eagerness to talk to iran/.test(text)) {
    return "oil-down-on-talks";
  }
  if (/(non hostile ship|ship can sail|ship can transit|ship can cross|strait of hormuz on its terms|allow .* ship)/.test(text)) {
    return "hormuz-passage";
  }
  if (/(negotiating with itself|talk with itself|reject talk|refuse to negotiate|only negotiate with trump|mocks? trump|dismisses ceasefire|pushes back on talks?)/.test(text)) {
    return "rejected-talks";
  }
  if (/(marine|troop|airborne|carrier|warship|destroyer|bomber|pentagon).*(deploy|send|order|head|move)/.test(text)) {
    return "force-deployment";
  }
  if (/(shipping remains thin|traffic far below normal|insurer|premium|escort|convoy|backlog|delays|paused transit|rerouting)/.test(text)) {
    return "shipping-friction";
  }
  return "";
}

function similarityTokens(article) {
  return Array.from(new Set(
    normalizeTitleForSimilarity(article && article.title ? article.title : article)
      .split(" ")
      .filter((token) => token && token.length >= 3 && !TITLE_SIMILARITY_STOPWORDS.has(token) && !/^\d+$/.test(token))
  ));
}

function areSimilarArticles(left, right) {
  const leftSignature = eventSignature(left);
  const rightSignature = eventSignature(right);
  if (leftSignature && leftSignature === rightSignature) {
    return true;
  }
  const leftTokens = similarityTokens(left);
  const rightTokens = similarityTokens(right);
  if (!leftTokens.length || !rightTokens.length) {
    return false;
  }
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token));
  const overlapRatio = overlap.length / Math.min(leftTokens.length, rightTokens.length);
  if (overlap.length >= 4 && overlapRatio >= 0.55) {
    return true;
  }
  if (overlap.length >= 3 && overlapRatio >= 0.72) {
    return true;
  }
  return false;
}

function selectUniqueArticles(articles, limit) {
  const unique = [];
  for (const article of articles) {
    if (unique.some((existing) => areSimilarArticles(article, existing))) {
      continue;
    }
    unique.push(article);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

function extendUniqueArticles(selected, candidates, limit, priorityFn) {
  const result = selected.slice();
  const ranked = candidates.slice().sort((left, right) => priorityFn(right) - priorityFn(left));
  for (const article of ranked) {
    if (result.some((existing) => areSimilarArticles(article, existing))) {
      continue;
    }
    result.push(article);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function createClassificationRequestMemo() {
  return {
    values:new Map(),
    inflight:new Map()
  };
}

function buildHeadlineMemoKey(article) {
  const canonicalUrl = canonicalizeArticleUrl(article && (article.link || article.url));
  if (canonicalUrl) {
    return `url:${canonicalUrl}`;
  }
  const normalizedTitle = normalizeTitleForSimilarity(article && article.title ? article.title : "");
  return normalizedTitle ? `title:${normalizedTitle}` : "";
}

function buildUnclassifiedResult() {
  return {
    scenario:null,
    sentiment:null,
    direction:null,
    classification_status:"unclassified"
  };
}

function normalizedScenarioChipValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw.includes("de-escalation") || raw.includes("deescalation")) {
    return "deescalation";
  }
  if (raw.includes("contained")) {
    return "contained";
  }
  if (raw.includes("full escalation") || raw.includes("escalation")) {
    return "escalation";
  }
  return null;
}

function normalizeDirectionLock(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) {
    return null;
  }
  if (raw.includes("DE-ESCALATORY")) {
    return "DE-ESCALATORY";
  }
  if (raw.includes("ESCALATORY")) {
    return "ESCALATORY";
  }
  return null;
}

function normalizeScenarioFromDirection(value, direction) {
  const scenario = normalizedScenarioChipValue(value);
  if (!scenario || !direction) {
    return null;
  }
  if (direction === "ESCALATORY" && scenario === "deescalation") {
    return null;
  }
  if (direction === "DE-ESCALATORY" && scenario === "escalation") {
    return null;
  }
  return scenario;
}

function directionSentiment(direction) {
  if (direction === "ESCALATORY") {
    return "bearish";
  }
  if (direction === "DE-ESCALATORY") {
    return "bullish";
  }
  return null;
}

function sanitizeArticleHtml(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|figure|picture|video|audio|canvas|iframe|nav|header|footer|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

function isGoogleNewsArticleUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.hostname === "news.google.com" && /\/(?:rss\/)?articles\//.test(url.pathname);
  } catch {
    return false;
  }
}

function decodeGoogleNewsBatchResponse(responseText) {
  const chunks = String(responseText || "").split("\n\n").filter(Boolean);
  for (const chunk of chunks) {
    try {
      const outer = JSON.parse(chunk);
      if (!Array.isArray(outer)) {
        continue;
      }
      for (const item of outer) {
        if (!Array.isArray(item) || typeof item[2] !== "string") {
          continue;
        }
        try {
          const inner = JSON.parse(item[2]);
          if (Array.isArray(inner) && inner[0] === "garturlres" && typeof inner[1] === "string") {
            return inner[1];
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function resolveGoogleNewsSourceUrl(urlValue) {
  const canonicalUrl = canonicalizeArticleUrl(urlValue);
  if (!canonicalUrl || !isGoogleNewsArticleUrl(canonicalUrl)) {
    return canonicalUrl;
  }

  const cachedSnapshot = getCachedArticleSnapshot(canonicalUrl);
  if (cachedSnapshot && cachedSnapshot.resolvedUrl) {
    return cachedSnapshot.resolvedUrl;
  }

  try {
    const parsed = new URL(canonicalUrl);
    const articleId = parsed.pathname.split("/").filter(Boolean).pop();
    if (!articleId) {
      return canonicalUrl;
    }
    const wrapperHtml = await fetchHtml(`https://news.google.com/rss/articles/${articleId}?hl=en-US&gl=US&ceid=US:en`);
    const signature = (wrapperHtml.match(/data-n-a-sg="([^"]+)"/i) || [])[1];
    const timestamp = (wrapperHtml.match(/data-n-a-ts="([^"]+)"/i) || [])[1];
    if (!signature || !timestamp) {
      return canonicalUrl;
    }

    const requestPayload = [
      "Fbv4je",
      `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${articleId}",${timestamp},"${signature}"]`
    ];
    const body = new URLSearchParams({
      "f.req":JSON.stringify([[requestPayload]])
    }).toString();
    const responseText = await fetchText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method:"POST",
      headers:{
        "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8",
        "Accept":"*/*"
      },
      body
    });
    const decodedUrl = canonicalizeArticleUrl(decodeGoogleNewsBatchResponse(responseText));
    return decodedUrl || canonicalUrl;
  } catch {
    return canonicalUrl;
  }
}

function isUsableContextParagraph(paragraph) {
  const normalized = cleanText(paragraph);
  if (wordCount(normalized) < MIN_CONTEXT_PARAGRAPH_WORDS) {
    return false;
  }
  if (/(subscribe|newsletter|sign up|advertisement|continue reading|already a subscriber|share full article|gift article|unlock this article|register now|listen to this article|audio version|live updates are continuing|read more|copyright)/i.test(normalized)) {
    return false;
  }
  return true;
}

function extractLeadParagraphFromHtml(html) {
  const sanitized = sanitizeArticleHtml(html);
  const articleMatch = sanitized.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = articleMatch ? null : sanitized.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const bodyMatch = articleMatch || mainMatch ? null : sanitized.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const scope = articleMatch ? articleMatch[1] : (mainMatch ? mainMatch[1] : (bodyMatch ? bodyMatch[1] : sanitized));
  const paragraphs = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(isUsableContextParagraph);
  return paragraphs[0] || null;
}

function extractArticleTimestampFromHtml(html) {
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return;
    }
    const timestamp = new Date(normalized).getTime();
    if (Number.isFinite(timestamp) && timestamp > 0) {
      candidates.push({ value:normalized, timestamp });
    }
  };

  const patterns = [
    /<meta[^>]+(?:property|name)=["']article:modified_time["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:updated_time["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+itemprop=["']dateModified["'][^>]+content=["']([^"']+)["']/gi,
    /"dateModified"\s*:\s*"([^"]+)"/gi,
    /<meta[^>]+(?:property|name)=["']article:published_time["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/gi,
    /"datePublished"\s*:\s*"([^"]+)"/gi,
    /<time[^>]+datetime=["']([^"']+)["']/gi
  ];

  patterns.forEach((pattern) => {
    for (const match of String(html || "").matchAll(pattern)) {
      pushCandidate(match[1]);
    }
  });

  return candidates.length ? candidates[0].value : null;
}

async function fetchArticleSnapshot(url) {
  const canonicalUrl = canonicalizeArticleUrl(url);
  if (!canonicalUrl) {
    return { context:null, pubDate:null, resolvedUrl:"" };
  }

  const cached = getCachedArticleSnapshot(canonicalUrl);
  if (cached) {
    return cached;
  }

  const fallbackSnapshot = {
    context:null,
    pubDate:null,
    resolvedUrl:canonicalUrl
  };

  try {
    const snapshot = await articleFetchLimiter(async () => {
      const resolvedUrl = await resolveGoogleNewsSourceUrl(canonicalUrl);
      const html = await fetchHtml(resolvedUrl);
      return {
        context:extractLeadParagraphFromHtml(html),
        pubDate:extractArticleTimestampFromHtml(html),
        resolvedUrl:resolvedUrl || canonicalUrl
      };
    });
    const value = {
      context:snapshot.context || null,
      pubDate:snapshot.pubDate || null,
      resolvedUrl:snapshot.resolvedUrl || canonicalUrl
    };
    setCachedArticleSnapshot(canonicalUrl, value);
    return value;
  } catch {
    setCachedArticleSnapshot(canonicalUrl, fallbackSnapshot);
    return fallbackSnapshot;
  }
}

function buildClassifierPrompt(headline, context) {
  const lines = [`Headline: ${headline}`];
  if (context) {
    lines.push(`Context: ${context}`);
  }
  return lines.join("\n");
}

async function callOpenAiPlainText(systemText, userText) {
  const payload = await openAiLimiter(() => fetchJson("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "x-api-key":ANTHROPIC_API_KEY,
      "anthropic-version":"2023-06-01",
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:ANTHROPIC_MODEL,
      max_tokens:32,
      system:systemText,
      messages:[
        {
          role:"user",
          content:userText
        }
      ]
    })
  }));
  const textOut = extractOpenAIText(payload);
  if (!textOut) {
    throw new Error("Anthropic returned no text output");
  }
  return textOut.trim();
}

async function classifyDirectionLock(promptText) {
  return normalizeDirectionLock(await callOpenAiPlainText(
    [
      "You are a headline direction classifier.",
      "Given a headline and optional article context, return only one word: ESCALATORY or DE-ESCALATORY.",
      "Focus exclusively on the action verb and the outcome, not topic nouns.",
      "Iran rejects a ceasefire = ESCALATORY. Talks progress = DE-ESCALATORY.",
      "Do not explain your answer."
    ].join("\n"),
    promptText
  ));
}

async function classifyScenarioBucket(promptText, direction) {
  const allowed = direction === "ESCALATORY"
    ? "contained or escalation"
    : "deescalation or contained";
  return normalizeScenarioFromDirection(await callOpenAiPlainText(
    [
      "You are a scenario-bucket classifier.",
      `The direction is already locked as ${direction}. You must not contradict it.`,
      `Return only one bucket: ${allowed}.`,
      "Use deescalation for genuine easing or reopening, contained for disruption that is still active but not fully spiraling, and escalation for broadening conflict or worsening disruption.",
      "Do not explain your answer."
    ].join("\n"),
    `${promptText}\nConfirmed Direction: ${direction}`
  ), direction);
}

async function classifyHeadline(article, requestMemo) {
  const safeArticle = article || {};
  const title = String(safeArticle.title || "").trim() || "Untitled headline";
  const memo = requestMemo || createClassificationRequestMemo();
  const memoKey = buildHeadlineMemoKey(safeArticle);
  const canonicalUrl = canonicalizeArticleUrl(safeArticle.link || safeArticle.url);

  if (canonicalUrl) {
    const cached = getCachedClassification(canonicalUrl);
    if (cached) {
      return cached;
    }
  } else if (memoKey && memo.values.has(memoKey)) {
    return memo.values.get(memoKey);
  }

  if (memoKey && memo.inflight.has(memoKey)) {
    return memo.inflight.get(memoKey);
  }

  const runner = (async () => {
    let result = buildUnclassifiedResult();
    if (!ANTHROPIC_API_KEY) {
      if (canonicalUrl) {
        setCachedClassification(canonicalUrl, result);
      } else if (memoKey) {
        memo.values.set(memoKey, result);
      }
      return result;
    }

    try {
      const snapshot = canonicalUrl ? await fetchArticleSnapshot(canonicalUrl) : { context:null, pubDate:null, resolvedUrl:canonicalUrl };
      if (snapshot.pubDate) {
        safeArticle.pubDate = snapshot.pubDate;
      }
      if (snapshot.resolvedUrl) {
        safeArticle.link = snapshot.resolvedUrl;
      }
      const promptText = buildClassifierPrompt(title, snapshot.context);
      const direction = await classifyDirectionLock(promptText);
      if (!direction) {
        throw new Error("Could not normalize direction");
      }
      const scenario = await classifyScenarioBucket(promptText, direction);
      if (!scenario) {
        throw new Error("Could not normalize scenario");
      }
      result = {
        scenario,
        sentiment:directionSentiment(direction),
        direction,
        classification_status:null
      };
    } catch {
      const hCtx = analyzeHeadlineContext(safeArticle);
      result = { scenario:hCtx.scenario, sentiment:hCtx.sentiment, direction:null, classification_status:"heuristic" };
    }

    if (canonicalUrl) {
      setCachedClassification(canonicalUrl, result);
    } else if (memoKey) {
      memo.values.set(memoKey, result);
    }
    return result;
  })();

  if (memoKey) {
    memo.inflight.set(memoKey, runner);
  }

  try {
    return await runner;
  } finally {
    if (memoKey) {
      memo.inflight.delete(memoKey);
    }
  }
}

function articleText(articleOrText) {
  if (typeof articleOrText === "string") {
    return articleOrText.toLowerCase();
  }
  return `${articleOrText && articleOrText.title ? articleOrText.title : ""} ${articleOrText && articleOrText.description ? articleOrText.description : ""}`.toLowerCase();
}

function matchAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function articleTimestamp(article) {
  const timestamp = new Date(article && article.pubDate ? article.pubDate : 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function articleAgeHours(article) {
  const timestamp = articleTimestamp(article);
  if (!timestamp) {
    return Infinity;
  }
  return Math.max(0, (Date.now() - timestamp) / 3_600_000);
}

function sourceWeight(source) {
  const text = String(source || "").toLowerCase();
  if (/(reuters|bloomberg|associated press|ap\b|financial times|ft\b|wall street journal|wsj\b|new york times|nytimes\b)/.test(text)) {
    return 6;
  }
  if (/(cnbc|sp global|lloyd|marketwatch|axios|nytimes|new york times)/.test(text)) {
    return 4;
  }
  return 2;
}

function isLiveUpdateHeadline(articleOrText) {
  const text = articleText(articleOrText);
  return /(live updates?|live blog|minute-by-minute|updates\b|developing)/.test(text);
}

function isDirectWarHeadline(article) {
  const text = String(article && article.title ? article.title : "").toLowerCase();
  return /(iran|hormuz|strait|middle east|tehran|israel|pentagon|troops|missile|strike|sanctions|embargo)/.test(text);
}

function developmentWeight(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/(pentagon|deploy|deployment|troops|airborne|strike|attack|missile|retaliat|closure|blockade|blockage|transit|non-hostile ships|allow .*ships|ceasefire|truce|deal|sanctions|embargo|carrier|base|war crimes|evacuat|commodity shock|vital commodity)/.test(text)) {
    score += 10;
  }
  if (/(hormuz|strait|shipping|tanker|escort|convoy|exports|oil falls|oil rises)/.test(text)) {
    score += 4;
  }
  return score;
}

function analysisPenalty(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/(markets wrap|for centuries|terrible .* hedge|why\?|opinion|analysis|explainer|what to know|could be making|history of|scope of war|\bshould\b|which firms will|finally over|what happens next|who wins|what investors need to know)/.test(text)) {
    score += 8;
  }
  return score;
}

function offshoreMacroPenalty(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/(\brba\b|\bbok\b|south korea|petroyuan|\byuan\b|gold .* hedge|currency markets|stocks jump|markets drift|asian shares|european shares|uk stocks|british stocks|ftse|stoxx|dax|nikkei|hang seng|sterling|gilt|boe\b)/.test(text)) {
    score += 10;
  }
  return score;
}

function regionalMarketPenalty(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/(asian shares|european shares|uk stocks|british stocks|ftse|stoxx|dax|nikkei|hang seng|sterling|gilt|boe\b)/.test(text)) {
    score += /(treasury|yield|oil|crude|hormuz|strait|shipping|tanker|iran|middle east)/.test(text) ? 5 : 12;
  }
  return score;
}

function crossAssetReactionPenalty(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/\bgold\b|\bbitcoin\b|\bequities\b|\bstocks?\b|\bshares\b|\bcurrencies\b/.test(text) && !/(oil|crude|treasury|yield|rates|hormuz|strait|shipping|tanker|inflation|fed)/.test(text)) {
    score += 10;
  }
  return score;
}

function regionalMacroExclusion(articleOrText) {
  const text = articleText(articleOrText);
  if (/(u\.k\.| uk |britain|british|sterling|gilt|boe\b|ft adviser|euro zone|ecb\b|asian shares|european shares)/.test(` ${text} `)) {
    return !/(u\.s\. treasury|treasury|fed|oil|crude|hormuz|strait|shipping|tanker)/.test(text);
  }
  return false;
}

function fixedIncomeWeight(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/(treasury|yield|yields|rates|fed|fomc|bond market|curve|term premium|cuts?\b|hikes?\b|inflation|cpi|breakeven)/.test(text)) {
    score += 8;
  }
  if (/(oil|crude|energy|lng|gas field|exports|tanker|shipping|hormuz|strait|sanctions|insurers|convoy|route)/.test(text)) {
    score += 5;
  }
  if (/(attack|strike|missile|closure|blockade|ceasefire|talks?|deal|reopen)/.test(text)) {
    score += 3;
  }
  return score;
}

function recencyWeight(article) {
  const ageHours = articleAgeHours(article);
  if (ageHours <= 2) {
    return 20;
  }
  if (ageHours <= 6) {
    return 16;
  }
  if (ageHours <= 12) {
    return 12;
  }
  if (ageHours <= 24) {
    return 9;
  }
  if (ageHours <= 36) {
    return 6;
  }
  if (ageHours <= 48) {
    return 3;
  }
  if (ageHours <= 72) {
    return 1;
  }
  return -10;
}

function scoreImpact(articleOrText) {
  const text = articleText(articleOrText);
  const fiWeight = fixedIncomeWeight(articleOrText);
  if (fiWeight >= 12 || /(hormuz|strait|closure|blockade|blockage|attack|strike|missile|exports|ceasefire|talks|navy|shipping lane|tanker|treasury yields|yield spike|inflation|marines?|troops?|carrier|pentagon|refuses? to negotiate|only negotiate with trump|vital commodity|commodity shock)/.test(text)) {
    return "high";
  }
  if (fiWeight >= 7 || /(oil|shipping|yield|treasury|sanctions|insurers|escort|convoy|energy|rates|fed)/.test(text)) {
    return "medium";
  }
  return "low";
}

function analyzeHeadlineContext(articleOrText) {
  const text = articleText(articleOrText);
  const positiveDiplomacy = [
    /\bceasefire\b/,
    /\btruce\b/,
    /\bagreement reached\b/,
    /\bdeal reached\b/,
    /\bresume talks?\b/,
    /\breopen(?:ing)?\b/,
    /\bmaritime corridor\b/
  ];
  const tentativeDiplomacy = [
    /\bceasefire plan\b/,
    /\bproposal\b/,
    /\boffers? .*ceasefire\b/,
    /\bdiplomatic push\b/,
    /\bbackchannel\b/,
    /\bchannel\b/,
    /\beagerness to talk\b/,
    /\bpush to end war\b/
  ];
  const negativeDiplomacy = [
    /negotiat(?:ing|ions?) with (?:itself|themselves)/,
    /talks? with itself/,
    /\bsham talks?\b/,
    /\bfake talks?\b/,
    /\bdismiss(?:es|ed)? talks?\b/,
    /\bmocks? (?:trump|talks?|ceasefire)\b/,
    /\brejects? (?:talks?|ceasefire|proposal)\b/,
    /\brejects?.*negotiat/,
    /\brejects?.*talk\b/,
    /\brefus(?:e|es|ed) to negotiat/,
    /\bonly negotiat(?:e|es|ing) with trump\b/,
    /\bwon't negotiate with anyone else but trump\b/,
    /\bwill not negotiat/,
    /\bwon't negotiat/,
    /\bno serious talks?\b/,
    /\bpush(?:es|ed)? back on (?:talks?|ceasefire)\b/,
    /\bdenies? talks?\b/,
    /\brules out talks?\b/
  ];
  const deployment = [
    /\bmarines?\b/,
    /\btroops?\b/,
    /\bairborne\b/,
    /\bcarrier\b/,
    /\bwarship\b/,
    /\bdestroyer\b/,
    /\bbomber\b/,
    /\bpentagon\b.*\b(order|deploy|send|moves?)\b/,
    /\bdeploy(?:ed|ment|s)?\b.*\bmiddle east\b/,
    /\bsent\b.*\bmiddle east\b/
  ];
  const activeConflict = [
    /\battack(?:s|ed|ing)?\b/,
    /\bstrike(?:s|d)?\b/,
    /\bairstrikes?\b/,
    /\bmissile(?:s)?\b/,
    /\bdrone(?:s)?\b/,
    /\bretaliat(?:e|ion|ory)\b/,
    /\bclosure\b/,
    /\bblockade\b/,
    /\bblockage\b/,
    /\bmine(?:s|d)?\b/,
    /\bairstrike\b/,
    /\bregional expansion\b/,
    /\bwiden(?:ing|ed)?\b/,
    /\bvital commodity\b/,
    /\bcommodity shock\b/
  ];
  const shippingStress = [
    /\btraffic far below normal\b/,
    /\bshipping remains thin\b/,
    /\binsurers?\b/,
    /\bescort\b/,
    /\bconvoy\b/,
    /\bbacklog\b/,
    /\bpremiums? elevated\b/,
    /\bpaused transits?\b/,
    /\brerouting\b/,
    /\bqueues?\b/,
    /\bdelays?\b/
  ];
  const shippingRelief = [
    /\bnon-hostile ships?\b/,
    /\bships? can (?:sail|transit|cross)\b/,
    /\ballow(?:s|ed)? .*ships?\b/,
    /\btransits? resume\b/,
    /\bmaritime corridor\b/,
    /\bselective passage\b/,
    /\blimited corridor\b/
  ];
  const oilDown = [/\boil\b.*\b(falls?|drops?|tumbles?|slides?|down)\b/, /\bcrude\b.*\b(falls?|drops?|tumbles?|slides?|down)\b/];
  const oilUp = [/\boil\b.*\b(rises?|surges?|jumps?|spikes?|up)\b/, /\bcrude\b.*\b(rises?|surges?|jumps?|spikes?|up)\b/];
  const ratesLanguage = [/\btreasury\b/, /\byields?\b/, /\brates?\b/, /\binflation\b/, /\bcpi\b/, /\bcurve\b/, /\bfed\b/];

  const hasPositiveDiplomacy = matchAny(text, positiveDiplomacy);
  const hasTentativeDiplomacy = matchAny(text, tentativeDiplomacy);
  const hasNegativeDiplomacy = matchAny(text, negativeDiplomacy);
  const hasDeployment = matchAny(text, deployment);
  const hasActiveConflict = matchAny(text, activeConflict);
  const hasShippingStress = matchAny(text, shippingStress);
  const hasShippingRelief = matchAny(text, shippingRelief);
  const hasOilDown = matchAny(text, oilDown);
  const hasOilUp = matchAny(text, oilUp);
  const hasRatesLanguage = matchAny(text, ratesLanguage);

  const scenarioScores = { deescalation:0, contained:4, escalation:0 };
  const sentimentScores = { bullish:0, bearish:0, neutral:0 };
  const notes = [];

  const addScenario = (scenario, points, note) => {
    scenarioScores[scenario] += points;
    if (note) {
      notes.push(note);
    }
  };
  const addSentiment = (sentiment, points) => {
    sentimentScores[sentiment] += points;
  };

  if (hasDeployment) {
    addScenario("escalation", 18, "fresh force deployment");
    addSentiment("bearish", 14);
  }
  if (hasNegativeDiplomacy) {
    addScenario("escalation", 18, "talks rejected or mocked");
    addSentiment("bearish", 14);
  }
  if (hasActiveConflict) {
    addScenario("escalation", 14, "active military conflict");
    addSentiment("bearish", 10);
  }
  if (hasShippingStress) {
    addScenario("contained", 12, "shipping stress still active");
    addSentiment("bearish", 6);
    addSentiment("neutral", 4);
  }
  if (hasShippingRelief) {
    addScenario("contained", 10, "limited shipping relief");
    addSentiment("neutral", 8);
    if (!hasNegativeDiplomacy && /\breopen|resume|corridor\b/.test(text)) {
      addScenario("deescalation", 6, "shipping relief");
      addSentiment("bullish", 4);
    }
  }
  if (hasPositiveDiplomacy && !hasNegativeDiplomacy) {
    addScenario("deescalation", 15, "active diplomacy without rejection");
    addSentiment("bullish", 11);
  }
  if (hasTentativeDiplomacy && !hasNegativeDiplomacy) {
    addScenario("contained", 8, "tentative diplomacy without breakthrough");
    addSentiment("neutral", 6);
    addScenario("deescalation", 4, "tentative diplomacy");
  }
  if (hasOilDown && hasPositiveDiplomacy && !hasNegativeDiplomacy) {
    addScenario("deescalation", 6, "oil falls on easing headlines");
    addSentiment("bullish", 8);
  }
  if (hasOilDown && hasTentativeDiplomacy && !hasNegativeDiplomacy) {
    addScenario("contained", 6, "oil falls on tentative diplomacy");
    addSentiment("neutral", 4);
  }
  if (hasOilUp && (hasActiveConflict || hasShippingStress || hasDeployment)) {
    addScenario("escalation", 6, "oil up on disruption");
    addSentiment("bearish", 8);
  }
  if ((hasPositiveDiplomacy || hasShippingRelief) && (hasNegativeDiplomacy || hasDeployment || hasActiveConflict)) {
    addScenario("contained", 8, "mixed easing and conflict signals");
    addSentiment("neutral", 5);
  }
  if (/\bno agreement yet\b|\bstill under review\b|\bnot yet full\b|\bremain elevated\b/.test(text)) {
    addScenario("contained", 8, "no clean resolution yet");
    addSentiment("neutral", 6);
  }
  if (hasRatesLanguage && (hasDeployment || hasActiveConflict || hasShippingStress)) {
    addSentiment("bearish", 4);
  }

  let scenario = "contained";
  if (scenarioScores.escalation >= scenarioScores.deescalation && scenarioScores.escalation >= scenarioScores.contained) {
    scenario = "escalation";
  } else if (scenarioScores.deescalation > scenarioScores.contained) {
    scenario = "deescalation";
  }

  let sentiment = "neutral";
  if (sentimentScores.bearish >= sentimentScores.bullish + 3) {
    sentiment = "bearish";
  } else if (sentimentScores.bullish >= sentimentScores.bearish + 3) {
    sentiment = "bullish";
  } else if (scenario === "escalation") {
    sentiment = "bearish";
  } else if (scenario === "deescalation") {
    sentiment = "bullish";
  }

  return {
    scenario,
    sentiment,
    scenarioScores,
    sentimentScores,
    notes
  };
}

function classifyScenario(articleOrText) {
  return analyzeHeadlineContext(articleOrText).scenario;
}

function classifySentiment(articleOrText, scenario) {
  const context = analyzeHeadlineContext(articleOrText);
  if (scenario && context.scenario !== scenario && scenario === "escalation" && context.sentiment === "neutral") {
    return "bearish";
  }
  return context.sentiment;
}

function impactScore(level) {
  return level === "high" ? 3 : (level === "medium" ? 2 : 1);
}

function tenorFocus(article, scenario) {
  const text = articleText(article);
  if (/(fed|cuts?\b|hikes?\b|cpi|inflation|breakeven|front-end|short-end|policy)/.test(text)) {
    return "2Y-5Y";
  }
  if (/(hormuz|shipping|tanker|oil|crude|exports|sanctions|energy)/.test(text)) {
    return scenario === "deescalation" ? "2Y-7Y" : "5Y-10Y";
  }
  if (/(term premium|long end|30-year|20-year|fiscal|supply)/.test(text)) {
    return "10Y-30Y";
  }
  return scenario === "escalation" ? "5Y-10Y" : "2Y-10Y";
}

function fixedIncomeChannel(article, scenario) {
  const text = articleText(article);
  if (scenario === "deescalation") {
    if (/(reopen|ceasefire|talks?|deal|resume)/.test(text)) {
      return "Eases oil and shipping risk, supporting lower front-end yields and flatter curve pricing.";
    }
    return "Improves macro risk sentiment and softens inflation pressure feeding the Treasury curve.";
  }
  if (scenario === "escalation") {
    if (/(attack|strike|missile|closure|blockade|drone)/.test(text)) {
      return "Adds inflation-shock and supply-disruption pressure, biasing the curve toward bear steepening.";
    }
    return "Raises the odds of an energy-driven inflation repricing and higher rate volatility.";
  }
  if (/(insurers|convoy|escort|traffic|shipping|passage)/.test(text)) {
    return "Keeps disruption risk alive, reinforcing higher-for-longer pricing through the belly and 10Y sector.";
  }
  return "Supports a contained-risk, higher-for-longer rates backdrop rather than a full unwind.";
}

function curveEffectLabel(article, scenario) {
  const text = articleText(article);
  if (scenario === "deescalation") {
    return "Bull flattening pressure";
  }
  if (scenario === "escalation") {
    return /(yield|treasury|fed|inflation|cpi)/.test(text) ? "Bear steepening pressure" : "Inflation shock steepening";
  }
  return /(shipping|oil|crude|insurers)/.test(text) ? "Higher-for-longer steepening" : "Mild bearish repricing";
}

function curveRelevance(articleOrText) {
  const text = articleText(articleOrText);
  let score = 0;
  if (/(treasury|yield|yields|rates|bond market|curve|fed|fomc|inflation|cpi|term premium|breakeven|duration)/.test(text)) {
    score += 10;
  }
  if (/(oil|crude|energy|shipping|hormuz|strait|tanker|exports|insurers|supply shock)/.test(text)) {
    score += 6;
  }
  if (/(attack|strike|missile|closure|blockade|ceasefire|talks|deal|reopen)/.test(text)) {
    score += 3;
  }
  return score;
}

function headlineFeedPriority(article) {
  const scenario = classifyScenario(article);
  return recencyWeight(article) * 3
    + sourceWeight(article.source) * 3
    + fixedIncomeWeight(article)
    + developmentWeight(article) * 3
    + (isDirectWarHeadline(article) ? 6 : 0)
    + (scenario === "escalation" ? 8 : 0)
    + (isLiveUpdateHeadline(article) ? 4 : 0)
    - analysisPenalty(article)
    - crossAssetReactionPenalty(article)
    - regionalMarketPenalty(article)
    - Math.round(offshoreMacroPenalty(article) / 2);
}

function curveArticlePriority(article) {
  return recencyWeight(article) * 2
    + sourceWeight(article.source) * 3
    + curveRelevance(article) * 2
    + developmentWeight(article)
    + impactScore(scoreImpact(article)) * 6
    - Math.round(analysisPenalty(article) / 2)
    - crossAssetReactionPenalty(article)
    - regionalMarketPenalty(article)
    - offshoreMacroPenalty(article);
}

function selectTopArticles(articles, limit, priorityFn, windows) {
  const ranked = articles.slice().sort((left, right) => priorityFn(right) - priorityFn(left));
  const preferred = ranked.filter((article) => sourceWeight(article.source) >= 4);
  for (const pool of [preferred, ranked]) {
    for (const hours of windows) {
      const fresh = selectUniqueArticles(pool.filter((article) => articleAgeHours(article) <= hours), limit);
      if (fresh.length >= limit) {
        return fresh.slice(0, limit);
      }
    }
  }
  return selectUniqueArticles(preferred.length >= limit ? preferred : ranked, limit).slice(0, limit);
}

function articlePriority(article) {
  const impact = scoreImpact(article);
  const scenario = classifyScenario(article);
  return impactScore(impact) * 9
    + recencyWeight(article)
    + fixedIncomeWeight(article)
    + sourceWeight(article.source)
    + (scenario === "escalation" ? 6 : 0)
    - crossAssetReactionPenalty(article)
    - regionalMarketPenalty(article)
    - Math.round(offshoreMacroPenalty(article) / 2);
}

function filterRelevantArticles(articles) {
  const ranked = dedupeArticles(articles)
    .filter((article) => /iran|hormuz|oil|tanker|shipping|treasury|yield|crude|middle east|fed|inflation|bond/i.test(`${article.title || ""} ${article.description || ""}`))
    .filter((article) => !/(\brba\b|\bbok\b|south korea|petroyuan|\byuan\b|gold .* hedge|currency markets|stocks jump|markets drift)/.test(articleText(article)))
    .filter((article) => !regionalMacroExclusion(article))
    .filter((article) => crossAssetReactionPenalty(article) < 10 || /oil|crude|treasury|yield|rates|hormuz|strait|shipping|tanker|inflation|fed/i.test(articleText(article)))
    .filter((article) => regionalMarketPenalty(article) < 12 || /treasury|yield|oil|crude|hormuz|strait|shipping|tanker|iran|middle east/i.test(articleText(article)))
    .filter((article) => articleAgeHours(article) <= 168 || !article.pubDate)
    .sort((left, right) => articlePriority(right) - articlePriority(left));

  const preferred = ranked.filter((article) => sourceWeight(article.source) >= 4);
  for (const pool of [preferred, ranked]) {
    for (const hours of [6, 12, 24, 36, 48, 72]) {
      const fresh = pool.filter((article) => articleAgeHours(article) <= hours);
      if (fresh.length >= 5) {
        return fresh;
      }
    }
  }

  return preferred.length >= 5 ? preferred : ranked;
}

function normalizeProbabilities(raw) {
  const numbers = {
    deescalation:Math.max(0, Number(raw.deescalation || 0)),
    contained:Math.max(0, Number(raw.contained || 0)),
    escalation:Math.max(0, Number(raw.escalation || 0))
  };
  const sum = numbers.deescalation + numbers.contained + numbers.escalation;
  if (!sum) {
    return { deescalation:25, contained:50, escalation:25 };
  }
  const normalized = {
    deescalation:Math.round(numbers.deescalation / sum * 100),
    contained:Math.round(numbers.contained / sum * 100),
    escalation:Math.round(numbers.escalation / sum * 100)
  };
  const diff = 100 - (normalized.deescalation + normalized.contained + normalized.escalation);
  if (diff !== 0) {
    const largest = Object.entries(normalized).sort((a, b) => b[1] - a[1])[0][0];
    normalized[largest] += diff;
  }
  return normalized;
}

function formatRelativeTime(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 48) {
    return `${diffHours}h ago`;
  }
  return date.toLocaleDateString("en-US", {
    month:"short",
    day:"numeric"
  });
}

function sourceMatches(left, right) {
  const leftText = String(left || "").trim().toLowerCase();
  const rightText = String(right || "").trim().toLowerCase();
  if (!leftText || !rightText) {
    return false;
  }
  return leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText);
}

function findFallbackArticleForHeadline(headline, source, fallbackArticles) {
  const safeTitle = String(headline || "").trim();
  if (!safeTitle) {
    return null;
  }

  const exact = fallbackArticles.find((article) => String(article.title || "").trim().toLowerCase() === safeTitle.toLowerCase());
  if (exact) {
    return exact;
  }

  const preferredPool = fallbackArticles.filter((article) => sourceMatches(source, article.source));
  const pool = preferredPool.length ? preferredPool : fallbackArticles;
  const probe = { title:safeTitle, description:"" };

  const signatureMatch = pool.find((article) => {
    const articleSignature = eventSignature(article);
    const probeSignature = eventSignature(probe);
    return probeSignature && articleSignature && probeSignature === articleSignature;
  });
  if (signatureMatch) {
    return signatureMatch;
  }

  return pool.find((article) => areSimilarArticles(probe, article)) || null;
}

function buildDriver(entry) {
  return {
    title:entry.article.title,
    source:entry.article.source || "Unknown source",
    time:entry.article.pubDate ? formatRelativeTime(entry.article.pubDate) : "",
    url:entry.article.link || "",
    scenario:entry.scenario,
    impact:entry.impact,
    weight:Math.max(1, Math.round(entry.weight)),
    rationale:entry.channel
  };
}

function buildTimelineEvent(entry) {
  return {
    title:entry.article.title,
    source:entry.article.source || "Unknown source",
    time:entry.article.pubDate ? formatRelativeTime(entry.article.pubDate) : "",
    url:entry.article.link || "",
    scenario:entry.scenario,
    impact:entry.impact,
    curve_effect:entry.curveEffect,
    tenor_focus:entry.tenorFocus
  };
}

function scenarioDriverSummary(scenario, drivers, probability) {
  if (!drivers.length) {
    return `No fresh ${scenario} drivers are currently strong enough to shift this branch materially.`;
  }
  if (scenario === "deescalation") {
    return `${probability}% reflects actual easing signals such as diplomacy that is not being rejected, cleaner shipping passage, or a credible reopening of flows.`;
  }
  if (scenario === "escalation") {
    return `${probability}% reflects live headlines pointing to deployments, rejected talks, strikes, or broader supply disruption that would push inflation and rate volatility higher.`;
  }
  return `${probability}% reflects headlines showing disruption is still active, passage is still constrained, or diplomacy is too partial to justify a clean de-escalation call.`;
}

async function deriveIntelFromArticles(articles, requestMemo = createClassificationRequestMemo()) {
  const rankedArticles = articles.slice(0, 20);
  const cleanPool = rankedArticles.filter((article) => analysisPenalty(article) < 8);
  const directCleanPool = cleanPool.filter(isDirectWarHeadline);
  const feedPool = cleanPool.filter((article) => developmentWeight(article) >= 8 || isLiveUpdateHeadline(article));
  const headlineBase = feedPool.length ? feedPool : (directCleanPool.length ? directCleanPool : cleanPool);
  let headlineArticles = selectTopArticles(headlineBase, 5, headlineFeedPriority, [1, 3, 6, 12, 18, 24, 36]);
  if (headlineArticles.length < 5) {
    headlineArticles = extendUniqueArticles(headlineArticles, directCleanPool, 5, headlineFeedPriority);
  }
  if (headlineArticles.length < 5) {
    headlineArticles = extendUniqueArticles(headlineArticles, cleanPool, 5, headlineFeedPriority);
  }
  if (headlineArticles.length < 5) {
    headlineArticles = extendUniqueArticles(headlineArticles, rankedArticles, 5, headlineFeedPriority);
  }

  const probabilityPool = cleanPool.filter((article) => regionalMarketPenalty(article) < 10);
  const probabilityArticles = selectTopArticles(probabilityPool.length ? probabilityPool : rankedArticles, 8, articlePriority, [1, 3, 6, 12, 18, 24, 36]);

  const curvePool = cleanPool
    .filter((article) => curveRelevance(article) >= 8 || developmentWeight(article) >= 8 || fixedIncomeWeight(article) >= 7);
  const curveFallbackPool = cleanPool.filter((article) => curveRelevance(article) >= 5 || developmentWeight(article) >= 4 || fixedIncomeWeight(article) >= 5);
  const curveBase = curvePool.length ? curvePool : (curveFallbackPool.length ? curveFallbackPool : cleanPool);
  let curveArticles = selectTopArticles(curveBase, 6, curveArticlePriority, [1, 3, 6, 12, 24, 36]);
  if (curveArticles.length < 4) {
    curveArticles = extendUniqueArticles(curveArticles, cleanPool, 4, curveArticlePriority);
  }

  const classificationPool = dedupeArticles([
    ...headlineArticles,
    ...probabilityArticles,
    ...curveArticles
  ]);
  const enriched = await Promise.all(classificationPool.map(async (article) => {
    const classification = await classifyHeadline(article, requestMemo);
    const scenario = classification.scenario;
    const impact = scoreImpact(article);
    return {
      article,
      scenario,
      sentiment:classification.sentiment,
      classification_status:classification.classification_status || null,
      impact,
      weight:scenario ? impactScore(impact) * 10 + recencyWeight(article) + fixedIncomeWeight(article) + sourceWeight(article.source) + developmentWeight(article) : 0,
      priority:articlePriority(article),
      channel:scenario ? fixedIncomeChannel(article, scenario) : "",
      curveEffect:scenario ? curveEffectLabel(article, scenario) : "",
      tenorFocus:scenario ? tenorFocus(article, scenario) : "",
      ageHours:articleAgeHours(article)
    };
  }));
  const entryByTitle = new Map(enriched.map((entry) => [entry.article.title, entry]));
  const pickEntry = (article) => entryByTitle.get(article.title) || null;

  const headlineEntries = headlineArticles.slice(0, 5).map(pickEntry).filter(Boolean);
  const probabilityEntries = probabilityArticles.map(pickEntry).filter((entry) => entry && entry.scenario);
  const curveEntries = curveArticles.map(pickEntry).filter((entry) => entry && entry.scenario);

  const scores = { ...PROBABILITY_PRIORS };
  probabilityEntries.forEach((entry) => {
    scores[entry.scenario] += entry.weight;
    const text = articleText(entry.article);
    if (entry.scenario === "contained" && /(shipping|insurers|escort|convoy|traffic|passage|backlog|queues?)/.test(text)) {
      scores.contained += 8;
    }
    if (entry.scenario === "escalation" && /(attack|strike|missile|closure|blockade|drone|retaliat|marines?|troops?|carrier|pentagon|refus(?:e|es|ed) to negotiat|only negotiate with trump|mocks? trump|negotiating with itself)/.test(text)) {
      scores.escalation += /(marines?|troops?|carrier|pentagon|refus(?:e|es|ed) to negotiat|only negotiate with trump|mocks? trump|negotiating with itself)/.test(text) ? 12 : 10;
    }
    if (entry.scenario === "deescalation" && /(ceasefire|deal|agreement|resume|reopen|corridor|ships? can (?:sail|transit|cross))/.test(text) && !/(reject|refus|mock|itself|only negotiate with trump|pushes back)/.test(text)) {
      scores.deescalation += 10;
    }
  });

  const probabilities = normalizeProbabilities(scores);
  const headlines = headlineEntries.map((entry) => ({
    title:entry.article.title,
    source:entry.article.source || "Unknown source",
    time:entry.article.pubDate ? formatRelativeTime(entry.article.pubDate) : "",
    sentiment:entry.sentiment,
    scenario:entry.scenario,
    impact:entry.impact,
    url:entry.article.link || "",
    ...(entry.classification_status ? { classification_status:entry.classification_status } : {})
  }));
  const keyHeadline = headlineEntries[0];

  let shipsPerDay = 5;
  let pctNormal = 3.8;
  let backlog = "Recent reports point to severely reduced traffic and convoy constraints rather than a clean live vessel count.";
  let severity = "critical";
  let rangeText = "2-7";

  if (probabilities.deescalation >= 40) {
    shipsPerDay = 48;
    pctNormal = 36.9;
    backlog = "Recent reports suggest partial normalization, but traffic is still uneven and below pre-war flow.";
    severity = "watch";
    rangeText = "35-50";
  } else if (probabilities.escalation >= 35) {
    shipsPerDay = 2;
    pctNormal = 1.5;
    backlog = "Recent reports show extreme disruption, paused transits, and tighter insurance or escort conditions.";
    severity = "critical";
    rangeText = "2-7";
  }

  const probabilityDrivers = probabilityEntries.slice(0, 5).map(buildDriver);
  const scenarioDrivers = {
    deescalation:{
      summary:scenarioDriverSummary("deescalation", probabilityEntries.filter((entry) => entry.scenario === "deescalation"), probabilities.deescalation),
      drivers:probabilityEntries.filter((entry) => entry.scenario === "deescalation").slice(0, 3).map(buildDriver)
    },
    contained:{
      summary:scenarioDriverSummary("contained", probabilityEntries.filter((entry) => entry.scenario === "contained"), probabilities.contained),
      drivers:probabilityEntries.filter((entry) => entry.scenario === "contained").slice(0, 3).map(buildDriver)
    },
    escalation:{
      summary:scenarioDriverSummary("escalation", probabilityEntries.filter((entry) => entry.scenario === "escalation"), probabilities.escalation),
      drivers:probabilityEntries.filter((entry) => entry.scenario === "escalation").slice(0, 3).map(buildDriver)
    }
  };
  const curveDrivers = curveEntries.slice(0, 4).map(buildDriver);
  const curveTimeline = curveEntries
    .slice()
    .sort((left, right) => articleTimestamp(left.article) - articleTimestamp(right.article))
    .map(buildTimelineEvent);
  const maxHeadlineAge = headlineEntries.length
    ? Math.max(...headlineEntries.map((entry) => entry.ageHours))
    : Infinity;
  const freshnessNote = maxHeadlineAge <= 24
    ? "Showing the highest-impact U.S. rates / oil / Hormuz headlines from roughly the last 24 hours."
    : "Fresh coverage is thinner, so the ranking expands beyond the last day to keep five distinct market-moving stories on screen.";

  return {
    headlines,
    probabilities,
    key_development:keyHeadline ? `${keyHeadline.article.source || "News"}: ${keyHeadline.article.title}` : "No fresh headlines found. Using fallback assumptions.",
    oil_bias:probabilities.deescalation >= 40 ? "down" : ((probabilities.escalation >= 20 || probabilities.contained >= 55) ? "up" : "flat"),
    rates_bias:probabilities.deescalation >= 35 ? "lower" : ((probabilities.escalation >= 25 || probabilities.contained >= 65) ? "higher" : "flat"),
    hormuz_status:{
      ships_per_day:shipsPerDay,
      pct_normal:pctNormal,
      backlog,
      severity,
      range_text:rangeText,
      source_text:"Recent reports: AP Mar 24 · USNI/JMIC Mar 10"
    },
    probability_drivers:probabilityDrivers,
    scenario_drivers:scenarioDrivers,
    curve_drivers:curveDrivers,
    curve_timeline:curveTimeline,
    analysis_method:"Probabilities are driven by the most market-moving headlines from the last 24 hours, with extra weight on rejected diplomacy, force deployments, Hormuz shipping stress, oil-supply disruption, Treasury/rates language, and source quality.",
    curve_method:"Yield-curve annotations are selected separately from the top feed so the projector can prioritize Treasury/yield language, inflation transmission, oil disruption, and shipping stress over generic war coverage.",
    analysis_formula:ANALYSIS_FORMULA,
    curve_formula:CURVE_FORMULA,
    freshness_note:freshnessNote
  };
}

function parseJsonBlock(textValue) {
  const cleaned = String(textValue || "").replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in model response");
  }
  return JSON.parse(match[0]);
}

function extractOpenAIText(payload) {
  const parts = [];
  const content = Array.isArray(payload.content) ? payload.content : [];
  content.forEach((block) => {
    if (typeof block.text === "string") {
      parts.push(block.text);
    }
  });
  return parts.join("\n").trim();
}

async function normalizeHeadlinesFromModel(rawHeadlines, fallbackArticles, requestMemo) {
  const candidates = (Array.isArray(rawHeadlines) ? rawHeadlines : []).slice(0, 5).map((headline) => {
    const fallback = findFallbackArticleForHeadline(headline.title, headline.source, fallbackArticles) || {};
    return {
      title:String(headline.title || fallback.title || "Untitled headline"),
      source:String(headline.source || fallback.source || "Unknown source"),
      time:String(fallback.pubDate ? formatRelativeTime(fallback.pubDate) : (headline.time || "")),
      impact:["high", "medium", "low"].includes(headline.impact) ? headline.impact : scoreImpact(String(headline.title || fallback.title || "")),
      url:String(headline.url || fallback.link || ""),
      description:String(fallback.description || "")
    };
  });
  const classifications = await Promise.all(candidates.map((candidate) => classifyHeadline({
    title:candidate.title,
    source:candidate.source,
    link:candidate.url,
    description:candidate.description
  }, requestMemo)));
  return candidates.map((candidate, index) => {
    const classification = classifications[index];
    return {
      title:candidate.title,
      source:candidate.source,
      time:candidate.time,
      sentiment:classification.sentiment,
      scenario:classification.scenario,
      impact:candidate.impact,
      url:candidate.url,
      ...(classification.classification_status ? { classification_status:classification.classification_status } : {})
    };
  });
}

async function normalizeIntelPayload(raw, articles, source, requestMemo = createClassificationRequestMemo()) {
  const derived = await deriveIntelFromArticles(articles, requestMemo);
  const headlines = await normalizeHeadlinesFromModel(raw.headlines, articles, requestMemo);
  const probabilities = normalizeProbabilities(derived.probabilities);
  const hormuz = raw.hormuz_status || {};
  return {
    mode:"live",
    source,
    scannedAt:new Date().toISOString(),
    ...derived,
    headlines:headlines.length ? headlines : derived.headlines,
    probabilities,
    key_development:String(raw.key_development || raw.summary || derived.key_development),
    oil_bias:String(raw.oil_bias || derived.oil_bias),
    rates_bias:String(raw.rates_bias || derived.rates_bias),
    hormuz_status:{
      ships_per_day:Number(hormuz.ships_per_day ?? derived.hormuz_status.ships_per_day ?? 5),
      pct_normal:Math.min(100, Math.max(0, Number(hormuz.pct_normal ?? derived.hormuz_status.pct_normal ?? 3.8))),
      backlog:String(hormuz.backlog || derived.hormuz_status.backlog || "Recent reports point to severely reduced traffic and convoy constraints rather than a clean live vessel count."),
      severity:String(hormuz.severity || derived.hormuz_status.severity || "critical"),
      range_text:String(hormuz.range_text || derived.hormuz_status.range_text || "2-7"),
      source_text:String(hormuz.source_text || derived.hormuz_status.source_text || "Recent reports: AP Mar 24 · USNI/JMIC Mar 10")
    }
  };
}

async function fetchNewsApiArticles() {
  if (!NEWSAPI_API_KEY) {
    return [];
  }
  const windows = [6, 12, 24];
  let fallback = [];
  for (const hours of windows) {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", '(Iran OR "Strait of Hormuz" OR Hormuz OR "Middle East") AND (live OR updates OR troops OR Pentagon OR missiles OR strike OR attack OR sanctions OR embargo OR oil OR tanker OR shipping OR crude OR treasury OR yields OR rates OR inflation OR bonds)');
    url.searchParams.set("searchIn", "title,description");
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("from", new Date(Date.now() - hours * 3_600_000).toISOString());
    if (NEWSAPI_DOMAINS.length) {
      url.searchParams.set("domains", NEWSAPI_DOMAINS.join(","));
    }
    const payload = await fetchJson(url.toString(), {
      headers:{ "X-Api-Key":NEWSAPI_API_KEY }
    });
    if (payload.status !== "ok") {
      throw new Error(payload.message || "NewsAPI request failed");
    }
    const filtered = filterRelevantArticles((payload.articles || []).map((article) => normalizeArticle({
      title:article.title,
      link:article.url,
      pubDate:article.publishedAt,
      source:article.source && article.source.name ? article.source.name : "",
      description:article.description
    })));
    if (filtered.length >= 5) {
      return filtered;
    }
    if (!fallback.length && filtered.length) {
      fallback = filtered;
    }
  }
  return fallback;
}

async function fetchGoogleNewsArticles() {
  const liveQueries = [
    '"Iran war" "live updates" when:1d',
    '"Middle East war" "live updates" when:1d',
    '"Strait of Hormuz" (shipping OR tanker OR oil) when:1d',
    '(Iran OR "Middle East") (troops OR marines OR Pentagon OR missiles OR strike OR sanctions) when:1d',
    '(Iran OR Hormuz) ("refuses talks" OR "rejects ceasefire" OR "only negotiate with Trump" OR "negotiating with itself") when:1d',
    '(Iran OR Hormuz) (treasury OR yields OR rates OR inflation OR bonds) when:1d',
    '(Iran OR Hormuz) (oil OR crude OR shipping OR tanker) when:1d'
  ];
  const queries = Array.from(new Set([...liveQueries, ...NEWS_QUERIES]));
  const feeds = await Promise.all(queries.map(async (query) => {
    const xml = await fetchText(encodeNewsQuery(query));
    return parseRssItems(xml);
  }));
  return filterRelevantArticles(feeds.flat().map(normalizeArticle));
}

async function fetchOpenAiSummary(articles, articleSource, requestMemo) {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }

  const articleBlock = articles.slice(0, 12).map((article, index) => {
    return [
      `#${index + 1}`,
      `title: ${article.title}`,
      `source: ${article.source || "Unknown source"}`,
      `published_at: ${article.pubDate || "unknown"}`,
      `url: ${article.link || ""}`,
      `description: ${article.description || ""}`
    ].join("\n");
  }).join("\n\n");

  const payload = await openAiLimiter(() => fetchJson("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "x-api-key":ANTHROPIC_API_KEY,
      "anthropic-version":"2023-06-01",
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:ANTHROPIC_MODEL,
      max_tokens:2048,
      system:[
        "You are a macro geopolitical analyst producing a strictly JSON response.",
        "Use the supplied article set as the primary corpus.",
        "Return exactly this shape:",
        "{",
        '  "headlines":[{"title":"","source":"","time":"","sentiment":"bullish|bearish|neutral","scenario":"deescalation|contained|escalation","impact":"high|medium|low","url":""}],',
        '  "probabilities":{"deescalation":0,"contained":0,"escalation":0},',
        '  "key_development":"",',
        '  "oil_bias":"up|down|flat",',
        '  "rates_bias":"higher|lower|flat",',
        '  "hormuz_status":{"ships_per_day":0,"pct_normal":0,"backlog":"","severity":"open|watch|critical"}',
        "}",
        "Choose exactly 5 headlines.",
        "Probabilities must sum to 100.",
        "If shipping data is uncertain, be conservative and say so in backlog text rather than inventing precision."
      ].join("\n"),
      messages:[
        {
          role:"user",
          content:[
            {
              type:"text",
              text:[
                `Current date: ${new Date().toISOString()}`,
                `News source layer: ${articleSource}`,
                "",
                "Candidate articles:",
                articleBlock
              ].join("\n")
            }
          ]
        }
      ]
    })
  }));
  const textOut = extractOpenAIText(payload);
  if (!textOut) {
    throw new Error("Anthropic returned no text output");
  }
  return normalizeIntelPayload(parseJsonBlock(textOut), articles, `${articleSource}+anthropic`, requestMemo);
}

async function demoIntel(reason, requestMemo = createClassificationRequestMemo()) {
  const now = Date.now();
  const articles = [
    {
      title:"Reuters: Tanker insurers keep premiums elevated as Hormuz traffic stays thin",
      source:"Reuters",
      pubDate:new Date(now - 8 * 60_000).toISOString(),
      link:"",
      description:"Shipping conditions remain tight and energy disruption risk keeps rates markets alert."
    },
    {
      title:"Officials discuss limited maritime corridor while escorts remain under review",
      source:"Bloomberg",
      pubDate:new Date(now - 19 * 60_000).toISOString(),
      link:"",
      description:"Selective passage helps avoid full closure but leaves supply-chain risk in place."
    },
    {
      title:"Brent time spreads firm as traders price prolonged disruption risk",
      source:"WSJ",
      pubDate:new Date(now - 27 * 60_000).toISOString(),
      link:"",
      description:"Oil reprices higher as the market reassesses inflation and duration risk."
    },
    {
      title:"Backchannel talks continue, but no agreement yet on full reopening",
      source:"FT",
      pubDate:new Date(now - 38 * 60_000).toISOString(),
      link:"",
      description:"Diplomatic contact is active, though no ceasefire or clear shipping reset is in place."
    },
    {
      title:"Shipping trackers show selective transits, still far below normal volumes",
      source:"Lloyd's List",
      pubDate:new Date(now - 52 * 60_000).toISOString(),
      link:"",
      description:"Traffic remains impaired enough to keep the fixed-income inflation backdrop unstable."
    }
  ];
  return {
    mode:"demo",
    source:"demo-generator",
    reason,
    scannedAt:new Date().toISOString(),
    ...(await deriveIntelFromArticles(articles, requestMemo))
  };
}

async function buildIntelPayload() {
  const requestMemo = createClassificationRequestMemo();
  if (FORCE_DEMO) {
    return demoIntel("FORCE_DEMO enabled", requestMemo);
  }

  const errors = [];
  const sourceLayers = [];
  const articlePool = [];

  try {
    if (NEWSAPI_API_KEY) {
      const newsApiArticles = await fetchNewsApiArticles();
      if (newsApiArticles.length) {
        sourceLayers.push("newsapi");
        articlePool.push(...newsApiArticles);
      }
    }
  } catch (error) {
    errors.push("newsapi: " + error.message);
  }

  try {
    const googleArticles = await fetchGoogleNewsArticles();
    if (googleArticles.length) {
      sourceLayers.push("google-news-rss");
      articlePool.push(...googleArticles);
    }
  } catch (error) {
    errors.push("google-news-rss: " + error.message);
  }

  const articles = filterRelevantArticles(articlePool);
  const source = sourceLayers.length ? sourceLayers.join("+") : "";

  if (!articles.length) {
    return demoIntel(errors.join(" | ") || "No article source returned usable data", requestMemo);
  }

  if (ANTHROPIC_API_KEY) {
    try {
      return await fetchOpenAiSummary(articles, source, requestMemo);
    } catch (error) {
      errors.push("anthropic: " + error.message);
    }
  }

  return {
    mode:"live",
    source:source + (ANTHROPIC_API_KEY ? "+fi-ranking-fallback" : "+fi-ranking"),
    reason:errors.join(" | "),
    scannedAt:new Date().toISOString(),
    ...(await deriveIntelFromArticles(articles, requestMemo))
  };
}

async function getCached(forceRefresh) {
  const slot = cache.intel;
  const now = Date.now();
  if (!forceRefresh && slot.payload && slot.expiresAt > now) {
    return slot.payload;
  }
  if (!forceRefresh && slot.inflight) {
    return slot.inflight;
  }
  slot.inflight = (async () => {
    try {
      const payload = await buildIntelPayload();
      slot.payload = payload;
      slot.expiresAt = Date.now() + INTEL_CACHE_MS;
      return payload;
    } finally {
      slot.inflight = null;
    }
  })();
  return slot.inflight;
}

module.exports = { getCached };
