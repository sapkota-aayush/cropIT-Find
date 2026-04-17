/**
 * Content script — runs in the page world (isolated).
 *
 * 1) START_SELECTION → draw loop on page.
 * 2) Crop → SCAN_RESULT to background.
 * 3) CIRCLE_SHOW_RESULTS → glass overlay on page (no side panel).
 *
 * Wrapped in an IIFE so executeScript re-injects without top-level redeclaration errors.
 */
(() => {
  const GUARD = "__circleSearchMvp_guard_v1";
  if (globalThis[GUARD]) {
    document.dispatchEvent(new CustomEvent("csmvp-start"));
    return;
  }
  globalThis[GUARD] = true;
  initContent();

  function initContent() {
    const ROOT_ID = "circle-search-mvp-root";
    const CANVAS_ID = "circle-search-mvp-canvas";
    const HINT_ID = "circle-search-mvp-hint";
    const FLOAT_HOST_ID = "circle-product-float-root";
    const PIPELINE_LOADING_ID = "circle-product-pipeline-loading";

    const FLOAT_SHADOW_CSS = `
.cp-root {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.cp-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 6, 12, 0.55);
  backdrop-filter: blur(12px);
  animation: cp-fade 0.22s ease-out;
}
.cp-modal {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(400px, calc(100vw - 28px));
  max-height: min(86vh, 720px);
  display: flex;
  flex-direction: column;
  background: linear-gradient(160deg, rgba(30, 36, 52, 0.97) 0%, rgba(12, 14, 22, 0.98) 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px rgba(255, 200, 120, 0.12),
    0 24px 80px rgba(0, 0, 0, 0.55),
    0 0 60px rgba(244, 167, 66, 0.08);
  animation: cp-pop 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
}
.cp-close {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: #e8edf5;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}
.cp-close:hover {
  background: rgba(255, 255, 255, 0.14);
}
.cp-scroll {
  padding: 20px 18px 18px;
  overflow-y: auto;
  max-height: min(86vh, 720px);
}
.cp-badge {
  margin: 0 0 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(244, 180, 96, 0.85);
}
.cp-title {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #f4f6fb;
}
.cp-query {
  margin: 0 0 14px;
  font-size: 12px;
  color: #9aa4b8;
  word-break: break-word;
}
.cp-query-label {
  display: inline-block;
  margin-right: 6px;
  padding: 2px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #c5cbd8;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  vertical-align: middle;
}
.cp-brand-hint {
  margin: -4px 0 14px;
  font-size: 11px;
  line-height: 1.5;
  color: #9aa4b8;
}
.cp-brand-strong {
  color: #e8c27a;
  font-weight: 650;
}
.cp-cta {
  display: block;
  text-align: center;
  text-decoration: none;
  padding: 14px 14px;
  border-radius: 12px;
  font-weight: 700;
  font-size: 15px;
  color: #1a1206;
  background: linear-gradient(165deg, #ffd089 0%, #f4a742 48%, #c77d1f 100%);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset, 0 10px 32px rgba(244, 167, 66, 0.22);
  transition: filter 0.12s ease, transform 0.12s ease;
}
.cp-cta:hover {
  filter: brightness(1.04);
  transform: translateY(-1px);
}
.cp-note {
  margin: 8px 0 14px;
  font-size: 11px;
  color: #7d8699;
  text-align: center;
}
.cp-chips-label {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #6b7385;
}
.cp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cp-chip {
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #c5cee0;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.cp-chip:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.cp-details {
  margin-top: 14px;
  font-size: 12px;
  color: #7d8699;
}
.cp-details summary {
  cursor: pointer;
  color: #a8b0c4;
}
.cp-alt {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
.cp-alt a {
  color: #8fb4ff;
  text-decoration: none;
  font-weight: 600;
}
.cp-alt a:hover {
  text-decoration: underline;
}
.cp-extra {
  margin: 10px 0 0;
}
.cp-extra a {
  color: #8fb4ff;
}
.cp-muted {
  color: #7d8699;
  font-size: 12px;
  margin: 0;
}
.cp-err-title {
  margin: 0 0 8px;
  color: #fecaca;
  font-weight: 600;
}
.cp-err {
  margin: 0 0 10px;
  padding: 10px;
  border-radius: 10px;
  background: rgba(80, 20, 20, 0.45);
  border: 1px solid rgba(220, 80, 80, 0.35);
  color: #fecaca;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
}
.cp-warn {
  margin: 0 0 6px;
  color: #fca5a5;
  font-weight: 600;
}
.cp-preview {
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  margin: 0 0 14px;
  display: block;
}
.cp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.cp-btn {
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #e8edf5;
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.cp-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.cp-btn-primary {
  background: linear-gradient(165deg, #ffd089 0%, #f4a742 48%, #c77d1f 100%);
  color: #1a1206;
  border-color: rgba(255, 255, 255, 0.28);
}
.cp-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.cp-preview-meta {
  margin: -4px 0 8px;
  font-size: 11px;
  color: #9aa4b8;
}
.cp-card {
  margin: 0;
}
@keyframes cp-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cp-pop {
  from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
`;

    let active = false;
    let drawing = false;
    let points = [];
    let canvas;
    let ctx;
    let hintEl;
    let listenersWired = false;

    function removeFloatingPanel() {
      document.getElementById(FLOAT_HOST_ID)?.remove();
    }

    function removePipelineLoading() {
      document.getElementById(PIPELINE_LOADING_ID)?.remove();
    }

    function showPipelineLoading() {
      removePipelineLoading();
      const el = document.createElement("div");
      el.id = PIPELINE_LOADING_ID;
      el.setAttribute("data-cp-loading", "");
      el.innerHTML =
        '<div class="cp-load-track"><div class="cp-load-bar"></div></div><p class="cp-load-label">Finding your product…</p>';
      document.documentElement.appendChild(el);
      setTimeout(() => {
        if (document.getElementById(PIPELINE_LOADING_ID)) removePipelineLoading();
      }, 45000);
    }

    async function showFloatingResultsFromStorage() {
      removeFloatingPanel();
      const { latestScan } = await chrome.storage.local.get("latestScan");
      if (!latestScan) return;

      const Lib = globalThis.__circleProductShopping;
      const { amazonAssociateTag } = await chrome.storage.sync.get(["amazonAssociateTag"]);
      const tag = Lib ? Lib.sanitizeAmazonAssociateTag(amazonAssociateTag) : null;
      const inner = Lib
        ? Lib.buildResultsInnerHtml(latestScan, tag)
        : `<p class="cp-muted">Reload this page, then try again — extension scripts need a refresh.</p>`;

      const host = document.createElement("div");
      host.id = FLOAT_HOST_ID;
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = FLOAT_SHADOW_CSS;
      shadow.appendChild(style);

      const shell = document.createElement("div");
      shell.className = "cp-root";
      shell.innerHTML = `
        <div class="cp-backdrop" data-cp-back></div>
        <div class="cp-modal" role="dialog" aria-modal="true" aria-label="Circle Product results">
          <button type="button" class="cp-close" data-cp-close aria-label="Close">×</button>
          <div class="cp-scroll">${inner}</div>
        </div>
      `;
      shadow.appendChild(shell);

      const close = () => removeFloatingPanel();
      shell.querySelector("[data-cp-back]")?.addEventListener("click", close);
      shell.querySelector("[data-cp-close]")?.addEventListener("click", close);
      shell.querySelector(".cp-modal")?.addEventListener("click", (ev) => ev.stopPropagation());

      document.documentElement.appendChild(host);
      setTimeout(() => {
        shell.querySelector("[data-cp-close]")?.focus?.();
      }, 50);
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.latestScan && changes.latestScan.newValue === undefined) {
        removeFloatingPanel();
      }
    });

    function ensureDom() {
      const existing = document.getElementById(ROOT_ID);
      if (existing) {
        const c = document.getElementById(CANVAS_ID);
        const h = document.getElementById(HINT_ID);
        if (c && h && existing.contains(c) && existing.contains(h)) {
          canvas = c;
          hintEl = h;
          ctx = canvas.getContext("2d");
          if (ctx) resizeCanvas();
          return;
        }
        existing.remove();
      }

      const root = document.createElement("div");
      root.id = ROOT_ID;
      canvas = document.createElement("canvas");
      canvas.id = CANVAS_ID;
      hintEl = document.createElement("div");
      hintEl.id = HINT_ID;
      hintEl.textContent = "Drag a box around the product · release to preview · Esc to cancel";
      root.appendChild(canvas);
      root.appendChild(hintEl);
      document.documentElement.appendChild(root);
      ctx = canvas.getContext("2d");
      if (!ctx) return;
      resizeCanvas();
      window.addEventListener("resize", resizeCanvas);
    }

    function resizeCanvas() {
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function bboxFromPoints(pts, pad = 12) {
      if (!pts.length) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = Math.max(0, minX - pad);
      let y = Math.max(0, minY - pad);
      let w = Math.min(vw - x, maxX - minX + pad * 2);
      let h = Math.min(vh - y, maxY - minY + pad * 2);
      if (w < 24 || h < 24) {
        w = Math.min(vw - x, 120);
        h = Math.min(vh - y, 120);
      }
      return { x, y, w, h };
    }

    function expandBoxForBetterEdges(box, viewport) {
      if (!box) return null;
      const vw = Math.max(1, Math.floor(viewport?.w || window.innerWidth));
      const vh = Math.max(1, Math.floor(viewport?.h || window.innerHeight));
      const longestSide = Math.max(box.w, box.h);
      const adaptivePad = Math.max(10, Math.min(44, Math.round(longestSide * 0.12)));
      const x = Math.max(0, Math.floor(box.x - adaptivePad));
      const y = Math.max(0, Math.floor(box.y - adaptivePad));
      const right = Math.min(vw, Math.ceil(box.x + box.w + adaptivePad));
      const bottom = Math.min(vh, Math.ceil(box.y + box.h + adaptivePad));
      return {
        x,
        y,
        w: Math.max(1, right - x),
        h: Math.max(1, bottom - y),
      };
    }

    function clearCanvas() {
      if (!canvas || !ctx) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.restore();
    }

    function redrawStroke() {
      clearCanvas();
      if (!ctx || points.length < 2) return;
      const a = points[0];
      const b = points[points.length - 1];
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      if (w < 2 || h < 2) return;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = "rgba(34, 211, 238, 0.55)";
      ctx.shadowBlur = 14;
      ctx.strokeStyle = "rgba(125, 211, 252, 0.35)";
      ctx.lineWidth = 7;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
    }

    function startSelection() {
      removePipelineLoading();
      removeFloatingPanel();
      ensureDom();
      if (!ctx || !canvas || !hintEl) return;
      active = true;
      document.getElementById(ROOT_ID).classList.add("active");
      points = [];
      drawing = false;
      clearCanvas();
      hintEl.style.display = "block";
    }

    function stopSelection() {
      active = false;
      drawing = false;
      points = [];
      const root = document.getElementById(ROOT_ID);
      if (root) root.classList.remove("active");
      if (hintEl) hintEl.style.display = "none";
      clearCanvas();
    }

    async function captureWithRetry(attempts = 4) {
      let lastErr = "Unknown capture error";
      for (let i = 0; i < attempts; i++) {
        const cap = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE" }, (res) => {
              if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
              } else {
                resolve(res);
              }
            });
          } catch (e) {
            resolve({ error: e?.message || String(e) });
          }
        });
        if (cap && cap.dataUrl) return cap;
        lastErr = cap?.error || "Empty response from background (service worker may have restarted)";
        await new Promise((r) => setTimeout(r, 80 * (i + 1)));
      }
      return { error: lastErr };
    }

    async function finishSelection() {
      const rawBox = bboxFromPoints(points);
      stopSelection();
      if (!rawBox) return;

      const viewport = { w: window.innerWidth, h: window.innerHeight };
      const box = expandBoxForBetterEdges(rawBox, viewport);
      if (!box) return;

      try {
        const cap = await captureWithRetry();
        if (cap?.error || !cap?.dataUrl) {
          await chrome.runtime.sendMessage({
            type: "SCAN_RESULT",
            error: cap?.error || "captureVisibleTab failed",
            viewport,
            pageUrl: location.href,
            pageTitle: document.title,
          });
          return;
        }
        await showSelectionPreview(cap.dataUrl, box, viewport, {
          pageUrl: location.href,
          pageTitle: document.title,
        });
      } catch (e) {
        await chrome.runtime.sendMessage({
          type: "SCAN_RESULT",
          error: e?.message || String(e),
          viewport,
          pageUrl: location.href,
          pageTitle: document.title,
        });
      }
    }

    function clampSelectionBox(box, viewport) {
      const vw = Math.max(1, Math.floor(viewport?.w || window.innerWidth));
      const vh = Math.max(1, Math.floor(viewport?.h || window.innerHeight));
      let x = Math.max(0, Math.floor(box.x));
      let y = Math.max(0, Math.floor(box.y));
      let w = Math.max(16, Math.floor(box.w));
      let h = Math.max(16, Math.floor(box.h));
      if (x + w > vw) x = Math.max(0, vw - w);
      if (y + h > vh) y = Math.max(0, vh - h);
      w = Math.min(w, vw - x);
      h = Math.min(h, vh - y);
      return { x, y, w, h };
    }

    function cropDataFromImage(img, box, viewport) {
      const vw = Math.max(1, viewport.w);
      const vh = Math.max(1, viewport.h);
      const sx = (box.x / vw) * img.naturalWidth;
      const sy = (box.y / vh) * img.naturalHeight;
      const sw = (box.w / vw) * img.naturalWidth;
      const sh = (box.h / vh) * img.naturalHeight;
      const cropWidthPx = Math.max(1, Math.floor(sw));
      const cropHeightPx = Math.max(1, Math.floor(sh));
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropWidthPx;
      cropCanvas.height = cropHeightPx;
      const cctx = cropCanvas.getContext("2d");
      cctx.drawImage(img, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
      return {
        cropDataUrl: cropCanvas.toDataURL("image/png"),
        cropWidthPx,
        cropHeightPx,
      };
    }

    async function showSelectionPreview(captureDataUrl, initialBox, viewport, pageMeta) {
      removeFloatingPanel();
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Failed to decode capture image"));
        img.src = captureDataUrl;
      });

      let box = clampSelectionBox(initialBox, viewport);
      const host = document.createElement("div");
      host.id = FLOAT_HOST_ID;
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = FLOAT_SHADOW_CSS;
      shadow.appendChild(style);

      const shell = document.createElement("div");
      shell.className = "cp-root";
      shell.innerHTML = `
        <div class="cp-backdrop" data-cp-preview-close></div>
        <div class="cp-modal" role="dialog" aria-modal="true" aria-label="Selection preview">
          <button type="button" class="cp-close" data-cp-preview-close aria-label="Close">×</button>
          <div class="cp-scroll">
            <p class="cp-badge">Selection Preview</p>
            <h2 class="cp-title">Adjust before search</h2>
            <p class="cp-preview-meta" data-cp-preview-meta></p>
            <img class="cp-preview" data-cp-preview-image alt="Selection preview" />
            <p class="cp-muted" data-cp-preview-status></p>
            <div class="cp-grid">
              <button type="button" class="cp-btn" data-cp-adjust="up">Move up</button>
              <button type="button" class="cp-btn" data-cp-adjust="expand">Expand</button>
              <button type="button" class="cp-btn" data-cp-adjust="down">Move down</button>
              <button type="button" class="cp-btn" data-cp-adjust="left">Move left</button>
              <button type="button" class="cp-btn" data-cp-adjust="shrink">Shrink</button>
              <button type="button" class="cp-btn" data-cp-adjust="right">Move right</button>
            </div>
            <div class="cp-actions">
              <button type="button" class="cp-btn" data-cp-redraw>Redraw</button>
              <button type="button" class="cp-btn cp-btn-primary" data-cp-search>Search this crop</button>
            </div>
          </div>
        </div>
      `;
      shadow.appendChild(shell);
      document.documentElement.appendChild(host);

      const previewImage = shell.querySelector("[data-cp-preview-image]");
      const previewMeta = shell.querySelector("[data-cp-preview-meta]");
      const previewStatus = shell.querySelector("[data-cp-preview-status]");

      const renderPreview = () => {
        box = clampSelectionBox(box, viewport);
        const cropped = cropDataFromImage(img, box, viewport);
        previewImage.src = cropped.cropDataUrl;
        previewMeta.textContent = `${cropped.cropWidthPx} x ${cropped.cropHeightPx}px`;
        if (cropped.cropWidthPx < 120 || cropped.cropHeightPx < 120) {
          previewStatus.textContent = "Too tight: expand so full product edges and label text are visible.";
          return { ...cropped, tooSmall: true };
        }
        previewStatus.textContent = "Looks good. Press Search this crop to continue.";
        return { ...cropped, tooSmall: false };
      };

      let lastCropped = renderPreview();

      const closePreview = () => {
        host.remove();
      };

      shell.querySelectorAll("[data-cp-preview-close]").forEach((n) => n.addEventListener("click", closePreview));

      shell.querySelector("[data-cp-redraw]")?.addEventListener("click", () => {
        closePreview();
        startSelection();
      });

      shell.querySelectorAll("[data-cp-adjust]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const op = btn.getAttribute("data-cp-adjust");
          const move = Math.max(6, Math.round(Math.max(box.w, box.h) * 0.08));
          const size = Math.max(8, Math.round(Math.max(box.w, box.h) * 0.1));
          if (op === "up") box.y -= move;
          if (op === "down") box.y += move;
          if (op === "left") box.x -= move;
          if (op === "right") box.x += move;
          if (op === "expand") {
            box.x -= size;
            box.y -= size;
            box.w += size * 2;
            box.h += size * 2;
          }
          if (op === "shrink") {
            box.x += size;
            box.y += size;
            box.w = Math.max(16, box.w - size * 2);
            box.h = Math.max(16, box.h - size * 2);
          }
          lastCropped = renderPreview();
        });
      });

      shell.querySelector("[data-cp-search]")?.addEventListener("click", async () => {
        lastCropped = renderPreview();
        if (lastCropped.tooSmall) return;
        closePreview();
        showPipelineLoading();
        await chrome.runtime.sendMessage({
          type: "SCAN_RESULT",
          cropDataUrl: lastCropped.cropDataUrl,
          viewport: { w: viewport.w, h: viewport.h },
          bboxCss: box,
          pageUrl: pageMeta.pageUrl,
          pageTitle: pageMeta.pageTitle,
        });
      });
    }

    function clientPoint(ev) {
      return { x: ev.clientX, y: ev.clientY };
    }

    function onPointerDown(ev) {
      if (!active || !canvas || !ctx) return;
      ev.preventDefault();
      drawing = true;
      const p = clientPoint(ev);
      points = [p, p];
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      redrawStroke();
    }

    function onPointerMove(ev) {
      if (!active || !drawing) return;
      ev.preventDefault();
      points[1] = clientPoint(ev);
      redrawStroke();
    }

    function onPointerUp(ev) {
      if (!active || !drawing) return;
      ev.preventDefault();
      drawing = false;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (points.length < 2) {
        stopSelection();
        return;
      }
      void finishSelection();
    }

    function onKeyDown(ev) {
      if (ev.key === "Escape" && document.getElementById(FLOAT_HOST_ID)) {
        ev.preventDefault();
        removeFloatingPanel();
        return;
      }
      if (ev.key === "Escape" && active) {
        ev.preventDefault();
        stopSelection();
      }
    }

    function wireCanvasOnce() {
      ensureDom();
      if (listenersWired) return;
      listenersWired = true;
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      window.addEventListener("keydown", onKeyDown);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "START_SELECTION") {
        wireCanvasOnce();
        startSelection();
      } else if (msg?.type === "CIRCLE_SHOW_RESULTS") {
        void showFloatingResultsFromStorage();
      } else if (msg?.type === "CIRCLE_PIPELINE_DONE") {
        removePipelineLoading();
      }
    });

    document.addEventListener("csmvp-start", () => {
      wireCanvasOnce();
      startSelection();
    });
  }
})();
