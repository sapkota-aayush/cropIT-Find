# Privacy Policy

## Overview

Circle Product processes screenshots of user-selected page areas to generate shopping search queries.

## What Data Is Processed

- User-selected crop image (from the active tab screenshot)
- Page metadata used for context:
  - page title
  - page URL
- Optional derived metadata:
  - OCR text extracted from the crop
  - model-generated query suggestions

## Where Data Is Stored

- `chrome.storage.sync`:
  - OpenAI API key (if user adds one)
  - Amazon Associates tag (optional)
- `chrome.storage.local`:
  - latest scan result used for in-page UI display

## Third-Party Processing

If an OpenAI API key is configured, the extension sends image and text context to OpenAI APIs for:

- OCR extraction
- product/query reasoning

If no API key is configured, these AI requests are not made.

## Data Sharing

- The extension does not run a custom backend server.
- Data is not sold by this project.
- Requests go directly from the extension to third-party endpoints used for analysis and shopping/search destinations.

## User Control

- You can remove stored keys/tags from extension options at any time.
- You can disable/uninstall the extension at any time.
- You can avoid AI processing by not setting an OpenAI API key.

## Security Notes

- Never share your OpenAI API key.
- Rotate your key immediately if exposed.

## Changes to This Policy

This file may be updated as features evolve.
