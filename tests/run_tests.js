import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import jpeg from 'jpeg-js';

globalThis.require = createRequire(import.meta.url);
globalThis.__filename = fileURLToPath(import.meta.url);
globalThis.__dirname = dirname(globalThis.__filename);

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'node' };
}
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

// Patch fetch to support file:// URLs in Node
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...args) => {
  const urlStr = url.toString();
  if (urlStr.startsWith('file://')) {
    const path = fileURLToPath(urlStr);
    const data = fs.readFileSync(path);
    return {
      ok: true,
      status: 200,
      url: urlStr,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      blob: async () => new Blob([data])
    };
  }
  return originalFetch(url, ...args);
};

// Define expected values for the 5 test cases
const TEST_CASES = [
  {
    name: 'Grasshopper #1 (Tall Frame)',
    path: join(globalThis.__dirname, 'images', 'grasshopper_1.jpg'),
    expectedClass: 14, // bird (mapped shape)
    expectedBounds: { ymin: 0.3266, xmin: 0.2438, ymax: 0.5684, xmax: 0.8347 }
  },
  {
    name: 'Grasshopper #2 (On Leaves)',
    path: join(globalThis.__dirname, 'images', 'grasshopper_2.jpg'),
    expectedClass: 58, // potted plant (background foliage)
    expectedBounds: { ymin: 0.0018, xmin: 0.0059, ymax: 0.6517, xmax: 1.0000 }
  },
  {
    name: 'Rat / Mouse (Horizontal Frame)',
    path: join(globalThis.__dirname, 'images', 'rat.jpg'),
    expectedClass: 14, // bird (mapped shape)
    expectedBounds: { ymin: 0.5533, xmin: 0.3859, ymax: 0.9641, xmax: 0.6862 }
  },
  {
    name: 'Test Organism #3 (Horizontal Frame)',
    path: join(globalThis.__dirname, 'images', 'organism_3.jpg'),
    expectedClass: 14, // bird
    expectedBounds: { ymin: 0.2567, xmin: 0.1302, ymax: 0.6167, xmax: 0.8872 }
  },
  {
    name: 'Test Organism #4 (Stick Insect)',
    path: join(globalThis.__dirname, 'images', 'organism_4.jpg'),
    expectedClass: 27, // tie
    expectedBounds: { ymin: 0.0178, xmin: 0.4660, ymax: 0.9956, xmax: 0.7498 }
  }
];

