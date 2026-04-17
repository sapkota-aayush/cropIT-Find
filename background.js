/**
 * Service worker — orchestration only (no DOM).
 *
 * Architecture:
 * 1) Toolbar icon or keyboard shortcut → inject scripts + START_SELECTION (content draws).
 * 2) Content asks CAPTURE_VISIBLE → we return captureVisibleTab PNG data URL.
 * 3) Content crops in-page (has DOM + canvas), sends SCAN_RESULT with crop image.
 * 4) We optionally call OpenAI vision (if key in storage), merge label/keywords.
 * 5) Persist latestScan → optional CIRCLE_SHOW_RESULTS overlay, or (toolbar/shortcut success)
 *    open primary shopping URL in a new tab with no overlay.
 *
 * Why capture in the service worker? Same-origin + correct tab image; content does
 * pixel-accurate crop using viewport ↔ bitmap scaling.
 */

chrome.runtime.onInstalled.addListener(() => {
  /* MV3: reserved for future migrations */
});

function isUnsupportedDrawTargetUrl(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return (
    u.startsWith("chrome-extension://") ||
    u.startsWith("chrome://") ||
    u.startsWith("edge://") ||
    u.startsWith("about:") ||
    u.startsWith("devtools:") ||
    u.startsWith("view-source:") ||
    u.startsWith("moz-extension://")
  );
}

async function injectAndStart(tabId) {
  const meta = await chrome.tabs.get(tabId);
  if (isUnsupportedDrawTargetUrl(meta.url)) {
    throw new Error(
      "Circle Product only runs on normal websites (https). Close Options or switch to a tab like a shop or article page, then try again.",
    );
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "START_SELECTION" });
    return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shopping-lib.js", "content.js"],
  });
  await chrome.tabs.sendMessage(tabId, { type: "START_SELECTION" });
}

async function startDrawOnTab(tabId) {
  try {
    await injectAndStart(tabId);
  } catch (e) {
    let pageUrl = null;
    try {
      const t = await chrome.tabs.get(tabId);
      pageUrl = t.url || null;
    } catch {
      /* ignore */
    }
    const errBase = {
      at: Date.now(),
      error: e?.message || String(e),
      cropDataUrl: null,
      sourceTabId: tabId,
      sourcePageUrl: pageUrl,
    };
    await chrome.storage.local.set({ latestScan: errBase });
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["shopping-lib.js", "content.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "CIRCLE_SHOW_RESULTS" });
    } catch {
      /* Unsupported URL or restricted page */
    }
  }
}

/** Toolbar + shortcut: draw, then open primary link in a new tab (no results overlay). */
async function armAutoOpenAndStartDraw(tabId) {
  await chrome.storage.local.set({
    autoOpenShortcut: { tabId, until: Date.now() + 180000 },
  });
  await startDrawOnTab(tabId);
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  void armAutoOpenAndStartDraw(tab.id);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "activate-circle-product") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await armAutoOpenAndStartDraw(tab.id);
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "CAPTURE_VISIBLE") {
    // Use (options, callback) overload so we never pass undefined windowId.
    // MV3: keep sendResponse on the same tick as possible; callback still OK if SW stays up.
    try {
      chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else if (!dataUrl) {
          sendResponse({ error: "captureVisibleTab returned empty (no permission or blocked page)" });
        } else {
          sendResponse({ dataUrl });
        }
      });
    } catch (e) {
      sendResponse({ error: e?.message || String(e) });
    }
    return true;
  }

  if (msg?.type === "SCAN_RESULT") {
    void handleScanResult(msg, sender.tab);
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "START_DRAW_ON_PAGE") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) await startDrawOnTab(tab.id);
    })();
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

