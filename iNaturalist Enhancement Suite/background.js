// Background script for handling cross-origin image requests and local machine learning inference

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

let compiledModel = null;
let liteRtInitializationPromise = null;
let modelInitializationPromise = null;

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

// Perform local object detection on an image URL
async function runDetection(imageUrl) {
	const model = await getDetectorModel();
	const startTime = performance.now();
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
		
		// Proportional letterboxing resize
		const srcWidth = bitmap.width;
		const srcHeight = bitmap.height;
		const scale = Math.min(width / srcWidth, height / srcHeight);
		const newWidth = Math.floor(srcWidth * scale);
		const newHeight = Math.floor(srcHeight * scale);
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
		const rgbData = createPlanarRgbInput(imageData);
		inputTensor = new LiteRT.Tensor(rgbData, [1, 3, height, width]);

		console.log('[iNat Enhancement Suite] Running on-device object localization (YOLOv8n)...');
		const results = await model.run(inputTensor);
		if (!Array.isArray(results) || results.length !== 1) {
			throw new Error(`Object localizer returned ${Array.isArray(results) ? results.length : 'non-array'} outputs instead of 1.`);
		}

		hostOutputTensors = await Promise.all(results.map(tensor => tensor.moveTo('wasm')));
		const array = hostOutputTensors[0].toTypedArray();

		const numClasses = 80;
		const numBoxes = 756;
		let bestBox = null;
		let bestSpecificBox = null;
		let maxScore = 0.25; // Confidence threshold
		let maxSpecificScore = 0.25;

		// Parse the output shape [1, 84, 756]
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

			// Convert logit to confidence score
			const confidence = 1 / (1 + Math.exp(-maxClassScore));
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
					const box = { ymin, xmin, ymax, xmax, score: confidence, classId: maxClassId, className: COCO_CLASSES[maxClassId] || 'subject' };
					
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

		if (bestBox && (bestBox.xmax - bestBox.xmin) > 0.85 && (bestBox.ymax - bestBox.ymin) > 0.85) {
			if (bestSpecificBox) {
				console.log(`[iNat Enhancement Suite] Overriding full-frame box (Class ${bestBox.classId}, ${(bestBox.score*100).toFixed(0)}%) with smaller localized subject (Class ${bestSpecificBox.classId}, ${(bestSpecificBox.score*100).toFixed(0)}%)`);
				bestBox = bestSpecificBox;
			}
		}

		const inferenceDuration = (performance.now() - startTime).toFixed(1);
		if (bestBox) {
			console.log(`[iNat Enhancement Suite] Localized target subject (class ${bestBox.classId}) with confidence ${(maxScore * 100).toFixed(1)}% at:`, bestBox);
		} else {
			console.log('[iNat Enhancement Suite] No clear foreground object was localized above the confidence threshold.');
		}

		return bestBox;
	} finally {
		for (const tensor of hostOutputTensors) {
			if (tensor && !tensor.deleted) tensor.delete();
		}
		if (inputTensor && !inputTensor.deleted) inputTensor.delete();
		if (bitmap) bitmap.close();
	}
}

// Runtime message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === 'fetchImage') {
		fetchImageAsDataUrl(request.url)
			.then(dataUrl => sendResponse({ success: true, dataUrl }))
			.catch(error => sendResponse({ success: false, error: error.message }));
		return true; // Keep channel open for async response
	}

	if (request.action === 'detectSubject') {
		runDetection(request.imageUrl)
			.then(box => sendResponse({ success: true, box }))
			.catch(error => {
				console.error('[iNat Enhancement Suite] Smart-crop inference failed:', error);
				sendResponse({ success: false, error: error.message });
			});
		return true; // Keep channel open for async response
	}
});

async function fetchImageAsDataUrl(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	const blob = await response.blob();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error('Failed to read blob'));
		reader.readAsDataURL(blob);
	});
}
