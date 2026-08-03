# Selectable crop-model integration audit

Status: integration work in progress. The current YOLOv8n inference path is intentionally unchanged. This personal educational build accepts AGPL artifacts; licenses are retained as provenance rather than treated as commercial-release blockers.

## Runtime baseline

The extension currently loads `lib/litert/models/yolov8n.tflite` with the bundled LiteRT.js WASM runtime in the MV3 service worker. The local artifact is 12,749,506 bytes and has SHA-256 `d28982e72920b451b9578efc084b1140271791cebd45681a38652f23e3802d84`. Its observed contract is float32 BCHW input `[1,3,192,192]` and float32 output `[1,84,756]` (`xywh` plus 80 COCO class scores). Its exact upstream checkpoint, export command, Ultralytics version, and license choice are not recorded, so it should be treated as a legacy artifact whose provenance needs reconstruction.

LiteRT.js can load a standard `.tflite` flatbuffer, but that alone does not guarantee compatibility. Every candidate must pass a service-worker compile and inference spike using the exact bundled WASM binary. Output parsing and preprocessing are model-specific.

## Candidate matrix

| Model | Canonical artifact | License/provenance | Source contract | TFLite path and LiteRT.js assessment |
|---|---|---|---|---|
| Current YOLOv8n | Local `yolov8n.tflite` (12,749,506 bytes); upstream base normally [`yolov8n.pt`](https://github.com/ultralytics/assets/releases/) | Local artifact provenance is undocumented. Ultralytics code and model licensing must be resolved against its [AGPL-3.0 / Enterprise terms](https://www.ultralytics.com/license). | `[1,3,192,192]` float RGB in this export; `[1,84,756]` raw anchor-free detections. | Already compiles and runs. Preserve as `yolov8n-legacy`; do not alter its decoder during adapter extraction. |
| MegaDetector V6 Compact | [`MDV6-yolov10-c.pt`](https://zenodo.org/records/15398270/files/MDV6-yolov10-c.pt?download=1), 5,752,051 bytes, Zenodo MD5 `1ecc38fbe462320ea33bf3c57e9e1561`, 2.3M parameters | The official [model zoo](https://microsoft.github.io/Biodiversity/model_zoo/megadetector/) marks `MDV6-yolov10-c` **AGPL-3.0**. Detects animal/person/vehicle, not taxa. Accepted for this personal educational build. | Ultralytics YOLOv10, normally 640-square BCHW RGB. End-to-end/NMS-free exports conventionally return rows `[x1,y1,x2,y2,score,class]`; the exact exported TFLite signature must be captured rather than assumed. | Use Ultralytics export: `yolo export model=MDV6-yolov10-c.pt format=litert imgsz=640 batch=1 end2end=True` (and later calibrated INT8). YOLOv10 LiteRT export is officially listed as supported in the [YOLOv10 docs](https://docs.ultralytics.com/models/yolov10/). Requires a compile spike and a new end-to-end output parser. |
| U²-NetP | [`u2netp.pth`](https://drive.google.com/file/d/1rbSTGKAE-MTxBYHd-51l2hMOQPT_7EPy/view), about 4.7 MB, linked by the [official repository](https://github.com/NathanUA/U-2-Net#usage-for-salient-object-detection) | Official repository is [Apache-2.0](https://github.com/NathanUA/U-2-Net/blob/master/LICENSE). Trained for generic salient-object segmentation, not wildlife. | Recommended 320×320 RGB input. PyTorch forward returns seven single-channel saliency maps `d0...d6`; use `d0`, normalize/threshold it, retain the selected component, and derive one padded bounding rectangle. | No official TFLite artifact or supported one-command export. Reproduce the PyTorch model, export a one-output ONNX wrapper (fixed `[1,3,320,320]`, `d0` only), convert ONNX→TensorFlow SavedModel→TFLite, and compare masks numerically at each hop. The nested resize/upsample graph may need converter-safe rewrites. Standard convolutions/pooling/resize should be viable in LiteRT WASM, but this is the highest conversion-risk candidate. |
| Arthropod YOLO11n | Current Hugging Face files include [`yolo11n_ArthroNat+flatbug.pt`](https://huggingface.co/edgaremy/arthropod-detector/resolve/main/yolo11n_ArthroNat%2Bflatbug.pt), 5,454,170 bytes, and [ONNX](https://huggingface.co/edgaremy/arthropod-detector/resolve/main/yolo11n_ArthroNat%2Bflatbug.onnx), 10,604,452 bytes. A mosaic variant is also present. | The [model card](https://huggingface.co/edgaremy/arthropod-detector) says MIT, while the supplied ONNX embeds `AGPL-3.0 License (https://ultralytics.com/license)`. Both are recorded; AGPL use is accepted for this personal educational build. | Supplied ONNX metadata: YOLO11n detect, one class (`Arthropod`), input 640×640, batch 1, NMS false. A normal raw one-class YOLO11 export is expected to be `[1,5,8400]`; verify the generated TFLite signature. | Export the `.pt` directly with the current [Ultralytics LiteRT exporter](https://docs.ultralytics.com/modes/export/): `yolo export model=... format=litert imgsz=640 batch=1 nms=False`. Then use a generic raw-YOLO adapter parameterized by output details and class count. |

File names and sizes above were checked on 2026-07-19. Remote repositories are mutable; pin revisions and hashes before use.

## Implemented adapters

All three requested candidates have now been converted, bundled, compiled, and sample-inferred with the extension's exact LiteRT.js WASM runtime:

| Adapter | Bundled artifact | Verified contract | Sample gate |
|---|---:|---|---|
| MegaDetector V6 Compact | 9,350,262 bytes | `[1,3,640,640]` → `[1,300,6]` pixel `xyxy/score/class` | Rat fixture: top animal score 0.9205 |
| Arthropod YOLO11n | 10,626,645 bytes | `[1,3,640,640]` → `[1,5,8400]` normalized raw YOLO | Grasshopper fixture: top arthropod score 0.8396 |
| U²-NetP | 4,726,756 bytes | `[1,3,320,320]` → `[1,1,320,320]` saliency mask | Grasshopper fixture produced a valid largest-component box; crop quality is visibly weaker and belongs in the 500-box benchmark |

The legacy model remains the default and its decoder is unchanged. Run `npm run test:models` to repeat the compile/sample gates. These gates prove runtime compatibility, not comparative crop quality.

## Adapter contract

Keep preprocessing and parsing inside the adapter. The caller should receive normalized original-image coordinates and should not know tensor layouts.

```js
// One selected subject for version 1; adapters may inspect many candidates.
const detectorAdapter = {
  manifest: {
    id: 'megadetector-v6-yolov10-c',
    version: 'source revision + export revision',
    task: 'detection',
    labels: ['animal', 'person', 'vehicle']
  },
  async load({ liteRt, modelUrl, accelerator }) {},
  async detect({ bitmap, signal }) {
    return {
      box: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      score: 0,
      classId: 0,
      className: 'animal',
      inferenceMs: 0,
      diagnostics: { candidateCount: 0 }
    };
  },
  async dispose() {}
};
```

Required behavior:

- return one box or `null`; multiple-box annotation remains out of scope;
- normalize to the unrotated original image, after reversing letterbox padding;
- expose model/version in every passive annotation;
- select animal-only output from MegaDetector unless the user explicitly chooses another class;
- select the highest useful arthropod detection for the arthropod model;
- derive one component/rectangle from U²-NetP's saliency mask;
- keep `yolov8n-legacy` preprocessing, score handling, labels, and selection byte-for-byte equivalent while it is moved behind the interface;
- cache compiled models by ID, but retain at most one large compiled model unless memory measurements show this is safe.

## Model manifest requirements

Every bundled or downloaded converted artifact should have a checked-in manifest containing:

```json
{
  "id": "stable-model-id",
  "display_name": "User-facing name",
  "source_repository": "https://...",
  "source_revision": "immutable commit or Hub revision",
  "source_artifact_url": "https://...",
  "source_artifact_sha256": "...",
  "source_artifact_bytes": 0,
  "source_license_spdx": "AGPL-3.0-only",
  "source_license_url": "https://...",
  "export_tool": "ultralytics",
  "export_tool_version": "exact version",
  "export_command": "reproducible command",
  "export_artifact_sha256": "...",
  "export_artifact_bytes": 0,
  "input": { "dtype": "float32", "layout": "BCHW", "shape": [1, 3, 640, 640], "range": [0, 1] },
  "outputs": [{ "name": "...", "dtype": "float32", "shape": [1, 300, 6], "semantics": "xyxy_score_class" }],
  "labels": ["..."],
  "preprocess": { "resize": "letterbox", "pad_value": 0 },
  "postprocess": { "decoder": "...", "threshold": 0.25, "nms_iou": null },
  "verified_runtime": { "litert_js_revision": "...", "accelerator": "wasm", "browser": "..." },
  "verified_at": "YYYY-MM-DD"
}
```

The build should reject a model whose bytes do not match its manifest. Record SHA-256 locally even when an upstream registry publishes only MD5.

## Staged integration plan

1. Extract current inference behind `yolov8n-legacy` and prove the existing tests remain unchanged.
2. Add the model registry/dropdown with only the legacy model enabled; persist the default model ID.
3. Convert and test Arthropod YOLO11n first because it is architecturally closest to the current raw YOLO decoder.
4. Convert/test MegaDetector V6 Compact with a dedicated YOLOv10 end-to-end parser. Compare `end2end=True` and `end2end=False` exports if LiteRT operator support differs.
5. Convert/test U²-NetP last, including mask parity tests and a documented mask-to-box policy.
6. For each model, run the same fixed image corpus in Python/source format, desktop TFLite, Node test harness, and the MV3 service worker. Record compile time, warm inference median/p95, memory growth, package bytes, detection failures, and coordinate parity.
7. Enable a model in production UI only after provenance, license, manifest/hash, offline packaging, and failure fallback are complete.

## Release blockers and cautions

- **Licensing provenance:** MegaDetector YOLOv10 Compact is AGPL-3.0. The arthropod model has an MIT card and AGPL embedded metadata. Both are acceptable for the stated personal educational use, but remain documented so the decision can be revisited if distribution changes.
- **Extension size:** bundling current (12.7 MB) plus several 5–15+ MB models and compiled WASM will inflate install/update size. Begin with development-only bundled artifacts; decide later between optional downloads and a curated shipped subset. Optional downloads require durable caching, integrity checks, CSP review, and offline behavior.
- **Remote code policy:** download data-only TFLite bytes, never executable JavaScript. All adapters and conversion logic must ship in the extension package.
- **Runtime compatibility:** “TFLite export succeeded” is insufficient. Compile with the repository's exact LiteRT.js WASM runtime in an MV3 worker before exposing a dropdown choice.
- **Contract drift:** never hard-code `80` classes or `756` boxes for new models. Validate tensor names, dtypes, shapes, and semantics against the pinned manifest.
- **U²-NetP semantics:** saliency is not an intended-subject detector. It may select a flower instead of an insect or combine disconnected salient regions; benchmark the mask-to-box policy rather than assuming superiority.
- **MegaDetector domain:** its training goal is camera-trap animal/person/vehicle detection. Plants, fungi, and macro arthropods are outside its stated label set.
- **Arthropod evidence:** the model card currently publishes no metrics, covers French terrestrial arthropods, and has stale filename documentation. Treat it as experimental until evaluated on the reviewed collection.

## Primary references

- [LiteRT.js package and browser documentation](https://ai.google.dev/edge/litert/web)
- [Ultralytics export documentation](https://docs.ultralytics.com/modes/export/)
- [Ultralytics YOLOv10 export support](https://docs.ultralytics.com/models/yolov10/)
- [Microsoft Biodiversity MegaDetector model zoo](https://microsoft.github.io/Biodiversity/model_zoo/megadetector/)
- [MegaDetector V6 Compact Zenodo artifact](https://zenodo.org/records/15398270/files/MDV6-yolov10-c.pt?download=1)
- [Official U²-Net repository](https://github.com/NathanUA/U-2-Net)
- [Edgar Remy arthropod detector model card/files](https://huggingface.co/edgaremy/arthropod-detector)
