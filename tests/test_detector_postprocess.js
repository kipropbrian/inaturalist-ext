import '../iNaturalist Enhancement Suite/detector-postprocess.js';

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const mask = new Float32Array(10 * 10);
for (let y = 2; y <= 5; y++) {
	for (let x = 3; x <= 7; x++) mask[y * 10 + x] = 0.9;
}
mask[0] = 1; // A brighter isolated pixel must not beat the largest component.
const box = globalThis.iNatDetectorPostprocess.saliencyMaskToBox(mask, 10, 10, {
	threshold: 0.5,
	padding: 0,
	minimumArea: 2
});
assert(box, 'Expected a saliency box');
assert(Math.abs(box.xmin - 0.3) < 1e-8, `Unexpected xmin ${box.xmin}`);
assert(Math.abs(box.ymin - 0.2) < 1e-8, `Unexpected ymin ${box.ymin}`);
assert(Math.abs(box.xmax - 0.8) < 1e-8, `Unexpected xmax ${box.xmax}`);
assert(Math.abs(box.ymax - 0.6) < 1e-8, `Unexpected ymax ${box.ymax}`);
console.log('Success! Detector postprocessing tests passed.');