async function extractOcrTextFromCrop(cropDataUrl) {
  const { openaiApiKey } = await chrome.storage.sync.get(["openaiApiKey"]);
  if (!openaiApiKey) return { text: "", raw: null };

  const instructions = `Read visible text from this product crop with OCR.
Return JSON only:
{"text":"single-line OCR text with spaces normalized","tokens":["important exact tokens like model numbers, percentages, sizes, SKUs"]}

Rules:
- Keep original capitalization when possible.
- Include model numbers, strengths (%), and sizes (ml, oz, g, mg) if visible.
- If no useful text is visible, return {"text":"","tokens":[]}.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 220,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instructions },
            { type: "image_url", image_url: { url: cropDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OCR ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    const base = String(parsed.text || "")
      .replace(/\s+/g, " ")
      .trim();
    const toks = Array.isArray(parsed.tokens)
      ? parsed.tokens.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const merged = [base, ...toks].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { text: merged.slice(0, 500), raw: text };
  } catch {
    return { text: text.replace(/\s+/g, " ").trim().slice(0, 500), raw: text };
  }
}

async function analyzeCrop(cropDataUrl, pageContext) {
  const { openaiApiKey } = await chrome.storage.sync.get(["openaiApiKey"]);
  if (!openaiApiKey) {
    return {
      label: null,
      keywords: [],
      productLookupQuery: null,
      preferredStore: null,
      preferredDestination: null,
      officialBrandDomain: null,
      brandHypothesis: null,
      visualDiscriminators: [],
      topQueries: [],
      raw: null,
    };
  }

  const title = (pageContext?.pageTitle || "").slice(0, 500);
  const url = (pageContext?.pageUrl || "").slice(0, 500);
  const ocrText = String(pageContext?.ocrText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const contextBlock =
    title || url
      ? `Page context (use to disambiguate the circled item — e.g. video title naming a gadget, collab merch, or review unit):\n- title: ${title || "(none)"}\n- url: ${url || "(none)"}\n\n`
      : "";
  const ocrBlock = ocrText ? `OCR text from crop (high priority if clear):\n- ${ocrText}\n\n` : "";

  const instructions = `${contextBlock}${ocrBlock}The user drew a loop around something in a web page screenshot. This extension exists to help them **buy or identify the exact product** (affiliate-style shopping search — we only open search URLs we build, never invented product pages).

Your job: identify what they circled as a **product or shoppable item** when possible. **Brand-level specificity matters:** many categories (guitars, watches, sneakers, bikes, power tools, cameras) look alike until a brand + line is named — generic searches ("acoustic guitar") are a failure mode.

Rules:
1) **Brand + exact product variant — never brand alone when the pack names the SKU.** "label" must look like a **real listing title**: **Brand + product line + variant** whenever the crop shows readable packaging, model text, ingredient + %, or size. Many brands (skincare, supplements, tools) reuse the same bottle shape for **different** products — a query that is **only the brand name** (e.g. just "The Ordinary") almost always lands on the **wrong** item. If you can read words like "Retinal 0.2% Emulsion" or "Alpha Arbutin 2% + HA", those strings **must** appear in "label", "keywords", and "product_lookup_query".
2) **Skincare / cosmetics / pharmacy / supplements (critical):** Transcribe **verbatim** the main product name line on the bottle or box (English preferred if both EN and FR appear — include the line that names the formula). Include **active + concentration + product form** when visible (e.g. "%", "Emulsion", "Serum", "SPF 50"). If on-screen text (e.g. video title "Retinal") matches the pack, prefer the **more specific** wording from the **label**.
3) **Infer brand cautiously from visuals** when text is unreadable: use industry-recognized shapes, inlays, hardware families, cutaway vs non-cutaway, scale length cues, pickup layout, bridge type, finish + binding combo — then state your best **one-brand** hypothesis (not a vague list) unless two brands are truly tied; if tied, pick the single most likely for shopping and mention the runner-up in "keywords" only. If visual evidence is generic, do not guess a brand.
4) Copy **visible** model numbers, SKUs, capacities, colors, pack sizes, edition names, or logos into "keywords" and reflect them in "product_lookup_query".
5) Use page title/URL when it clearly names the **same** item as the crop (review title, "Martin D-28 demo", store PDP). Do not paste unrelated channel names.
6) **"brand_hypothesis"**: string — the single best brand you can defend from the crop (e.g. "Fender", "The Ordinary", "Seiko"). Use JSON null when there is no clear brand proof (no readable logo/text and no unmistakable iconic design). Do not guess brand names for generic products; do not use the word "null" as a string.
7) **"visual_discriminators"**: array of **3–8** shopper-style tokens that narrow listings when brand is uncertain (e.g. "sunburst", "single-cutaway", "gold hardware", "tortoise pickguard", "12th-fret inlay dots", "slotted headstock"). For legible cosmetics, prefer concrete tokens from the label (e.g. "0.2% retinal", "pump bottle", "white bottle") over vague words. No fluff like "nice" or "wood".
8) **"product_lookup_query"**: ONE string for **one** shopping search. It must be specific and shopper-usable. If brand_hypothesis is null, use descriptive attributes + object type + material/color/use-case (no invented brand). Never output only a brand name. The **"label"** field should be at least as specific as **product_lookup_query** (often they match).
9) **"preferred_destination"** (pick ONE — this controls the main button; choose what a smart shopper would open first):
   - **"amazon"** — commodity hardware (Raspberry Pi, cables, SD cards, Arduino hats), chargers, books, generics, or when marketplace / Prime fulfillment is the normal path.
   - **"google_shopping"** — price compare, ambiguous brand, white-label, or many retailers carry the same SKU.
   - **"brand_official"** — ONLY for **major** global brands where buying or configuring on the brand domain is usual (Apple, Sony, Nike, Samsung, DJI, Canon, Microsoft hardware, etc.) AND **brand_hypothesis** matches that maker. **Never** output a full product URL or path (we cannot open invented links). You MUST set **"official_brand_domain"** to the registrable hostname only (e.g. "apple.com", "sony.com", "nike.com") — no path, no query string.
   - **"ebay"** — used, vintage, collectible, auction-style.
   - **"google"** — pure software/SaaS/docs, or no product to buy.
   Raspberry Pi boards, GPIO accessories, dev kits, and similar maker commodities → **prefer "amazon"**, not brand_official, even if raspberrypi.org exists.
