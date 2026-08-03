// Background script for handling cross-origin image requests and local machine learning inference

importScripts('./detector-postprocess.js');
importScripts('./crop-job.js');

// Load the standard WASM loader and save its factory
importScripts('./lib/litert/wasm/litert_wasm_internal.js');
self.StandardModuleFactory = ModuleFactory;

// Clean up the global ModuleFactory variable to prevent polluting
self.ModuleFactory = undefined;

// Load the main LiteRT library
importScripts('./lib/litert/litert.js');

const COCO_CLASSES = [
	'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
	'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
	'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
	'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
	'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
	'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
	'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
	'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
	'hair drier', 'toothbrush'
];

const CROP_COLLECTOR_URL = 'http://127.0.0.1:8765';
const CROP_COLLECTOR_TOKEN_KEY = 'iNatCropCollectorToken';
const CROP_DATASET_STORAGE_KEY = 'iNatCropDatasetRecords';
const CROP_DATASET_JOBS_KEY = 'iNatCropDatasetJobs';
const CROP_DATASET_ALARM = 'inat-crop-dataset-jobs';
const CROP_JOB_MODELS = Object.freeze([
	{ id: 'yolov8n-coco-legacy', name: 'YOLOv8n (current COCO model)', version: 'bundled' },
	{ id: 'megadetector-v6-compact', name: 'MegaDetector V6 Compact', version: 'mdv6-yolov10-c-99038c4e' },
	{ id: 'u2netp-saliency', name: 'U²-NetP saliency', version: 'official-ac7e1c8-106b8c4e' },
	{ id: 'arthropod-yolo11n', name: 'Arthropod YOLO11n', version: 'flatbug-32094b6a' }
]);

function storageGet(keys) {
	return new Promise((resolve, reject) => {
		chrome.storage.local.get(keys, result => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve(result || {});
		});
	});
}

function storageSet(values) {
	return new Promise((resolve, reject) => {
		chrome.storage.local.set(values, () => {
			if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
			else resolve();
		});
	});
}

function localStorageGet(key) {
	return storageGet(key).then(result => result?.[key] || '');
}