// Nearest neighbor letterbox resize to 192x192
function getLetterboxInput(decoded, targetW, targetH) {
  const scale = Math.min(targetW / decoded.width, targetH / decoded.height);
  const newW = Math.floor(decoded.width * scale);
  const newH = Math.floor(decoded.height * scale);
  const dx = Math.floor((targetW - newW) / 2);
  const dy = Math.floor((targetH - newH) / 2);

  const rgbData = new Uint8Array(targetW * targetH * 3);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      if (x >= dx && x < dx + newW && y >= dy && y < dy + newH) {
        const srcX = Math.floor((x - dx) * decoded.width / newW);
        const srcY = Math.floor((y - dy) * decoded.height / newH);
        const srcIdx = (srcY * decoded.width + srcX) * 4;
        const dstIdx = (y * targetW + x) * 3;
        rgbData[dstIdx] = decoded.data[srcIdx];
        rgbData[dstIdx + 1] = decoded.data[srcIdx + 1];
        rgbData[dstIdx + 2] = decoded.data[srcIdx + 2];
      }
    }
  }
  return { rgbData, dx, dy, newW, newH };
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function runTest(model, Tensor, testCase) {
  console.log(`Running regression check for: ${testCase.name}...`);
  const buffer = fs.readFileSync(testCase.path);
  const decoded = jpeg.decode(buffer);
  
  const { rgbData, dx, dy, newW, newH } = getLetterboxInput(decoded, 192, 192);
  
  const floatData = new Float32Array(rgbData.length);
  const channelSize = 192 * 192;
  for (let i = 0; i < channelSize; i++) {
    floatData[i] = rgbData[i * 3] / 255.0;
    floatData[channelSize + i] = rgbData[i * 3 + 1] / 255.0;
    floatData[channelSize * 2 + i] = rgbData[i * 3 + 2] / 255.0;
  }
  
  const inputTensor = new Tensor(floatData, [1, 3, 192, 192]);
  const results = await model.run(inputTensor);
  const wasmTensor = await results[0].moveTo('wasm');
  const array = wasmTensor.toTypedArray();
  
  const numClasses = 80;
  const numBoxes = 756;
  
  let bestBox = null;
  let bestSpecificBox = null;
  let maxScore = 0.25;
  let maxSpecificScore = 0.25;
  
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
    
    const confidence = sigmoid(maxClassScore);
    if (confidence > 0.25) {
      const x_center = array[0 * numBoxes + b];
      const y_center = array[1 * numBoxes + b];
      
      const x_center_px = x_center * 192;
      const y_center_px = y_center * 192;
      if (x_center_px < dx || x_center_px >= dx + newW || y_center_px < dy || y_center_px >= dy + newH) {
        continue;
      }
      
      const w = array[2 * numBoxes + b];
      const h = array[3 * numBoxes + b];
      
      const mapBackX = (val) => {
        const valPixels = val * 192;
        const activePixels = valPixels - dx;
        return Math.max(0, Math.min(1, activePixels / newW));
      };
      
      const mapBackY = (val) => {
        const valPixels = val * 192;
        const activePixels = valPixels - dy;
        return Math.max(0, Math.min(1, activePixels / newH));
      };
      
      const ymin = mapBackY(y_center - h / 2);
      const xmin = mapBackX(x_center - w / 2);
      const ymax = mapBackY(y_center + h / 2);
      const xmax = mapBackX(x_center + w / 2);
      
      if (xmax > xmin && ymax > ymin) {
        const box = { ymin, xmin, ymax, xmax, score: confidence, classId: maxClassId };
        
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
  
  wasmTensor.delete();
  inputTensor.delete();

  let selectedBox = bestBox;
  if (bestBox && (bestBox.xmax - bestBox.xmin) > 0.85 && (bestBox.ymax - bestBox.ymin) > 0.85) {
    if (bestSpecificBox) {
      selectedBox = bestSpecificBox;
    }
  }

  if (!selectedBox) {
    throw new Error(`Expected detection box but found none.`);
  }

  // Assertion check (within 0.02 threshold)
  const threshold = 0.02;
  const checks = [
    { label: 'classId', got: selectedBox.classId, expected: testCase.expectedClass },
    { label: 'ymin', got: selectedBox.ymin, expected: testCase.expectedBounds.ymin },
    { label: 'xmin', got: selectedBox.xmin, expected: testCase.expectedBounds.xmin },
    { label: 'ymax', got: selectedBox.ymax, expected: testCase.expectedBounds.ymax },
    { label: 'xmax', got: selectedBox.xmax, expected: testCase.expectedBounds.xmax }
  ];

  for (const check of checks) {
    if (check.label === 'classId') {
      if (check.got !== check.expected) {
        throw new Error(`Assertion failed for ${check.label}: got ${check.got}, expected ${check.expected}`);
      }
    } else {
      const diff = Math.abs(check.got - check.expected);
      if (diff > threshold) {
        throw new Error(`Assertion failed for ${check.label}: got ${check.got.toFixed(4)}, expected ${check.expected.toFixed(4)} (diff ${diff.toFixed(4)} exceeds threshold ${threshold})`);
      }
    }
  }

  console.log(`✅ PASS: ${testCase.name} matches expected coordinates.`);
}

async function main() {
  let hasFailed = false;
  try {
    // Load litert.js
    const litertPath = join(globalThis.__dirname, '..', 'iNaturalist Enhancement Suite', 'lib', 'litert', 'litert.js');
    let litertCode = fs.readFileSync(litertPath, 'utf8');
    litertCode = litertCode.replace(
      'function getDataType(val) {',
      'function getDataType(val) { if (val === 0) { val = 1; }'
    );
    eval(litertCode + '\nglobalThis.LiteRT = LiteRT;');

    const { loadLiteRt, loadAndCompile, Tensor } = globalThis.LiteRT;
    const wasmDir = join(globalThis.__dirname, '..', 'iNaturalist Enhancement Suite', 'lib', 'litert', 'wasm/');
    
    globalThis.Module = {
      locateFile: (path) => join(wasmDir, path)
    };

    const wasmInternalCode = fs.readFileSync(join(wasmDir, 'litert_wasm_internal.js'), 'utf8');
    eval(wasmInternalCode + '\nglobalThis.StandardModuleFactory = ModuleFactory;');
    globalThis.ModuleFactory = undefined;

    await loadLiteRt(wasmDir);

    const modelPath = 'file://' + join(globalThis.__dirname, '..', 'iNaturalist Enhancement Suite', 'lib', 'litert', 'models', 'yolov8n.tflite');
    const model = await loadAndCompile(modelPath, { accelerator: 'wasm' });

    console.log(`Starting YOLOv8 smart-crop regression checks...\n`);
    for (const testCase of TEST_CASES) {
      await runTest(model, Tensor, testCase);
    }
    console.log(`\n🎉 Success! All automated smart-crop regression tests passed.`);
  } catch (error) {
    console.error(`\n❌ TEST SUITE FAILED:`, error.message);
    hasFailed = true;
  }
  process.exit(hasFailed ? 1 : 0);
}

main();