10) **"official_brand_domain"**: string hostname or JSON **null**. Required when preferred_destination is **brand_official**; must be null for all other destinations.
11) **"top_queries"**: array of 3 short but specific alternatives, ranked best-to-worst. First item should usually match product_lookup_query. Keep each query <= 120 chars, no duplicates.

Reply with JSON only, no markdown:
{"label":"The Ordinary Retinal 0.2% Emulsion","keywords":["The Ordinary","Retinal","0.2%","Emulsion","clinical formulations"],"brand_hypothesis":"The Ordinary","visual_discriminators":["0.2% retinal","emulsion","white pump bottle"],"product_lookup_query":"The Ordinary Retinal 0.2% Emulsion","top_queries":["The Ordinary Retinal 0.2% Emulsion","The Ordinary Retinal 0.2 Emulsion serum","The Ordinary 0.2% Retinal night serum"],"preferred_destination":"amazon","official_brand_domain":null}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 420,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: instructions,
            },
            { type: "image_url", image_url: { url: cropDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  let label = null;
  let keywords = [];
  let productLookupQuery = null;
  let preferredStore = null;
  let preferredDestination = null;
  let officialBrandDomain = null;
  let brandHypothesis = null;
  let visualDiscriminators = [];
  let topQueries = [];
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    label = parsed.label || null;
    keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    let baseQuery =
      typeof parsed.product_lookup_query === "string" ? parsed.product_lookup_query.trim() || null : null;
    const bhRaw = parsed.brand_hypothesis;
    const brandStr =
      bhRaw === null || bhRaw === undefined
        ? ""
        : typeof bhRaw === "string"
          ? bhRaw.trim()
          : String(bhRaw).trim();
    visualDiscriminators = Array.isArray(parsed.visual_discriminators)
      ? parsed.visual_discriminators.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const brandOk = brandStr && !/^(unknown|none|null|n\/a|unbranded generic)$/i.test(brandStr);
    brandHypothesis = brandOk ? brandStr : null;
    baseQuery = mergeBrandVisualsIntoQuery(baseQuery, brandStr, visualDiscriminators);
    productLookupQuery = baseQuery;
    topQueries = normalizeTopQueries(parsed.top_queries, productLookupQuery, label, keywords);

    const destNorm = (v) =>
      String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    const destRaw = destNorm(parsed.preferred_destination);
    const allowed = new Set(["amazon", "google_shopping", "google", "ebay", "brand_official"]);
    preferredDestination = allowed.has(destRaw) ? destRaw : null;
    if (!preferredDestination) {
      const leg = destNorm(parsed.preferred_store);
      if (leg === "amazon" || leg === "google_shopping" || leg === "google" || leg === "ebay") {
        preferredDestination = leg;
      } else {
        preferredDestination = "amazon";
      }
    }
    officialBrandDomain = sanitizeOfficialBrandDomain(parsed.official_brand_domain);
    if (preferredDestination === "brand_official" && !officialBrandDomain) {
      preferredDestination = "google_shopping";
    }
    preferredStore = preferredDestination;
  } catch {
    label = text.slice(0, 80);
  }
  return {
    label,
    keywords,
    productLookupQuery,
    preferredStore,
    preferredDestination,
    officialBrandDomain,
    brandHypothesis,
    visualDiscriminators,
    topQueries,
    raw: text,
  };
}

