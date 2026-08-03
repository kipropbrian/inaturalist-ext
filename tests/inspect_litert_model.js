// Compile a candidate .tflite model with the extension's exact LiteRT.js WASM
// runtime and run one zero-input inference. This is a conversion gate, not a
// crop-quality benchmark.
import fs from 'fs';
import { createRequire } from 'module';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import jpeg from 'jpeg-js';
import '../iNaturalist Enhancement Suite/detector-postprocess.js';

globalThis.require = createRequire(import.meta.url);
globalThis.__filename = fileURLToPath(import.meta.url);
globalThis.__dirname = dirname(globalThis.__filename);
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' };

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...args) => {
	const value = url.toString();
	if (!value.startsWith('file://')) return originalFetch(url, ...args);
	const data = fs.readFileSync(fileURLToPath(value));
	return {
		ok: true,
		status: 200,
		url: value,
		arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
		blob: async () => new Blob([data])
	};
};

async function main() {
	const requested = process.argv[2];
	if (!requested) throw new Error('Usage: node tests/inspect_litert_model.js MODEL.tflite');
	const modelFile = isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
	const extensionRoot = join(globalThis.__dirname, '..', 'iNaturalist Enhancement Suite');
	const wasmDir = join(extensionRoot, 'lib', 'litert', 'wasm');
	let liteRtCode = fs.readFileSync(join(extensionRoot, 'lib', 'litert', 'litert.js'), 'utf8');
	// Preserve the compatibility shim used by the established regression harness.
	liteRtCode = liteRtCode.replace('function getDataType(val) {', 'function getDataType(val) { if (val === 0) { val = 1; }');
	eval(liteRtCode + '\nglobalThis.LiteRT = LiteRT;');
	globalThis.Module = { locateFile: path => join(wasmDir, path) };
	const loader = fs.readFileSync(join(wasmDir, 'litert_wasm_internal.js'), 'utf8');
	eval(loader + '\nglobalThis.StandardModuleFactory = ModuleFactory;');
	globalThis.ModuleFactory = undefined;

	await globalThis.LiteRT.loadLiteRt(wasmDir);
	const compiled = await globalThis.LiteRT.loadAndCompile(`file://${modelFile}`, { accelerator: 'wasm' });
	const inputs = compiled.getInputDetails();
	const outputs = compiled.getOutputDetails();
	if (inputs.length !== 1) throw new Error(`Inspector supports one input; model has ${inputs.length}`);
	const shape = Array.from(inputs[0].shape);
	const primaryOutputShape = Array.from(outputs[0]?.shape || []);
	const isSaliency = primaryOutputShape.length === 4 && primaryOutputShape[1] === 1;
	const elements = shape.reduce((product, value) => product * value, 1);
	let inputValues = new Float32Array(elements);
	const sampleFile = process.argv[3] ? resolve(process.cwd(), process.argv[3]) : null;
	if (sampleFile) {
		const decoded = jpeg.decode(fs.readFileSync(sampleFile));
		const [, channels, height, width] = shape;
		if (channels !== 3) throw new Error(`Sample preparation expects BCHW RGB input; got ${shape}`);
		const scale = Math.min(width / decoded.width, height / decoded.height);
		const resizedWidth = isSaliency ? width : Math.floor(decoded.width * scale);
		const resizedHeight = isSaliency ? height : Math.floor(decoded.height * scale);
		const dx = Math.floor((width - resizedWidth) / 2);
		const dy = Math.floor((height - resizedHeight) / 2);
		const channelSize = width * height;
		for (let y = 0; y < resizedHeight; y++) {
			for (let x = 0; x < resizedWidth; x++) {
				const sourceX = Math.floor(x * decoded.width / resizedWidth);
				const sourceY = Math.floor(y * decoded.height / resizedHeight);
				const source = (sourceY * decoded.width + sourceX) * 4;
				const destination = (y + dy) * width + x + dx;
				const red = decoded.data[source] / 255;
				const green = decoded.data[source + 1] / 255;
				const blue = decoded.data[source + 2] / 255;
				inputValues[destination] = isSaliency ? (red - 0.485) / 0.229 : red;
				inputValues[channelSize + destination] = isSaliency ? (green - 0.456) / 0.224 : green;
				inputValues[channelSize * 2 + destination] = isSaliency ? (blue - 0.406) / 0.225 : blue;
			}
		}
	}
	const input = new globalThis.LiteRT.Tensor(inputValues, shape);
	const results = await compiled.run(input);
	const observedOutputs = [];
	let sampleTopCandidate = null;
	let saliencyCandidates = null;
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		const host = await result.moveTo('wasm');
		const values = host.toTypedArray();
		const outputShape = Array.from(outputs[index]?.shape || []);
		let minimum = Infinity;
		let maximum = -Infinity;
		for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
		observedOutputs.push({ shape: outputShape, elements: values.length, minimum, maximum });
		if (sampleFile && outputShape.length === 4 && outputShape[1] === 1) {
			saliencyCandidates = {};
			for (const threshold of [0.2, 0.3, 0.4, 0.5]) {
				saliencyCandidates[threshold] = globalThis.iNatDetectorPostprocess.saliencyMaskToBox(
					values,
					outputShape[3],
					outputShape[2],
					{ threshold, padding: 0.05, minimumArea: 1 }
				);
			}
			sampleTopCandidate = globalThis.iNatDetectorPostprocess.saliencyMaskToBox(
				values,
				outputShape[3],
				outputShape[2],
				{ threshold: 0.3, padding: 0.1, minimumArea: 16 }
			);
		} else if (sampleFile && outputShape.length === 3 && outputShape[2] === 6) {
			const rows = outputShape[1];
			let score = -Infinity;
			let rowIndex = -1;
			for (let row = 0; row < rows; row++) {
				if (values[row * 6 + 4] > score) { score = values[row * 6 + 4]; rowIndex = row; }
			}
			sampleTopCandidate = {
				xyxy: [0, 1, 2, 3].map(column => values[rowIndex * 6 + column]),
				score,
				class_id: values[rowIndex * 6 + 5],
				row_index: rowIndex
			};
		} else if (sampleFile && outputShape.length === 3 && outputShape[1] >= 5) {
			const channels = outputShape[1];
			const boxes = outputShape[2];
			let score = -Infinity;
			let boxIndex = -1;
			let classId = -1;
			for (let candidate = 0; candidate < boxes; candidate++) {
				for (let classIndex = 0; classIndex < channels - 4; classIndex++) {
					const value = values[(4 + classIndex) * boxes + candidate];
					if (value > score) { score = value; boxIndex = candidate; classId = classIndex; }
				}
			}
			sampleTopCandidate = {
				xywh: [0, 1, 2, 3].map(channel => values[channel * boxes + boxIndex]),
				score,
				class_id: classId,
				box_index: boxIndex
			};
		}
		host.delete();
	}
	input.delete();
	console.log(JSON.stringify({
		model: modelFile,
		bytes: fs.statSync(modelFile).size,
		inputs: inputs.map(detail => ({ name: detail.name, dtype: detail.dtype, shape: Array.from(detail.shape) })),
		outputs: outputs.map(detail => ({ name: detail.name, dtype: detail.dtype, shape: Array.from(detail.shape) })),
		observed_outputs: observedOutputs,
		sample: sampleFile,
		sample_top_candidate: sampleTopCandidate,
		saliency_candidates: saliencyCandidates
	}, null, 2));
	if (sampleFile && !sampleTopCandidate) throw new Error(`Model produced no usable candidate for ${sampleFile}`);
}

main().catch(error => {
	console.error(error.stack || error.message);
	process.exit(1);
});
