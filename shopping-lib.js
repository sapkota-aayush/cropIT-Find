/**
 * Shared UI HTML for in-page floating panel (content script).
 * Loaded before content.js in the same isolated world.
 */
(() => {
  const ns = "__circleProductShopping_v1";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitizeAmazonAssociateTag(raw) {
    const t = String(raw || "").trim();
    if (/^[a-zA-Z0-9-]{4,64}$/.test(t)) return t;
    return null;
  }

  function defaultProductQuery(label, keywords, pageTitleFallback) {
    return (
      [label, ...(keywords || [])].filter(Boolean).join(" ").trim() ||
      (pageTitleFallback
        ? `${String(pageTitleFallback).slice(0, 160)} product from page`
        : "product from screenshot crop")
    );
  }

  /** AI routing: amazon | google_shopping | ebay | google | brand_official */
  function normalizeDestination(scan) {
    const norm = (v) =>
      String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    const d = norm(scan.preferredDestination);
    const allowed = ["amazon", "google_shopping", "google", "ebay", "brand_official"];
    if (allowed.includes(d)) return d;
    const leg = norm(scan.preferredStore);
    if (allowed.includes(leg)) return leg;
    return "amazon";
  }

  function buildBrandOfficialSearchUrl(domain, query) {
    const q = `${query} site:${domain}`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  function buildDestinationUrl(dest, query, officialDomain, amazonAssociateTag) {
    const enc = encodeURIComponent(query);
    switch (dest) {
      case "amazon": {
        let u = `https://www.amazon.com/s?k=${enc}`;
        if (amazonAssociateTag) u += `&tag=${encodeURIComponent(amazonAssociateTag)}`;
        return u;
      }
      case "google_shopping":
        return `https://www.google.com/search?tbm=shop&q=${enc}`;
      case "ebay":
        return `https://www.ebay.com/sch/i.html?_nkw=${enc}`;
      case "brand_official": {
        const d = String(officialDomain || "")
          .trim()
          .toLowerCase();
        if (!d) return `https://www.google.com/search?tbm=shop&q=${enc}`;
        return buildBrandOfficialSearchUrl(d, query);
      }
      default:
        return `https://www.google.com/search?q=${enc}`;
    }
  }

  function buildStoreUrl(store, query, amazonAssociateTag) {
    return buildDestinationUrl(store, query, null, amazonAssociateTag);
  }

  function primaryCtaCopy(dest, useListing) {
    if (useListing) {
      return {
        label: "Open top Amazon listing",
        note: "First strong Amazon match for your query — confirm before buying.",
      };
    }
    switch (dest) {
      case "amazon":
        return { label: "Find on Amazon", note: "AI picked Amazon for this kind of product." };
      case "google_shopping":
        return { label: "Compare stores", note: "AI picked Google Shopping to compare retailers." };
      case "ebay":
        return { label: "Search on eBay", note: "AI picked eBay (used / collectible / auction-style)." };
      case "brand_official":
        return {
          label: "Search brand site",
          note: "Google search limited to the brand domain (see details) — open the exact product page from results. We never invent a product URL.",
        };
      case "google":
        return { label: "Search the web", note: "AI picked open web search (software, docs, or no clear buy path)." };
      default:
        return { label: "Search the web", note: "AI picked open web search." };
    }
  }

  /**
   * @returns {string} HTML body (no outer wrapper). Caller mounts inside Shadow DOM.
   */
  function buildResultsInnerHtml(scan, amazonAssociateTag) {
    if (!scan) {
      return `<p class="cp-muted">No scan data.</p>`;
    }

    const links = (() => {
      const q = defaultProductQuery(scan.label, scan.keywords, scan.pageTitle);
      const enc = encodeURIComponent(q);
      return {
        google: `https://www.google.com/search?q=${enc}`,
        images: `https://www.google.com/search?tbm=isch&q=${enc}`,
      };
    })();

    const productQuery =
      (scan.productLookupQuery && String(scan.productLookupQuery).trim()) ||
      defaultProductQuery(scan.label, scan.keywords, scan.pageTitle);
    const dest = normalizeDestination(scan);
    const officialDomain = (scan.officialBrandDomain && String(scan.officialBrandDomain).trim()) || "";
    const destUrl = buildDestinationUrl(dest, productQuery, officialDomain, amazonAssociateTag);
    const listingUrl = scan.resolvedAmazonListingUrl || null;
    const useListingPrimary =
      Boolean(listingUrl) && (dest === "amazon" || dest === "google_shopping");
    const primaryHref = useListingPrimary ? listingUrl : destUrl;
    const { label: primaryLabel, note: primaryNoteRaw } = primaryCtaCopy(dest, useListingPrimary);

    let html = "";

    if (scan.error) {
      html += `<p class="cp-err-title">Capture failed</p><pre class="cp-err">${escapeHtml(scan.error)}</pre>`;
    }

    if (scan.cropDataUrl) {
      html += `<img class="cp-preview" src="${scan.cropDataUrl}" alt="" />`;
    }

    if (scan.analysisError) {
      html += `<p class="cp-warn">Vision</p><pre class="cp-err">${escapeHtml(scan.analysisError)}</pre>`;
      html += `<p class="cp-muted">Add an OpenAI key in extension Options for sharper queries.</p>`;
    }
    if (scan.ocrError) {
      html += `<p class="cp-warn">OCR</p><pre class="cp-err">${escapeHtml(scan.ocrError)}</pre>`;
    }
    if (scan.qualityWarning) {
      html += `<p class="cp-warn">Crop quality</p><pre class="cp-err">${escapeHtml(scan.qualityWarning)}</pre>`;
    }
    if (scan.reasoningAssistUsed) {
      html += `<p class="cp-muted">Used multi-step reasoning to generate search ideas from weak visual signals.</p>`;
    }

    const hasQuery =
      !scan.error &&
      (scan.cropDataUrl || scan.label || (scan.keywords && scan.keywords.length) || scan.pageTitle);

    if (hasQuery) {
      const amazonL = buildStoreUrl("amazon", productQuery, amazonAssociateTag);
      const shopL = buildStoreUrl("google_shopping", productQuery, amazonAssociateTag);
      const ebayL = buildStoreUrl("ebay", productQuery, amazonAssociateTag);
      const webL = links.google;
      const topQueries = Array.isArray(scan.topQueries)
        ? scan.topQueries.map((q) => String(q || "").trim()).filter(Boolean)
        : [];

      html += `<div class="cp-card">`;
      html += `<p class="cp-badge">Circle Product</p>`;
      if (scan.label) {
        html += `<h2 class="cp-title">${escapeHtml(scan.label)}</h2>`;
      } else {
        html += `<h2 class="cp-title">Your crop</h2>`;
      }
      html += `<p class="cp-query"><span class="cp-query-label">Search</span> ${escapeHtml(productQuery)}</p>`;
      if (scan.brandHypothesis || (scan.visualDiscriminators && scan.visualDiscriminators.length)) {
        const brandBits = [];
        if (scan.brandHypothesis) {
          brandBits.push(`<span class="cp-brand-strong">${escapeHtml(scan.brandHypothesis)}</span>`);
        }
        if (scan.visualDiscriminators && scan.visualDiscriminators.length) {
          brandBits.push(escapeHtml(scan.visualDiscriminators.join(" · ")));
        }
        html += `<p class="cp-brand-hint">${brandBits.join(" · ")}</p>`;
      }
      html += `<a class="cp-cta" href="${primaryHref}" target="_blank" rel="noreferrer">${escapeHtml(primaryLabel)}</a>`;
      html += `<p class="cp-note">${escapeHtml(primaryNoteRaw)}</p>`;
      if (topQueries.length > 1) {
        html += `<p class="cp-chips-label">More query options</p><div class="cp-chips">`;
        for (const q of topQueries.slice(1, 4)) {
          const qUrl = buildDestinationUrl(dest, q, officialDomain, amazonAssociateTag);
          html += `<a class="cp-chip" href="${qUrl}" target="_blank" rel="noreferrer">${escapeHtml(q)}</a>`;
        }
        html += `</div>`;
      }

      html += `<details class="cp-details"><summary>Other ways to shop</summary>`;
      html += `<p class="cp-alt">`;
      html += `<a href="${amazonL}" target="_blank" rel="noreferrer">Amazon</a> · `;
      html += `<a href="${shopL}" target="_blank" rel="noreferrer">Shopping</a> · `;
      html += `<a href="${ebayL}" target="_blank" rel="noreferrer">eBay</a> · `;
      html += `<a href="${webL}" target="_blank" rel="noreferrer">Web</a> · `;
      html += `<a href="${links.images}" target="_blank" rel="noreferrer">Images</a>`;
      html += `</p>`;
      if (listingUrl && !useListingPrimary && (dest === "amazon" || dest === "google_shopping")) {
        html += `<p class="cp-muted"><a href="${escapeHtml(listingUrl)}" target="_blank" rel="noreferrer">Amazon top listing (guess)</a></p>`;
      }
      if (dest === "brand_official" && officialDomain) {
        html += `<p class="cp-muted">Brand scope: <strong>${escapeHtml(officialDomain)}</strong></p>`;
      }
      const kwLine = (scan.keywords || []).filter(Boolean).join(", ");
      const detailBits = [
        scan.label ? `<div>${escapeHtml(scan.label)}</div>` : "",
        kwLine ? `<div class="cp-muted">${escapeHtml(kwLine)}</div>` : "",
        scan.ocrText ? `<div class="cp-muted">OCR: ${escapeHtml(scan.ocrText)}</div>` : "",
        scan.reasoningNote ? `<div class="cp-muted">Reasoning: ${escapeHtml(scan.reasoningNote)}</div>` : "",
        scan.resolvedAmazonListingUrl
          ? `<div class="cp-muted"><a href="${escapeHtml(scan.resolvedAmazonListingUrl)}" target="_blank" rel="noreferrer">Resolved Amazon listing</a></div>`
          : "",
      ]
        .filter(Boolean)
        .join("");
      if (detailBits) html += detailBits;
      html += `</details></div>`;
    }

    if (!scan.error && !scan.label && !scan.analysisError) {
      html += `<p class="cp-muted">Tip: add an OpenAI key in Options for product naming and tighter shopping queries.</p>`;
    }

    return html;
  }

  globalThis[ns] = {
    escapeHtml,
    sanitizeAmazonAssociateTag,
    buildResultsInnerHtml,
  };
  globalThis.__circleProductShopping = globalThis[ns];
})();