function normalizeTopQueries(rawTopQueries, primary, label, keywords) {
  const all = [];
  const pushUnique = (v) => {
    const q = String(v || "").replace(/\s+/g, " ").trim();
    if (!q || q.length < 2) return;
    const low = q.toLowerCase();
    if (all.some((x) => x.toLowerCase() === low)) return;
    all.push(q.slice(0, 120));
  };
  pushUnique(primary);
  if (Array.isArray(rawTopQueries)) {
    for (const q of rawTopQueries) pushUnique(q);
  }
  pushUnique(label);
  if (Array.isArray(keywords) && keywords.length) {
    pushUnique([label, ...keywords].filter(Boolean).join(" "));
  }
  return all.slice(0, 3);
}

function hasBrandEvidence(brand, pageContext) {
  const b = String(brand || "").trim();
  if (!b) return false;
  const parts = b
    .toLowerCase()
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
  if (!parts.length) return false;
  const corpus = [pageContext?.ocrText || "", pageContext?.pageTitle || "", pageContext?.pageUrl || ""]
    .join(" ")
    .toLowerCase();
  return parts.some((p) => corpus.includes(p));
}

function stripBrandFromQuery(query, brand) {
  let out = String(query || "").replace(/\s+/g, " ").trim();
  const parts = String(brand || "")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
  for (const part of parts) {
    const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig");
    out = out.replace(re, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

function applyBrandEvidenceGuard(base, pageContext) {
  const bh = String(base.brandHypothesis || "").trim();
  if (!bh) return;
  if (hasBrandEvidence(bh, pageContext)) return;

  base.brandHypothesis = null;
  if (base.preferredDestination === "brand_official") {
    base.preferredDestination = "google_shopping";
    base.preferredStore = "google_shopping";
    base.officialBrandDomain = null;
  }

  base.productLookupQuery = stripBrandFromQuery(base.productLookupQuery, bh) || base.productLookupQuery;
  if (Array.isArray(base.topQueries)) {
    base.topQueries = normalizeTopQueries(
      base.topQueries.map((q) => stripBrandFromQuery(q, bh)),
      base.productLookupQuery,
      base.label,
      base.keywords,
    );
  }
  const note = "No solid brand evidence in OCR/page context, so using descriptive non-brand query.";
  base.reasoningNote = base.reasoningNote ? `${base.reasoningNote} ${note}` : note;
}

function isLowSignalScan(base) {
  const ocrLen = String(base.ocrText || "").trim().length;
  const labelLen = String(base.label || "").trim().length;
  const kwCount = Array.isArray(base.keywords) ? base.keywords.length : 0;
  const qTok = String(base.productLookupQuery || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return ocrLen < 10 && labelLen < 12 && kwCount < 2 && qTok < 4;
}

async function recoverQueriesWithReasoning(cropDataUrl, pageContext, base) {
  const { openaiApiKey } = await chrome.storage.sync.get(["openaiApiKey"]);
  if (!openaiApiKey) return { queries: [], note: null };

  const ocrText = String(pageContext?.ocrText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  const title = String(pageContext?.pageTitle || "").slice(0, 200);
  const seed = [base.brandHypothesis, ...(base.visualDiscriminators || [])]
    .filter(Boolean)
    .join(", ")
    .slice(0, 250);

  const prompt = `You are helping a shopper who does not know how to describe the product.
Given the crop image and weak signals, generate practical search queries.

Context:
- page_title: ${title || "(none)"}
- ocr_text: ${ocrText || "(none)"}
- visual_hints: ${seed || "(none)"}

Return JSON only:
{"queries":["query1","query2","query3"],"note":"one short sentence why these are likely"}

Rules:
- 3 queries, best first.
- Make them shopper-friendly and specific enough to find likely matches.
- If uncertain, include one query focused on visual attributes + use-case.
- Do not invent exact model numbers unless visible in OCR.
- Max 120 chars per query.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 260,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: cropDataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Reasoning ${res.status}: ${t.slice(0, 180)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    const queries = normalizeTopQueries(parsed.queries, null, null, null);
    const note = String(parsed.note || "").trim().slice(0, 180) || null;
    return { queries, note };
  } catch {
    return { queries: normalizeTopQueries([text], null, null, null), note: null };
  }
}

/** Enrich shopping query with brand + rare visual tokens so SERPs are less generic. */
/**
 * If the model returns a stunted query (often brand-only) while label + keywords are richer,
 * prefer the combined listing-style string — reduces wrong SERP / wrong ASIN.
 */
function applyQueryReinforcement(base) {
  const label = String(base.label || "").trim();
  const kws = Array.isArray(base.keywords)
    ? base.keywords.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const combined = [label, ...kws].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!combined) return;

  let q = String(base.productLookupQuery || "").trim();
  if (!q) {
    base.productLookupQuery = combined.slice(0, 320);
    return;
  }

  const qTok = q.split(/\s+/).filter(Boolean).length;
  const cTok = combined.split(/\s+/).filter(Boolean).length;

  if (combined.length > q.length + 10 && cTok >= qTok + 2) {
    base.productLookupQuery = combined.slice(0, 320);
    return;
  }

  const bh = String(base.brandHypothesis || "").trim();
  if (bh && qTok <= 4 && cTok >= 6) {
    const bf = bh.split(/\s+/)[0].toLowerCase();
    const qLow = q.toLowerCase();
    if (bf && qLow.includes(bf) && combined.toLowerCase().includes(bf) && combined.length > q.length + 5) {
      base.productLookupQuery = combined.slice(0, 320);
    }
  }

  base.topQueries = normalizeTopQueries(base.topQueries, base.productLookupQuery, base.label, base.keywords);
}

/** First Amazon SERP ASIN is often wrong for exact-SKU queries — use plain search instead. */
function queryTooSpecificForRiskyAmazonPdpGuess(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  if (/\d[\d.,]*\s*%/.test(s) || /\d[\d.,]*%/.test(s)) return true;
  if (s.split(/\s+/).filter(Boolean).length >= 5) return true;
  if (s.length >= 48) return true;
  if (/\b(?:ml|oz|fl\.?\s*oz|g|mg|l)\b/i.test(s)) return true;
  return false;
}

function mergeBrandVisualsIntoQuery(query, brandHypothesis, discriminators) {
  const discs = discriminators.slice(0, 10);
  const bh = (brandHypothesis || "").trim();
  const bhOk = bh && !/^(unknown|none|null|n\/a|unbranded generic)$/i.test(bh);
  let out = (query || "").trim();

  if (!out) {
    out = [bhOk ? bh : "", ...discs].filter(Boolean).join(" ").trim();
  }

  if (bhOk) {
    const first = bh.split(/\s+/)[0];
    if (first && !out.toLowerCase().includes(first.toLowerCase())) {
      out = `${bh} ${out}`.trim();
    }
  }
  for (const d of discs) {
    const dl = d.toLowerCase();
    if (dl.length > 1 && !out.toLowerCase().includes(dl)) {
      out = `${out} ${d}`.trim();
    }
  }
  return out.slice(0, 320) || null;
}

function sanitizeAmazonAssociateTag(raw) {
  const s = String(raw || "").trim();
  if (/^[a-zA-Z0-9-]{4,64}$/.test(s)) return s;
  return null;
}

/** Hostname only — we never trust model-invented paths; UI uses Google site: search. */
function sanitizeOfficialBrandDomain(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").split("/")[0].split("?")[0].split(":")[0];
  s = s.replace(/^www\./, "");
  if (s.length > 80) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(s)) return null;
  const block = new Set([
    "google.com",
    "youtube.com",
    "youtu.be",
    "amazon.com",
    "amazon.co.uk",
    "amazon.de",
    "facebook.com",
    "instagram.com",
    "wikipedia.org",
    "reddit.com",
    "twitter.com",
    "x.com",
    "bing.com",
    "baidu.com",
    "yahoo.com",
    "tiktok.com",
    "linkedin.com",
    "pinterest.com",
    "twitch.tv",
    "discord.com",
    "github.com",
    "stackoverflow.com",
    "medium.com",
  ]);
  if (block.has(s)) return null;
  return s;
}

function looksLikeAsin(s) {
  return /^[A-Z0-9]{10}$/.test(s) && !/^(.)\1{9}$/.test(s);
}

/** Build query string used for Amazon search + optional PDP resolution. */
function queryForListingResolve(base) {
  const fromAi = (base.productLookupQuery && String(base.productLookupQuery).trim()) || "";
  if (fromAi) return fromAi;
  const joined = [base.label, ...(base.keywords || [])].filter(Boolean).join(" ").trim();
  if (joined) return joined;
  if (base.pageTitle) return `${String(base.pageTitle).slice(0, 160)} product from page`;
  return "";
}

function normalizeDestinationForUrl(base) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
  const d = norm(base.preferredDestination);
  const allowed = ["amazon", "google_shopping", "google", "ebay", "brand_official"];
  if (allowed.includes(d)) return d;
  const leg = norm(base.preferredStore);
  if (allowed.includes(leg)) return leg;
  return "amazon";
}

function buildDestinationUrlForScan(base, query, associateTag) {
  const dest = normalizeDestinationForUrl(base);
  const enc = encodeURIComponent(query);
  const official = String(base.officialBrandDomain || "")
    .trim()
    .toLowerCase();
  switch (dest) {
    case "amazon": {
      let u = `https://www.amazon.com/s?k=${enc}`;
      if (associateTag) u += `&tag=${encodeURIComponent(associateTag)}`;
      return u;
    }
    case "google_shopping":
      return `https://www.google.com/search?tbm=shop&q=${enc}`;
    case "ebay":
      return `https://www.ebay.com/sch/i.html?_nkw=${enc}`;
    case "brand_official":
      if (!official) return `https://www.google.com/search?tbm=shop&q=${enc}`;
      return `https://www.google.com/search?q=${encodeURIComponent(`${query} site:${official}`)}`;
    default:
      return `https://www.google.com/search?q=${enc}`;
  }
}

/** Same primary URL as the overlay CTA (Amazon listing when resolved, else destination search). */
function getPrimaryShoppingUrl(base, associateTag) {
  const q = queryForListingResolve(base);
  if (!q || String(q).trim().length < 2) return null;
  const dest = normalizeDestinationForUrl(base);
  const listingUrl = base.resolvedAmazonListingUrl || null;
  const useListing = Boolean(listingUrl) && (dest === "amazon" || dest === "google_shopping");
  if (useListing) return listingUrl;
  return buildDestinationUrlForScan(base, q, associateTag);
}

/**
 * Best-effort: fetch Amazon search HTML, take first plausible data-asin in results,
 * return a /dp/ URL (not guaranteed to match the crop — user must verify).
 */
async function tryResolveAmazonListingUrl(productQuery, associateTag) {
  const q = (productQuery || "").trim();
  if (q.length < 2) return null;

  let searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(q)}`;
  if (associateTag) searchUrl += `&tag=${encodeURIComponent(associateTag)}`;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(searchUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          typeof navigator !== "undefined" && navigator.userAgent
            ? navigator.userAgent
            : "Mozilla/5.0 (compatible; CircleProduct/1.0)",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (/robot check|type the characters|api-services-support@amazon/i.test(html)) return null;

    let slice = html;
    const mark = html.indexOf("s-search-results");
    if (mark >= 0) slice = html.slice(mark, mark + 600000);

    const re = /data-asin="([A-Z0-9]{10})"/g;
    let m;
    while ((m = re.exec(slice)) !== null) {
      const asin = m[1];
      if (!looksLikeAsin(asin)) continue;
      const u = new URL(`https://www.amazon.com/dp/${asin}`);
      if (associateTag) u.searchParams.set("tag", associateTag);
      return u.toString();
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

async function notifyContentPipelineDone(tabId, detail) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "CIRCLE_PIPELINE_DONE",
      autoOpened: Boolean(detail.autoOpened),
      overlayShown: Boolean(detail.overlayShown),
    });
  } catch {
    /* Tab closed or content not injected */
  }
}