async function callCropCollector(path, { method = 'GET', body } = {}) {
	const token = await localStorageGet(CROP_COLLECTOR_TOKEN_KEY);
	if (!token) throw new Error('Collector token is not configured');
	const response = await fetch(`${CROP_COLLECTOR_URL}${path}`, {
		method,
		headers: {
			'X-iNat-Collector-Token': token,
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(result.error || `Collector returned HTTP ${response.status}`);
	return result;
}

async function repairCropAnnotationPhoto(record) {
	if (record?.photo_url) return record;
	const observationId = record?.observation_id;
	const photoId = record?.photo_id || String(record?.annotation_id || '').split(':').pop();
	if (!observationId || !/^\d+$/.test(String(photoId || ''))) return record;
	const response = await fetch(`https://api.inaturalist.org/v1/observations/${encodeURIComponent(observationId)}`);
	if (!response.ok) throw new Error(`Could not repair photo metadata (iNaturalist HTTP ${response.status})`);
	const observation = (await response.json()).results?.[0];
	const photo = (observation?.photos || []).find(candidate => String(candidate.id) === String(photoId));
	if (!photo?.url) throw new Error(`Photo ${photoId} is not present on observation ${observationId}`);
	return {
		...record,
		photo_id: String(photo.id),
		photo_url: photo.url.replace(/\/(square|small|medium|large)\./, '/original.'),
		original_width: record.original_width || photo.original_dimensions?.width,
		original_height: record.original_height || photo.original_dimensions?.height
	};
}

let compiledModel = null;
let liteRtInitializationPromise = null;
let modelInitializationPromise = null;
let arthropodCompiledModel = null;
let arthropodInitializationPromise = null;
let megaDetectorCompiledModel = null;
let megaDetectorInitializationPromise = null;
let u2netCompiledModel = null;
let u2netInitializationPromise = null;

function getLiteRtRuntime(wasmDir) {
	if (!liteRtInitializationPromise) {
		// Ensure the Emscripten loader resolves the WASM binary inside the
		// extension package. LiteRT clears this global after initialization.
		self.Module = {
			locateFile: path => chrome.runtime.getURL('lib/litert/wasm/' + path),
			print: text => {
				if (text && (text.startsWith('INFO:') || text.startsWith('WARNING:'))) return;
				console.log(text);
			},
			printErr: text => {
				if (text && (text.startsWith('INFO:') || text.startsWith('WARNING:'))) return;
				console.warn(text);
			}
		};
		liteRtInitializationPromise = LiteRT.loadLiteRt(wasmDir).catch(error => {
			liteRtInitializationPromise = null;
			throw error;
		});
	}
	return liteRtInitializationPromise;
}

async function initializeDetector() {
	console.log('[iNat Enhancement Suite] Initializing LiteRT.js object localizer (YOLOv8n)...');
	const startTime = performance.now();

	const wasmDir = chrome.runtime.getURL('lib/litert/wasm/');
	const modelPath = chrome.runtime.getURL('lib/litert/models/yolov8n.tflite');

	await getLiteRtRuntime(wasmDir);
	console.log('[iNat Enhancement Suite] LiteRT.js runtime loaded successfully.');
	console.log('[iNat Enhancement Suite] Compiling YOLOv8-nano on CPU from:', modelPath);
	compiledModel = await LiteRT.loadAndCompile(modelPath, { accelerator: 'wasm' });

	const inputDetails = compiledModel.getInputDetails();
	const outputDetails = compiledModel.getOutputDetails();
	if (inputDetails.length !== 1 || outputDetails.length !== 1) {
		throw new Error(`Unexpected object-localizer contract (${inputDetails.length} inputs, ${outputDetails.length} outputs).`);
	}

	const duration = (performance.now() - startTime).toFixed(1);
	console.log(`[iNat Enhancement Suite] YOLOv8-nano compiled successfully in ${duration}ms.`, {
		inputs: inputDetails.map(detail => ({ name: detail.name, dtype: detail.dtype, shape: Array.from(detail.shape) })),
		outputs: outputDetails.map(detail => ({ name: detail.name, dtype: detail.dtype, shape: Array.from(detail.shape) }))
	});
	return compiledModel;
}

function getDetectorModel() {
	if (compiledModel) return Promise.resolve(compiledModel);
	if (!modelInitializationPromise) {
		modelInitializationPromise = initializeDetector().catch(error => {
			modelInitializationPromise = null;
			console.error('[iNat Enhancement Suite] Failed to initialize LiteRT object localizer:', error);
			throw error;
		});
	}
	return modelInitializationPromise;
}

async function initializeArthropodDetector() {
	console.log('[iNat Enhancement Suite] Initializing Arthropod YOLO11n crop detector...');
	const wasmDir = chrome.runtime.getURL('lib/litert/wasm/');
	const modelPath = chrome.runtime.getURL('lib/litert/models/arthropod-yolo11n.tflite');
	await getLiteRtRuntime(wasmDir);
	arthropodCompiledModel = await LiteRT.loadAndCompile(modelPath, { accelerator: 'wasm' });
	const inputDetails = arthropodCompiledModel.getInputDetails();
	const outputDetails = arthropodCompiledModel.getOutputDetails();
	const inputShape = Array.from(inputDetails[0]?.shape || []);
	const outputShape = Array.from(outputDetails[0]?.shape || []);
	if (inputDetails.length !== 1 || outputDetails.length !== 1 ||
		inputShape.join(',') !== '1,3,640,640' || outputShape.join(',') !== '1,5,8400') {
		arthropodCompiledModel = null;
		throw new Error(`Unexpected arthropod detector contract: input [${inputShape}], output [${outputShape}]`);
	}
	console.log('[iNat Enhancement Suite] Arthropod YOLO11n compiled successfully.');
	return arthropodCompiledModel;
}

async function initializeMegaDetector() {
	console.log('[iNat Enhancement Suite] Initializing MegaDetector V6 Compact...');
	const wasmDir = chrome.runtime.getURL('lib/litert/wasm/');
	const modelPath = chrome.runtime.getURL('lib/litert/models/megadetector-v6-compact.tflite');
	await getLiteRtRuntime(wasmDir);
	megaDetectorCompiledModel = await LiteRT.loadAndCompile(modelPath, { accelerator: 'wasm' });
	const inputShape = Array.from(megaDetectorCompiledModel.getInputDetails()[0]?.shape || []);
	const outputShape = Array.from(megaDetectorCompiledModel.getOutputDetails()[0]?.shape || []);
	if (inputShape.join(',') !== '1,3,640,640' || outputShape.join(',') !== '1,300,6') {
		megaDetectorCompiledModel = null;
		throw new Error(`Unexpected MegaDetector contract: input [${inputShape}], output [${outputShape}]`);
	}
	console.log('[iNat Enhancement Suite] MegaDetector V6 Compact compiled successfully.');
	return megaDetectorCompiledModel;
}

async function initializeU2Net() {
	console.log('[iNat Enhancement Suite] Initializing U²-NetP saliency crop model...');
	const wasmDir = chrome.runtime.getURL('lib/litert/wasm/');
	const modelPath = chrome.runtime.getURL('lib/litert/models/u2netp-saliency.tflite');
	await getLiteRtRuntime(wasmDir);
	u2netCompiledModel = await LiteRT.loadAndCompile(modelPath, { accelerator: 'wasm' });
	const inputShape = Array.from(u2netCompiledModel.getInputDetails()[0]?.shape || []);
	const outputShape = Array.from(u2netCompiledModel.getOutputDetails()[0]?.shape || []);
	if (inputShape.join(',') !== '1,3,320,320' || outputShape.join(',') !== '1,1,320,320') {
		u2netCompiledModel = null;
		throw new Error(`Unexpected U²-NetP contract: input [${inputShape}], output [${outputShape}]`);
	}
	console.log('[iNat Enhancement Suite] U²-NetP compiled successfully.');
	return u2netCompiledModel;
}

function getSelectedDetectorModel(modelId) {
	if (modelId === 'arthropod-yolo11n') {
		if (arthropodCompiledModel) return Promise.resolve(arthropodCompiledModel);
		if (!arthropodInitializationPromise) {
			arthropodInitializationPromise = initializeArthropodDetector().catch(error => {
				arthropodInitializationPromise = null;
				throw error;
			});
		}
		return arthropodInitializationPromise;
	}
	if (modelId === 'megadetector-v6-compact') {
		if (megaDetectorCompiledModel) return Promise.resolve(megaDetectorCompiledModel);
		if (!megaDetectorInitializationPromise) {
			megaDetectorInitializationPromise = initializeMegaDetector().catch(error => {
				megaDetectorInitializationPromise = null;
				throw error;
			});
		}
		return megaDetectorInitializationPromise;
	}
	if (modelId === 'u2netp-saliency') {
		if (u2netCompiledModel) return Promise.resolve(u2netCompiledModel);
		if (!u2netInitializationPromise) {
			u2netInitializationPromise = initializeU2Net().catch(error => {
				u2netInitializationPromise = null;
				throw error;
			});
		}
		return u2netInitializationPromise;
	}
	return getDetectorModel();
}

// Start warming the detector immediately, while allowing detection requests to
// await the same promise instead of failing during model compilation.
getDetectorModel().catch(() => {});

function createPlanarRgbInput(imageData) {
	const width = imageData.width;
	const height = imageData.height;
	const channelSize = width * height;
	const rgbData = new Float32Array(channelSize * 3);
	for (let i = 0; i < channelSize; i++) {
		rgbData[i] = imageData.data[i * 4] / 255.0;                 // R channel
		rgbData[channelSize + i] = imageData.data[i * 4 + 1] / 255.0;   // G channel
		rgbData[channelSize * 2 + i] = imageData.data[i * 4 + 2] / 255.0; // B channel
	}
	return rgbData;
}

function createU2NetInput(imageData) {
	const width = imageData.width;
	const height = imageData.height;
	const channelSize = width * height;
	const rgbData = new Float32Array(channelSize * 3);
	const means = [0.485, 0.456, 0.406];
	const deviations = [0.229, 0.224, 0.225];
	for (let i = 0; i < channelSize; i++) {
		for (let channel = 0; channel < 3; channel++) {
			rgbData[channel * channelSize + i] = (imageData.data[i * 4 + channel] / 255 - means[channel]) / deviations[channel];
		}
	}
	return rgbData;
}

// Perform local object detection on an image URL
async function runDetection(imageUrl, modelId = 'yolov8n-coco-legacy') {
	const requestStart = performance.now();
	const model = await getSelectedDetectorModel(modelId);
	const modelReadyAt = performance.now();
	const isArthropod = modelId === 'arthropod-yolo11n';
	const isMegaDetector = modelId === 'megadetector-v6-compact';
	const isU2Net = modelId === 'u2netp-saliency';
	let bitmap = null;
	let inputTensor = null;
	let hostOutputTensors = [];

	try {
		// Fetch image as blob
		const response = await fetch(imageUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch image for detection (HTTP ${response.status})`);
		}
		const blob = await response.blob();

		const inputDetails = model.getInputDetails()[0];
		const [, channels, height, width] = Array.from(inputDetails.shape); // BCHW
		if (channels !== 3) {
			throw new Error(`Unexpected object-localizer channel count: ${channels}`);
		}

		bitmap = await createImageBitmap(blob);
		const imageReadyAt = performance.now();
		
		// Proportional letterboxing resize
		const srcWidth = bitmap.width;
		const srcHeight = bitmap.height;
		const scale = Math.min(width / srcWidth, height / srcHeight);
		const newWidth = isU2Net ? width : Math.floor(srcWidth * scale);
		const newHeight = isU2Net ? height : Math.floor(srcHeight * scale);
		const dx = Math.floor((width - newWidth) / 2);
		const dy = Math.floor((height - newHeight) / 2);

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Could not create an image canvas for smart crop.');
		
		// Fill background with black (standard padding color for YOLO/SSD models)
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(bitmap, dx, dy, newWidth, newHeight);

		const imageData = ctx.getImageData(0, 0, width, height);
		const rgbData = isU2Net ? createU2NetInput(imageData) : createPlanarRgbInput(imageData);
		inputTensor = new LiteRT.Tensor(rgbData, [1, 3, height, width]);
		const inferenceStartedAt = performance.now();

		console.log(`[iNat Enhancement Suite] Running on-device object localization (${modelId})...`);
		const results = await model.run(inputTensor);
		if (!Array.isArray(results) || results.length !== 1) {
			throw new Error(`Object localizer returned ${Array.isArray(results) ? results.length : 'non-array'} outputs instead of 1.`);
		}

		hostOutputTensors = await Promise.all(results.map(tensor => tensor.moveTo('wasm')));
		const array = hostOutputTensors[0].toTypedArray();
		const inferenceFinishedAt = performance.now();

		let bestBox = null;
		let bestSpecificBox = null;
		let maxScore = 0.25; // Confidence threshold
		let maxSpecificScore = 0.25;

		if (isU2Net) {
			bestBox = iNatDetectorPostprocess.saliencyMaskToBox(array, width, height, {
				threshold: 0.3,
				padding: 0.1,
				minimumArea: 16
			});
			if (bestBox) maxScore = bestBox.score;
		} else if (isMegaDetector) {
			// YOLOv10 end-to-end output: 300 pixel-space rows of
			// [xmin, ymin, xmax, ymax, score, class]. Class 0 is animal.
			for (let row = 0; row < 300; row++) {
				const offset = row * 6;
				const confidence = array[offset + 4];
				const classId = Math.round(array[offset + 5]);
				if (classId !== 0 || confidence <= 0.25) continue;
				const xmin = Math.max(0, Math.min(1, (array[offset] - dx) / newWidth));
				const ymin = Math.max(0, Math.min(1, (array[offset + 1] - dy) / newHeight));
				const xmax = Math.max(0, Math.min(1, (array[offset + 2] - dx) / newWidth));
				const ymax = Math.max(0, Math.min(1, (array[offset + 3] - dy) / newHeight));
				if (xmax <= xmin || ymax <= ymin) continue;
				const box = { ymin, xmin, ymax, xmax, score: confidence, classId, className: 'animal' };
				if (confidence > maxScore) { maxScore = confidence; bestBox = box; }
				const isFullFrame = (xmax - xmin) > 0.85 && (ymax - ymin) > 0.85;
				if (!isFullFrame && confidence > maxSpecificScore) {
					maxSpecificScore = confidence;
					bestSpecificBox = box;
				}
			}
		} else {
			const outputShape = Array.from(model.getOutputDetails()[0].shape);
			const numClasses = isArthropod ? 1 : 80;
			const numBoxes = isArthropod ? outputShape[2] : 756;
			// Parse raw channel-major YOLO output. The legacy branch intentionally
			// retains its established score transform and selection behavior.
			for (let b = 0; b < numBoxes; b++) {
				let maxClassScore = -Infinity;
				let maxClassId = -1;
				for (let c = 0; c < numClasses; c++) {
					const scoreIdx = (4 + c) * numBoxes + b;
					const score = array[scoreIdx];
					if (score > maxClassScore) {
						maxClassScore = score;
						maxClassId = c;
					}
				}

				// Preserve the legacy decoder exactly; current Ultralytics LiteRT exports
				// already contain post-sigmoid class probabilities.
				const confidence = isArthropod ? maxClassScore : 1 / (1 + Math.exp(-maxClassScore));
				if (confidence > 0.25) {
					const x_center = array[0 * numBoxes + b];
					const y_center = array[1 * numBoxes + b];

					// Filter out boxes whose centers lie outside the active region (inside the black padding)
					const x_center_px = x_center * width;
					const y_center_px = y_center * height;
					if (x_center_px < dx || x_center_px >= dx + newWidth || y_center_px < dy || y_center_px >= dy + newHeight) {
						continue;
					}

					const w = array[2 * numBoxes + b];
					const h = array[3 * numBoxes + b];

					// Map normalized bounds (relative to target square) back to original dimensions
					const mapBackX = (val) => {
						const valPixels = val * width;
						const activePixels = valPixels - dx;
						return Math.max(0, Math.min(1, activePixels / newWidth));
					};
					const mapBackY = (val) => {
						const valPixels = val * height;
						const activePixels = valPixels - dy;
						return Math.max(0, Math.min(1, activePixels / newHeight));
					};

					const ymin = mapBackY(y_center - h / 2);
					const xmin = mapBackX(x_center - w / 2);
					const ymax = mapBackY(y_center + h / 2);
					const xmax = mapBackX(x_center + w / 2);

					if (xmax > xmin && ymax > ymin) {
						const className = isArthropod ? 'Arthropod' : COCO_CLASSES[maxClassId] || 'subject';
						const box = { ymin, xmin, ymax, xmax, score: confidence, classId: maxClassId, className };

						if (confidence > maxScore) {
							maxScore = confidence;
							bestBox = box;
						}

						const isFullFrame = (xmax - xmin) > 0.85 && (ymax - ymin) > 0.85;
						if (!isFullFrame && confidence > maxSpecificScore) {
							maxSpecificScore = confidence;
							bestSpecificBox = box;
						}
					}
				}
			}
		}

		if (bestBox && (bestBox.xmax - bestBox.xmin) > 0.85 && (bestBox.ymax - bestBox.ymin) > 0.85) {
			if (bestSpecificBox) {
				console.log(`[iNat Enhancement Suite] Overriding full-frame box (Class ${bestBox.classId}, ${(bestBox.score*100).toFixed(0)}%) with smaller localized subject (Class ${bestSpecificBox.classId}, ${(bestSpecificBox.score*100).toFixed(0)}%)`);
				bestBox = bestSpecificBox;
			}
		}

		const finishedAt = performance.now();
		const timingBreakdown = {
			model_setup_ms: modelReadyAt - requestStart,
			image_fetch_decode_ms: imageReadyAt - modelReadyAt,
			preprocess_ms: inferenceStartedAt - imageReadyAt,
			inference_ms: inferenceFinishedAt - inferenceStartedAt,
			postprocess_ms: finishedAt - inferenceFinishedAt,
			pipeline_ms: finishedAt - modelReadyAt,
			background_total_ms: finishedAt - requestStart
		};
		if (bestBox) {
			console.log(`[iNat Enhancement Suite] Localized target subject (class ${bestBox.classId}) with confidence ${(maxScore * 100).toFixed(1)}% at:`, bestBox);
		} else {
			console.log('[iNat Enhancement Suite] No clear foreground object was localized above the confidence threshold.');
		}

		return { box: bestBox, pipelineDurationMs: timingBreakdown.pipeline_ms, timingBreakdown };
	} finally {
		for (const tensor of hostOutputTensors) {
			if (tensor && !tensor.deleted) tensor.delete();
		}
		if (inputTensor && !inputTensor.deleted) inputTensor.delete();
		if (bitmap) bitmap.close();
	}
}

let cropJobQueue = Promise.resolve();
const activeCropJobs = new Set();

async function readCropJobs() {
	const result = await storageGet(CROP_DATASET_JOBS_KEY);
	return Array.isArray(result[CROP_DATASET_JOBS_KEY]) ? result[CROP_DATASET_JOBS_KEY] : [];
}

async function writeCropJobs(jobs) {
	await storageSet({ [CROP_DATASET_JOBS_KEY]: jobs.slice(-20) });
}

async function updateCropJob(jobId, changes) {
	const jobs = await readCropJobs();
	const index = jobs.findIndex(job => job.job_id === jobId);
	if (index < 0) return null;
	jobs[index] = { ...jobs[index], ...changes, updated_at: new Date().toISOString() };
	await writeCropJobs(jobs);
	return jobs[index];
}

async function upsertDatasetRecord(record) {
	const result = await storageGet(CROP_DATASET_STORAGE_KEY);
	const records = Array.isArray(result[CROP_DATASET_STORAGE_KEY]) ? result[CROP_DATASET_STORAGE_KEY] : [];
	const index = records.findIndex(item => item.annotation_id === record.annotation_id);
	const existing = index >= 0 ? records[index] : null;
	const prepared = {
		...(existing || {}),
		...record,
		schema_version: 1,
		created_at: existing?.created_at || record.created_at || new Date().toISOString(),
		updated_at: record.updated_at || new Date().toISOString()
	};
	if (index >= 0) records[index] = prepared; else records.push(prepared);
	await storageSet({ [CROP_DATASET_STORAGE_KEY]: records });
	return prepared;
}

function scheduleCropJobRecovery() {
	if (!chrome.alarms) return;
	chrome.alarms.create(CROP_DATASET_ALARM, { delayInMinutes: 1 });
}

async function detectorRunForJob(model, imageUrl) {
	const startedAt = performance.now();
	try {
		const result = await runDetection(imageUrl, model.id);
		const box = result.box ? {
			xmin: result.box.xmin, ymin: result.box.ymin,
			xmax: result.box.xmax, ymax: result.box.ymax
		} : null;
		return {
			model_id: model.id,
			model_name: model.name,
			model_version: model.version,
			status: box ? 'detected' : 'no_detection',
			box,
			score: Number.isFinite(result.box?.score) ? result.box.score : null,
			class_id: result.box?.classId ?? null,
			class_name: result.box?.className || null,
			error: null,
			duration_ms: performance.now() - startedAt,
			pipeline_duration_ms: Number.isFinite(result.pipelineDurationMs) ? result.pipelineDurationMs : null,
			timing_breakdown: result.timingBreakdown || null,
			run_at: new Date().toISOString(),
			iou_to_human: null
		};
	} catch (error) {
		return {
			model_id: model.id,
			model_name: model.name,
			model_version: model.version,
			status: 'failed', box: null, score: null, class_id: null, class_name: null,
			error: error.message, duration_ms: performance.now() - startedAt,
			pipeline_duration_ms: null, timing_breakdown: null,
			run_at: new Date().toISOString(), iou_to_human: null
		};
	}
}

async function syncCompletedCropRecord(record) {
	try {
		const repaired = await repairCropAnnotationPhoto(record);
		const result = await callCropCollector('/annotations', { method: 'POST', body: repaired });
		return {
			...repaired,
			sync_status: 'synced',
			synced_at: result.synced_at || new Date().toISOString(),
			sync_error: null
		};
	} catch (error) {
		return { ...record, sync_status: 'pending', sync_error: error.message };
	}
}

async function processCropJob(jobId) {
	if (activeCropJobs.has(jobId)) return;
	activeCropJobs.add(jobId);
	try {
		let job = (await readCropJobs()).find(candidate => candidate.job_id === jobId);
		if (!job || job.status === 'completed') return;
		job = await updateCropJob(jobId, { status: 'running', started_at: job.started_at || new Date().toISOString(), error: null });
		let modelRuns = Array.isArray(job.model_runs) ? [...job.model_runs] : [];
		for (const model of CROP_JOB_MODELS) {
			if (modelRuns.some(run => run.model_id === model.id)) continue;
			await updateCropJob(jobId, { status: 'running', current_model_id: model.id, model_runs: modelRuns });
			const run = await detectorRunForJob(model, job.draft.photo_url);
			modelRuns.push(run);
			await updateCropJob(jobId, { model_runs: modelRuns, completed_models: modelRuns.length });
			scheduleCropJobRecovery();
		}
		let record = iNatCropJob.finalizeRecord(job.draft, modelRuns);
		record = await upsertDatasetRecord({ ...record, sync_background_job_status: 'syncing', sync_status: 'pending' });
		record = await syncCompletedCropRecord(record);
		await upsertDatasetRecord({ ...record, sync_background_job_status: 'completed', sync_background_job_completed_at: new Date().toISOString() });
		await updateCropJob(jobId, { status: 'completed', current_model_id: null, model_runs: record.model_runs, completed_at: new Date().toISOString(), error: null });
	} catch (error) {
		console.error('[iNat Enhancement Suite] Background crop dataset job failed:', error);
		await updateCropJob(jobId, { status: 'failed', current_model_id: null, error: error.message, failed_at: new Date().toISOString() }).catch(() => {});
		const job = (await readCropJobs()).find(candidate => candidate.job_id === jobId);
		if (job?.draft) {
			const pending = iNatCropJob.finalizeRecord(job.draft, job.model_runs || [], { forcePending: true });
			await upsertDatasetRecord({ ...pending, sync_background_job_status: 'failed', sync_background_job_error: error.message, sync_status: 'pending' }).catch(() => {});
		}
	} finally {
		activeCropJobs.delete(jobId);
		const unfinished = (await readCropJobs()).some(job => job.status === 'queued' || job.status === 'running');
		if (!unfinished && chrome.alarms) chrome.alarms.clear(CROP_DATASET_ALARM);
	}
}

function queueCropJob(jobId) {
	cropJobQueue = cropJobQueue.then(() => processCropJob(jobId), () => processCropJob(jobId));
	return cropJobQueue;
}

async function enqueueCropJob(payload) {
	if (!payload?.draft?.annotation_id || !payload.draft.photo_url || !payload.draft.final_box) throw new Error('Crop dataset job is missing its saved crop metadata');
	const now = new Date().toISOString();
	const jobId = `${payload.draft.annotation_id}:${Date.now()}`;
	const job = {
		job_id: jobId,
		annotation_id: payload.draft.annotation_id,
		status: 'queued',
		draft: payload.draft,
		model_runs: Array.isArray(payload.model_runs) ? payload.model_runs : [],
		completed_models: Array.isArray(payload.model_runs) ? payload.model_runs.length : 0,
		created_at: now,
		updated_at: now
	};
	const jobs = await readCropJobs();
	jobs.push(job);
	await writeCropJobs(jobs);
	const pending = iNatCropJob.finalizeRecord(job.draft, job.model_runs, { forcePending: true });
	await upsertDatasetRecord({ ...pending, sync_background_job_status: 'queued', sync_background_job_id: jobId, sync_status: 'pending' });
	scheduleCropJobRecovery();
	queueCropJob(jobId).catch(() => {});
	return { jobId, annotationId: job.annotation_id };
}

async function resumeCropJobs() {
	const jobs = await readCropJobs();
	for (const job of jobs.filter(candidate => candidate.status === 'queued' || candidate.status === 'running')) queueCropJob(job.job_id).catch(() => {});
}

if (chrome.alarms) {
	chrome.alarms.onAlarm.addListener(alarm => {
		if (alarm.name === CROP_DATASET_ALARM) resumeCropJobs().catch(error => console.error('[iNat Enhancement Suite] Could not resume crop jobs:', error));
	});
}
chrome.runtime.onStartup.addListener(() => resumeCropJobs().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => resumeCropJobs().catch(() => {}));
resumeCropJobs().catch(() => {});

// Runtime message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === 'enqueueCropDatasetJob') {
		enqueueCropJob(request.payload)
			.then(result => sendResponse({ success: true, ...result }))
			.catch(error => sendResponse({ success: false, error: error.message }));
		return true;
	}
	if (request.action === 'cropDatasetJobStatus') {
		readCropJobs()
			.then(jobs => sendResponse({ success: true, jobs }))
			.catch(error => sendResponse({ success: false, error: error.message }));
		return true;
	}
	if (request.action === 'syncCropAnnotation') {
		repairCropAnnotationPhoto(request.record)
			.then(record => callCropCollector('/annotations', { method: 'POST', body: record })
				.then(result => sendResponse({ success: true, ...result, photo_url: record.photo_url, photo_id: record.photo_id })))
			.catch(error => sendResponse({ success: false, error: error.message }));
		return true;
	}
	if (request.action === 'cropCollectorHealth') {
		callCropCollector('/health')
			.then(result => sendResponse({ success: true, ...result }))
			.catch(error => sendResponse({ success: false, error: error.message }));
		return true;
	}
	if (request.action === 'fetchImage') {
		fetchImageAsDataUrl(request.url)
			.then(dataUrl => sendResponse({ success: true, dataUrl }))
			.catch(error => sendResponse({ success: false, error: error.message }));
		return true; // Keep channel open for async response
	}

	if (request.action === 'detectSubject') {
		if (request.modelId && !['yolov8n-coco-legacy', 'megadetector-v6-compact', 'u2netp-saliency', 'arthropod-yolo11n'].includes(request.modelId)) {
			sendResponse({ success: false, error: `Crop model is not installed: ${request.modelId}` });
			return false;
		}
		runDetection(request.imageUrl, request.modelId)
			.then(result => sendResponse({
				success: true,
				box: result.box,
				pipelineDurationMs: result.pipelineDurationMs,
				timingBreakdown: result.timingBreakdown
			}))
			.catch(error => {
				console.error('[iNat Enhancement Suite] Smart-crop inference failed:', error);
				sendResponse({ success: false, error: error.message });
			});
		return true; // Keep channel open for async response
	}
});

async function fetchImageAsDataUrl(url) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 20000);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const blob = await response.blob();
		return await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = () => reject(new Error('Failed to read image data'));
			reader.readAsDataURL(blob);
		});
	} catch (error) {
		if (error.name === 'AbortError') throw new Error('Image download timed out after 20 seconds');
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}
