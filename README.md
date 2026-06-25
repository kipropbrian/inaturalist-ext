# iNaturalist Enhancement Suite

A Chrome extension that adds identification, computer-vision, upload, and
taxon-page utilities to iNaturalist and supported network sites.

The extension is implemented with Manifest V3 content scripts and stores its
settings in `chrome.storage.sync`. It does not require a build step.

## Features

- Score observation images with iNaturalist computer vision.
- Crop part of an image before requesting computer-vision suggestions.
- Show linked taxonomic hierarchies for computer-vision suggestions and
  observation-page CV matches.
- Add a Similar Species section to the Identify observation modal, below the
  identification activity.
- Search and filter a user's identifications by taxon and category, with
  compact pagination and a 10-result view.
- Improve computer-vision result colors and optionally show percentages.
- Copy observation coordinates.
- Show identifier statistics and personal observation counts.
- Populate observation dates from supported audio filenames.
- Add utilities to observation upload and taxon pages.
- Cache stable computer-vision and taxonomy data locally for a week to reduce
  repeated scoring and lookup work.

Features can be enabled or disabled from the extension options page.

## Install for Development

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose:

   ```text
   /Users/brian/Developer/MRI/projects/inaturalist-ext/iNaturalist Enhancement Suite
   ```

5. Reload the extension after changing its JavaScript, CSS, options, or
   manifest.
6. Refresh the affected iNaturalist page.

Disable the Web Store version while testing if both copies attempt to modify
the same page.

## Project Structure

```text
iNaturalist Enhancement Suite/
├── manifest.json
├── options.html
├── options.js
├── domContext.js
├── content-score-crop.js
├── content-identify-similar.js
├── content-identifications.js
├── content-observation.js
├── content-upload.js
├── content-taxa.js
├── identifications.css
└── similar-species.css
```

- `domContext.js` runs in the page's main JavaScript world. It bridges
  operations that need iNaturalist's page context to isolated content scripts
  through custom DOM events.
- `content-score-crop.js` provides Score Image, Crop for CV, suggestion
  rendering, selectable hierarchy links, and linked taxonomic hierarchies.
- `content-identify-similar.js` adds the Similar Species section to the
  Identify modal Info panel and keeps it below the ID activity.
- `content-identifications.js` adds API-backed filtering, compact paging, and
  a 10-result toolbar to user identification pages.
- `content-observation.js` handles observation-page CV hierarchy display and
  identify-page auto-pagination with a cooldown/loading overlay.
- `options.html` and `options.js` manage feature preferences.

## iNaturalist Web-App Reference

A local clone of the iNaturalist web application is available at:

```text
/Users/brian/Developer/MRI/projects/inaturalist
```

Use it as the source of truth when matching iNaturalist behavior or UI. In
particular, inspect its React components, Rails views, styles, tab state, and
API usage before changing code that interacts with the observation modal,
Identify page, taxon autocomplete, or identification forms.

The extension and web-app repositories are siblings:

```text
/Users/brian/Developer/MRI/projects/
├── inaturalist/
└── inaturalist-ext/
```

The web-app clone is a reference repository. Extension changes should remain
in `inaturalist-ext` unless work on the application itself is explicitly
requested.

## Validation

There is currently no bundled test suite or build command. Run syntax and
manifest checks for changed files:

```bash
node --check "iNaturalist Enhancement Suite/content-score-crop.js"
node --check "iNaturalist Enhancement Suite/content-identify-similar.js"
node --check "iNaturalist Enhancement Suite/content-identifications.js"
node --check "iNaturalist Enhancement Suite/content-observation.js"
node --check "iNaturalist Enhancement Suite/domContext.js"
node --check "iNaturalist Enhancement Suite/options.js"
jq empty "iNaturalist Enhancement Suite/manifest.json"
git diff --check
```

Then reload the unpacked extension and manually verify the affected page.

## Debugging

Enable logging from the extension options page to expose additional messages
in Chrome DevTools. For modal and Identify-page issues, inspect both the page
DOM and the corresponding implementation in the local iNaturalist clone.

See [DEVELOPMENT.md](DEVELOPMENT.md) for feature-specific development notes.