async function persistScanAndNotifyTab(tabId, base) {
  await chrome.storage.local.set({ latestScan: base });

  const { autoOpenShortcut } = await chrome.storage.local.get("autoOpenShortcut");
  const shortcutMatch =
    autoOpenShortcut &&
    tabId != null &&
    autoOpenShortcut.tabId === tabId &&
    Date.now() < autoOpenShortcut.until;

  if (shortcutMatch) {
    await chrome.storage.local.remove("autoOpenShortcut");
  }

  if (shortcutMatch && !base.error && !base.analysisError && !base.qualityWarning) {
    const { amazonAssociateTag } = await chrome.storage.sync.get(["amazonAssociateTag"]);
    const tag = sanitizeAmazonAssociateTag(amazonAssociateTag);
    const url = getPrimaryShoppingUrl(base, tag);
    if (url) {
      try {
        await chrome.tabs.create({ url, active: true });
        await notifyContentPipelineDone(tabId, { autoOpened: true, overlayShown: false });
        return;
      } catch {
        /* fall through to overlay */
      }
    }
  }

  if (tabId == null) return;
  try {
    await notifyContentPipelineDone(tabId, { autoOpened: false, overlayShown: true });
    await chrome.tabs.sendMessage(tabId, { type: "CIRCLE_SHOW_RESULTS" });
  } catch {
    await notifyContentPipelineDone(tabId, { autoOpened: false, overlayShown: false });
  }
}

