import assert from 'node:assert/strict';

await import('../iNaturalist Enhancement Suite/crop-dataset.js');

const dataset = globalThis.iNatCropDataset;
assert.ok(dataset, 'dataset API should be exposed');

assert.deepEqual(
	dataset.normalizePixelBox({ x: 20, y: 10, width: 40, height: 20 }, 100, 50),
	{ xmin: 0.2, ymin: 0.2, xmax: 0.6, ymax: 0.6 },
	'pixel boxes should be normalized to the source image'
);

const acceptedModelBox = { xmin: 0.2004, ymin: 0.1996, xmax: 0.6004, ymax: 0.5996 };
assert.deepEqual(
	dataset.finalBoxForSave(
		{ x: 20, y: 10, width: 40, height: 20 },
		100,
		50,
		acceptedModelBox
	),
	acceptedModelBox,
	'an unchanged detector crop should retain its exact normalized coordinates'
);
assert.deepEqual(
	dataset.finalBoxForSave({ x: 20.25, y: 10.5, width: 40.5, height: 20.25 }, 100, 50),
	{ xmin: 0.2025, ymin: 0.21, xmax: 0.6075, ymax: 0.615 },
	'manually adjusted crops should retain subpixel precision'
);

const ladyBeetleU2NetBox = {
	xmin: 0.30593750000000003,
	ymin: 0.3309375,
	xmax: 0.5721875,
	ymax: 0.5221875
};
assert.equal(
	dataset.boxIoU(
		dataset.finalBoxForSave(
			{ x: 115, y: 165, width: 100, height: 96 },
			375,
			500,
			ladyBeetleU2NetBox
		),
		ladyBeetleU2NetBox
	),
	1,
	'an accepted lady-beetle detector box should not lose IoU through whole-pixel Cropper rounding'
);

assert.equal(dataset.boxIoU(
	{ xmin: 0, ymin: 0, xmax: 0.5, ymax: 0.5 },
	{ xmin: 0, ymin: 0, xmax: 0.5, ymax: 0.5 }
), 1, 'identical boxes should have IoU 1');

assert.equal(dataset.boxIoU(
	{ xmin: 0, ymin: 0, xmax: 0.2, ymax: 0.2 },
	{ xmin: 0.8, ymin: 0.8, xmax: 1, ymax: 1 }
), 0, 'disjoint boxes should have IoU 0');

const record = dataset.prepareRecord({
	observation_id: '123',
	photo_id: '456',
	final_box: { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.9 }
});
assert.equal(record.annotation_id, '123:456');
assert.equal(record.schema_version, 1);
assert.equal(record.review_status, 'pending');
assert.ok(record.created_at && record.updated_at);

await dataset.clear();
await dataset.put({
	observation_id: '123',
	photo_id: '456',
	photo_url: 'https://example.org/photos/456/large.jpg',
	original_width: 100,
	original_height: 50,
	final_box: { xmin: 0.2, ymin: 0.2, xmax: 0.6, ymax: 0.6 },
	final_box_source: 'visible_human_crop',
	model_runs: [{
		model_id: 'u2netp-saliency',
		status: 'detected',
		box: { xmin: 0.18, ymin: 0.18, xmax: 0.61, ymax: 0.61 },
		iou_to_human: 0.86,
		duration_ms: 412.5,
		pipeline_duration_ms: 389.2
	}]
});
assert.equal((await dataset.list()).length, 1, 'put and list should share the metadata store');
assert.equal((await dataset.get('123:456')).model_runs[0].model_id, 'u2netp-saliency', 'detector proposals should remain separate from the human box');
assert.equal((await dataset.get('123:456')).model_runs[0].duration_ms, 412.5, 'detector latency should be retained for benchmarking');
await dataset.update('123:456', { review_status: 'verified' });
assert.equal((await dataset.get('123:456')).review_status, 'verified', 'updates should persist');
const exported = JSON.parse(await dataset.exportJSON());
assert.equal(exported.annotations.length, 1, 'JSON backup should contain stored records');
await dataset.clear();
await dataset.importJSON(exported);
assert.equal((await dataset.stats()).verified, 1, 'JSON import should restore verified records');

console.log('Success! Crop dataset helper tests passed.');
