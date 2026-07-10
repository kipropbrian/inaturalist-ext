// Background script for handling cross-origin image requests and local machine learning inference

// Load the standard WASM loader and save its factory
importScripts('./lib/litert/wasm/litert_wasm_internal.js');
self.StandardModuleFactory = ModuleFactory;

// Load the compat WASM loader and save its factory
importScripts('./lib/litert/wasm/litert_wasm_compat_internal.js');
self.CompatModuleFactory = ModuleFactory;

// Clean up the global ModuleFactory variable to prevent polluting
self.ModuleFactory = undefined;

// Load the main LiteRT library
importScripts('./lib/litert/litert.js');

let compiledModel = null;

// Initialize LiteRT.js and load the EfficientDet-Lite0 model at top-level startup
// This avoids top-level await and dynamic importScripts calls inside async contexts (blocked in MV3).
console.log('[iNat Enhancement Suite] Initializing LiteRT.js runtime at startup...');
const startTime = performance.now();
try {
	// Point to the directory containing local WASM files
	const wasmDir = chrome.runtime.getURL('lib/litert/wasm/');
	const modelPath = chrome.runtime.getURL('lib/litert/models/efficientdet_lite0.tflite');

	// Define self.Module to override locateFile for the WASM files.
	// This ensures locateFile maps to the correct folder inside the extension.
	self.Module = {
		locateFile: (path) => {
			return chrome.runtime.getURL('lib/litert/wasm/' + path);
		}
	};

	LiteRT.loadLiteRt(wasmDir)
		.then(() => {
			console.log('[iNat Enhancement Suite] LiteRT.js runtime loaded successfully.');
			console.log('[iNat Enhancement Suite] Compiling EfficientDet-Lite0 model from:', modelPath);
			return LiteRT.loadAndCompile(modelPath);
		})
		.then(model => {
			compiledModel = model;
			const duration = (performance.now() - startTime).toFixed(1);
			console.log(`[iNat Enhancement Suite] EfficientDet-Lite0 model compiled successfully in ${duration}ms.`);
		})
		.catch(error => {
			console.error('[iNat Enhancement Suite] Failed to initialize LiteRT detector at startup:', error);
		});
} catch (error) {
	console.error('[iNat Enhancement Suite] Exception during LiteRT detector initialization:', error);
}

// Perform local object detection on an image URL
async function runDetection(imageUrl) {
	if (!compiledModel) {
		throw new Error('LiteRT detector model is not initialized yet.');
	}

	const startTime = performance.now();
	// Fetch image as blob
	const response = await fetch(imageUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch image for detection (HTTP ${response.status})`);
	}
	const blob = await response.blob();

	// Load image into bitmap and draw onto OffscreenCanvas for resizing
	const bitmap = await createImageBitmap(blob);
	const width = 320;
	const height = 320;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	ctx.drawImage(bitmap, 0, 0, width, height);

	// Extract RGB pixel data (ignore alpha channel)
	const imgData = ctx.getImageData(0, 0, width, height);
	const rgbData = new Uint8Array(width * height * 3);
	let dstIdx = 0;
	for (let srcIdx = 0; srcIdx < imgData.data.length; srcIdx += 4) {
		rgbData[dstIdx++] = imgData.data[srcIdx];     // R
		rgbData[dstIdx++] = imgData.data[srcIdx + 1]; // G
		rgbData[dstIdx++] = imgData.data[srcIdx + 2]; // B
	}

	// Create input tensor [1, 320, 320, 3]
	const inputTensor = new LiteRT.Tensor(rgbData, [1, height, width, 3]);

	// Run inference
	console.log('[iNat Enhancement Suite] Running on-device object detection...');
	const results = await compiledModel.run(inputTensor);

	// Retrieve outputs from WASM memory
	// EfficientDet-Lite0 outputs:
	// results[0]: detection boxes [1, 25, 4] or [1, 100, 4]
	// results[1]: detection classes [1, 25] or [1, 100]
	// results[2]: detection scores [1, 25] or [1, 100]
	// results[3]: num detections [1]
	const boxesTensor = await results[0].moveTo('wasm');
	const classesTensor = await results[1].moveTo('wasm');
	const scoresTensor = await results[2].moveTo('wasm');
	const countTensor = await results[3].moveTo('wasm');

	const boxes = boxesTensor.toTypedArray();     // Float32Array of ymin, xmin, ymax, xmax
	const classes = classesTensor.toTypedArray(); // Float32Array/Int32Array of class IDs
	const scores = scoresTensor.toTypedArray();   // Float32Array of confidence scores
	const count = countTensor.toTypedArray()[0];   // Number of detections

	const inferenceDuration = (performance.now() - startTime).toFixed(1);
	console.log(`[iNat Enhancement Suite] Local inference complete in ${inferenceDuration}ms. Found ${count} candidate objects.`);

	// Free up temporary output tensors
	boxesTensor.delete();
	classesTensor.delete();
	scoresTensor.delete();
	countTensor.delete();
	inputTensor.delete();

	// Scan detections for the highest confidence organism/subject box
	let bestBox = null;
	let maxScore = 0.25; // Minimum confidence threshold

	for (let i = 0; i < count; i++) {
		const score = scores[i];
		if (score > maxScore) {
			maxScore = score;
			const baseBoxIdx = i * 4;
			bestBox = {
				ymin: boxes[baseBoxIdx],
				xmin: boxes[baseBoxIdx + 1],
				ymax: boxes[baseBoxIdx + 2],
				xmax: boxes[baseBoxIdx + 3]
			};
		}
	}

	if (bestBox) {
		console.log(`[iNat Enhancement Suite] Detected target subject with confidence ${(maxScore * 100).toFixed(1)}% at:`, bestBox);
	} else {
		console.log('[iNat Enhancement Suite] No objects detected above the confidence threshold.');
	}

	return bestBox;
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
			.catch(error => sendResponse({ success: false, error: error.message }));
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
