# Circle Product (circle-search-mvp)

Circle Product is a Chrome Extension (Manifest V3) that lets you circle any product on a webpage, captures that area, identifies a useful product query, and opens a shopping search page in a new tab.

## 1) What This Project Does

- Starts from extension icon click or keyboard shortcut (`Alt+Shift+C`).
- Draws a selection overlay directly on the page.
- Captures the visible tab as an image.
- Crops only the user-selected area.
- Builds a shopping query (with optional AI assistance).
- Opens the primary destination URL (Amazon by default) in a new tab.

## 2) Project Structure

- `manifest.json` - extension metadata, permissions, command, and options page registration.
- `background.js` - service worker orchestration: injection, screenshot capture, result routing, and tab opening.
- `content.js` - in-page interaction layer: draw UI, crop logic, and results overlay.
- `shopping-lib.js` - shared URL/query utilities for shopping destinations and CTA behavior.
- `overlay.css` - visual styling for drawing and overlay experience.
- `options.html` - settings UI (OpenAI key and Amazon Associates tag).
- `options.js` - save/load options via Chrome storage.

## 3) End-to-End Flow

1. User clicks toolbar icon or presses the shortcut.
2. Background script injects `overlay.css`, `shopping-lib.js`, and `content.js` if needed.
3. Content script starts selection mode and captures the draw region.
4. Content requests `CAPTURE_VISIBLE` from background.
5. Background returns tab screenshot (`captureVisibleTab`).
6. Content crops selected area and sends `SCAN_RESULT`.
7. Background enriches result (optionally with OpenAI if API key is configured).
8. Background stores latest scan and opens the selected shopping URL.

## 4) Architecture Notes

### Why capture happens in `background.js`

`captureVisibleTab` is a browser-level API available to extension context, not page DOM context. The service worker captures the screenshot, while the content script performs pixel-accurate crop using viewport coordinates.

### Why crop happens in `content.js`

The content script has page geometry details (zoom, viewport offsets, draw bounds), which makes the final crop precise and aligned with the user's drawn area.

### Re-injection guard

`content.js` uses a global guard key to prevent duplicate initialization when scripts are injected multiple times in the same tab.

## 5) Configuration

Open options page from the extension and set:

- **OpenAI API key (optional):** Enables better product labeling/query generation.
- **Amazon Associates tag (optional):** Adds `&tag=...` to Amazon search links for affiliate attribution.

Storage behavior:

- Sensitive config is stored through Chrome extension storage APIs.
- Latest scan/error state is stored in local storage for UI follow-up.

## 6) Permissions & Compatibility

Current key permissions (from `manifest.json`):

- `activeTab`, `tabs`, `storage`, `scripting`
- Host permission: `<all_urls>`

Known unsupported targets for draw/capture:

- `chrome://*`, `chrome-extension://*`, `edge://*`, `about:*`, `devtools:*`, and similar restricted pages.

Use normal website tabs (`https://...`) for expected behavior.

## 7) Local Development

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder: `career-ops/circle-search-mvp`.
4. Open any product page and test with:
   - Extension toolbar icon, or
   - Keyboard shortcut (`Alt+Shift+C`).

## 8) Testing Checklist

- Selection overlay appears and can be cancelled cleanly.
- Capture request succeeds on normal webpages.
- Crop result corresponds to drawn region.
- Successful scan opens a new shopping tab.
- Invalid/restricted pages show graceful error handling.
- Options save and reload correctly across browser restarts.
- Amazon tag appends correctly when configured.

## 9) Troubleshooting

- **Nothing happens after shortcut**  
  Check shortcut assignment in `chrome://extensions/shortcuts` and confirm active tab is a normal website.

- **Capture fails**  
  Try refreshing the page and rerunning. Restricted browser pages cannot be captured.

- **Wrong or weak product query**  
  Add/update OpenAI key in options and retest with a cleaner, tighter selection.

- **Affiliate tag not applied**  
  Verify tag format and ensure destination route is Amazon.

## 10) Current Scope and Next Improvements

Potential next steps:

- Add structured event logging for each pipeline stage.
- Add confidence scoring and fallback query heuristics.
- Add lightweight result history view in options.
- Add destination preference profiles per domain/category.

---

If you are continuing active development, start with `background.js` for orchestration changes and `content.js` for UX/crop behavior updates.