async function handleScanResult(msg, tab) {
  const base = {
    at: Date.now(),
    cropDataUrl: msg.cropDataUrl || null,
    error: msg.error || null,
    viewport: msg.viewport || null,
    bboxCss: msg.bboxCss || null,
    pageTitle: msg.pageTitle || null,
    label: null,
    keywords: [],
    productLookupQuery: null,
    preferredStore: null,
    preferredDestination: null,
    officialBrandDomain: null,
    analysisError: null,
    resolvedAmazonListingUrl: null,
    resolvedListingError: null,
    brandHypothesis: null,
    visualDiscriminators: [],
    topQueries: [],
    ocrText: null,
    ocrError: null,
    reasoningAssistUsed: false,
    reasoningNote: null,
    qualityWarning: null,
    sourceTabId: tab?.id ?? null,
    sourcePageUrl: msg.pageUrl || tab?.url || null,
  };

  if (msg.error) {
    await persistScanAndNotifyTab(tab?.id ?? null, base);
    return;
  }

  try {
    const ocr = await extractOcrTextFromCrop(msg.cropDataUrl);
    base.ocrText = ocr?.text || null;
  } catch (e) {
    base.ocrError = e?.message || String(e);
  }

  try {
    const ai = await analyzeCrop(msg.cropDataUrl, {
      pageTitle: msg.pageTitle,
      pageUrl: msg.pageUrl || tab?.url,
      ocrText: base.ocrText,
    });
    base.label = ai.label;
    base.keywords = ai.keywords;
    base.productLookupQuery = ai.productLookupQuery;
    base.preferredStore = ai.preferredStore || ai.preferredDestination || "amazon";
    base.preferredDestination = ai.preferredDestination || "amazon";
    base.officialBrandDomain = ai.officialBrandDomain ?? null;
    base.brandHypothesis = ai.brandHypothesis ?? null;
    base.visualDiscriminators = Array.isArray(ai.visualDiscriminators) ? ai.visualDiscriminators : [];
    base.topQueries = Array.isArray(ai.topQueries) ? ai.topQueries : [];
    base.raw = ai.raw;
    applyQueryReinforcement(base);
    applyBrandEvidenceGuard(base, {
      ocrText: base.ocrText,
      pageTitle: msg.pageTitle || tab?.title || "",
      pageUrl: msg.pageUrl || tab?.url || "",
    });
  } catch (e) {
    base.analysisError = e?.message || String(e);
  }

  if (!base.error && !base.analysisError) {
    const q = String(base.productLookupQuery || "").trim();
    const hasAiSignal =
      Boolean(String(base.label || "").trim()) ||
      (Array.isArray(base.keywords) && base.keywords.length > 0) ||
      q.split(/\s+/).filter(Boolean).length >= 3;
    if (!hasAiSignal) {
      base.qualityWarning =
        "Image quality is too weak for reliable detection. Draw a wider loop around the full product so edges and label text are visible.";
    }
  }

  if (!base.error && !base.analysisError && isLowSignalScan(base)) {
    try {
      const recovery = await recoverQueriesWithReasoning(
        msg.cropDataUrl,
        {
          pageTitle: msg.pageTitle || tab?.title || "",
          ocrText: base.ocrText || "",
        },
        base,
      );
      if (Array.isArray(recovery.queries) && recovery.queries.length) {
        base.topQueries = normalizeTopQueries(
          [...recovery.queries, ...(base.topQueries || [])],
          base.productLookupQuery,
          base.label,
          base.keywords,
        );
        if (!base.productLookupQuery && base.topQueries[0]) {
          base.productLookupQuery = base.topQueries[0];
        }
        base.reasoningAssistUsed = true;
      }
      if (recovery.note) base.reasoningNote = recovery.note;
      applyBrandEvidenceGuard(base, {
        ocrText: base.ocrText,
        pageTitle: msg.pageTitle || tab?.title || "",
        pageUrl: msg.pageUrl || tab?.url || "",
      });
    } catch (e) {
      base.reasoningNote = e?.message || String(e);
    }
  }

  try {
    const { amazonAssociateTag } = await chrome.storage.sync.get(["amazonAssociateTag"]);
    const tag = sanitizeAmazonAssociateTag(amazonAssociateTag);
    const resolveQuery = queryForListingResolve(base);
    const destForResolve =
      String(base.preferredDestination || base.preferredStore || "amazon")
        .toLowerCase()
        .replace(/[\s-]+/g, "_") || "amazon";
    const skipPdpGuess = queryTooSpecificForRiskyAmazonPdpGuess(resolveQuery);
    if (
      resolveQuery &&
      !skipPdpGuess &&
      (destForResolve === "amazon" || destForResolve === "google_shopping")
    ) {
      base.resolvedAmazonListingUrl = await tryResolveAmazonListingUrl(resolveQuery, tag);
    }
  } catch (e) {
    base.resolvedListingError = e?.message || String(e);
  }

  await persistScanAndNotifyTab(tab?.id ?? null, base);
}

/** Drop saved scan when user leaves the tab it came from (avoids Messi crop on Google tab UX). */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const { latestScan } = await chrome.storage.local.get("latestScan");
    if (!latestScan?.sourceTabId) return;
    if (activeInfo.tabId !== latestScan.sourceTabId) {
      await chrome.storage.local.remove("latestScan");
    }
  } catch {
    /* ignore */
  }
});
