import assert from 'node:assert/strict';

await import('../iNaturalist Enhancement Suite/crop-job.js');

const jobs = globalThis.iNatCropJob;
const draft = {
	annotation_id: '123:456',
	photo_id: '456',
	photo_url: 'https://example.org/photos/456/original.jpg',
	original_width: 1000,
	original_height: 800,
	final_box: { xmin: 0.2, ymin: 0.2, xmax: 0.8, ymax: 0.8 },
	active_model_at_save: 'u2netp-saliency',
	auto_verify_requested: true,
	taxon_id: '1',
	iconic_taxon: 'Insecta'
};

const partial = jobs.finalizeRecord(draft, [{
	model_id: 'u2netp-saliency', status: 'detected',
	box: { xmin: 0.2, ymin: 0.2, xmax: 0.8, ymax: 0.8 }, score: 0.9
}], { forcePending: true });
assert.equal(partial.review_status, 'pending', 'queued jobs must remain pending');
assert.ok(partial.validation_issues.includes('incomplete_model_benchmark'));

const completeRuns = jobs.MODEL_IDS.map(model_id => ({
	model_id, status: 'detected',
	box: { xmin: 0.2, ymin: 0.2, xmax: 0.8, ymax: 0.8 }, score: 0.9
}));
const complete = jobs.finalizeRecord(draft, completeRuns);
assert.equal(complete.review_status, 'verified', 'a clean completed automatic job may verify');
assert.equal(complete.auto_verify_eligible, true);
assert.equal(complete.model_runs.every(run => run.iou_to_human === 1), true);
assert.equal('auto_verify_requested' in complete, false, 'internal job fields must not enter the dataset');

const failedRuns = completeRuns.map((run, index) => index ? run : { ...run, status: 'failed', box: null });
const failed = jobs.finalizeRecord(draft, failedRuns);
assert.equal(failed.review_status, 'pending', 'detector runtime failures must never auto-verify');
assert.ok(failed.validation_issues.includes('detector_runtime_issue'));

console.log('Success! Background crop job tests passed.');
