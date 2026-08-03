# iNaturalist Enhancement Suite

A Chrome extension that adds identification, computer-vision, upload, and
taxon-page utilities to iNaturalist and supported network sites.

The extension is implemented with Manifest V3 content scripts and stores its
settings in `chrome.storage.sync`. It does not require a build step.

## Features

- **AI-Powered Smart Auto-Crop:** Run on-device subject localization through **LiteRT.js** (WebAssembly), with a crop-modal selector for the legacy COCO YOLOv8n model, MegaDetector V6 Compact, U²-NetP saliency, and an arthropod-specific YOLO11n model.
- **Passive crop dataset:** Save metadata and one user-approved normalized box—never image bytes—to extension-local storage shared across content scripts and the review page. The options page opens a dashboard with progress toward 500 verified examples, correction/rejection tools, active-learning priorities, JSON backup/import, and COCO/YOLO export.
- **Image Gallery / Photos Tab:** View observation photos in a structured, interactive image gallery tab.
- **Quick Add Plant Button:** Add flora identifications quickly with a "Quick Plant" action button next to the taxon input field.
- **Similar Species Selection Buttons:** Add selection and identify buttons directly onto similar species list items/cards.
- **Identify Page Paging Cooldown:** Prevent double loading and infinite scroll bugs with a visual loading overlay and pagination cooldown.
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
├── background.js
├── detector-postprocess.js
├── crop-dataset.js
├── dataset.html / dataset.js / dataset.css
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
├── similar-species.css
├── test.html
└── lib/
    └── litert/
        ├── litert.js
        └── models/
        │   ├── yolov8n.tflite
        │   ├── megadetector-v6-compact.tflite
        │   ├── arthropod-yolo11n.tflite
        │   └── u2netp-saliency.tflite
        └── wasm/
            ├── litert_wasm_internal.js
            └── litert_wasm_internal.wasm (etc.)
```

- `background.js` handles cross-origin image requests and executes selectable local inference inside the extension service worker.
- `crop-dataset.js` owns the versioned, metadata-only `chrome.storage.local` annotation store; `dataset.*` implements review and export.
- `domContext.js` runs in the page's main JavaScript world. It bridges
  operations that need iNaturalist's page context to isolated content scripts
  through custom DOM events.
- `content-score-crop.js` provides Score Image, Crop for CV, suggestion
  rendering, selectable hierarchy links, linked taxonomic hierarchies, and Smart Auto-Crop.
- `content-identify-similar.js` adds the Similar Species section to the
  Identify modal Info panel and keeps it below the ID activity.
- `content-identifications.js` adds API-backed filtering, compact paging, and
  a 10-result toolbar to user identification pages.
- `content-observation.js` handles observation-page CV hierarchy display and
  identify-page auto-pagination with a cooldown/loading overlay.
- `options.html` and `options.js` manage feature preferences.
- `test.html` is an interactive browser playground for developers to run and verify model inferences.

## Model Technical Notes

The default is the unchanged legacy `192x192` COCO **YOLOv8n** path. Three additional browser-verified adapters are available: MegaDetector V6 Compact (`640x640`, YOLOv10 end-to-end rows), Arthropod YOLO11n (`640x640`, raw one-class detections), and U²-NetP (`320x320`, largest saliency component to one box). Model hashes, sources, licenses, and tensor contracts live beside each artifact and in [MODEL_INTEGRATION.md](MODEL_INTEGRATION.md).

### Why other models failed:
1. **EfficientDet-Lite0:** This raw model has `19,206` raw boxes. It does not contain a post-processing operator graph. The JS runtime was written expecting a post-processed model with 4 output tensors (`boxes`, `classes`, `scores`, `num_detections`), leading to raw buffer parsing failures and browser crashes.
2. **Mobile Object Localizer V1:** This model contains a dynamic C++ custom operator (`TFLite_Detection_PostProcess`). The browser's WebAssembly runtime failed to lock/unlock dynamically sized memory buffers allocated by this custom operator inside service workers (`Failed to unlock buffer`), crashing with type `NONE` (`0`).

### Legacy YOLOv8n path:
The existing YOLOv8n (`imgsz=192`) uses standard TFLite/LiteRT tensors.
* **Aspect-Ratio Preserved Letterboxing:** Drawing non-square images directly to a square input squashed and distorted target organisms, preventing accurate localization. We scale images proportionally to fit the `192x192` square and draw them centered on black padding.
* **Active-Region Coordinate Mapping:** We filter out false detections centering in the black padding zones, map the coordinates back relative to the active image space, and normalize them to the original image dimensions.
* **Model Limits:** Because the model is trained on the general COCO 80-class dataset, it does not natively understand specific insect or plant species (e.g. a grasshopper is often classified as a `bird` or `potted plant`). We use class-agnostic confidence scores for localization and display what the model mapped the subject to (e.g., `localized bird (50% confidence)`) on the UI.

## Validation

### Automated Regression Test Suite:
We have bundled an automated test suite containing the actual images shared during testing (Grasshoppers, Rat/Mouse, etc.) to ensure that coordinates and class maps do not regress in the future.

To execute the automated checks:
```bash
npm test
```
This runs `node tests/run_tests.js`, which decodes, letterboxes, runs YOLOv8-nano inference on each image, and asserts that the resulting class IDs and bounding box coordinates match expected thresholds.

To compile and sample-infer all three additional bundled models with the exact extension runtime:

```bash
npm run test:models
```

The separate metadata/training repository is at
`/Users/brian/Developer/MRI/projects/inaturalist-crop-dataset`.

### Syntax & Lint Checks:
You can also run syntax and manifest checks for changed files:

```bash
node --check "iNaturalist Enhancement Suite/content-score-crop.js"
node --check "iNaturalist Enhancement Suite/content-identify-similar.js"
node --check "iNaturalist Enhancement Suite/content-identifications.js"
node --check "iNaturalist Enhancement Suite/content-observation.js"
node --check "iNaturalist Enhancement Suite/domContext.js"
node --check "iNaturalist Enhancement Suite/background.js"
node --check "iNaturalist Enhancement Suite/options.js"
jq empty "iNaturalist Enhancement Suite/manifest.json"
git diff --check
```

### Interactive Test Suite:
Open `test.html` in Chrome inside the extension folder to run interactive test cases visually on the same sample images.

## Debugging

Enable logging from the extension options page to expose additional messages in Chrome DevTools. For modal and Identify-page issues, inspect both the page DOM and the corresponding implementation in the local iNaturalist clone.

See [DEVELOPMENT.md](DEVELOPMENT.md) for feature-specific development notes.
