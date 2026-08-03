// Pure helpers for background-owned crop dataset jobs.
(function initCropJobHelpers(global) {
	'use strict';

	const MODEL_IDS = Object.freeze([
		'yolov8n-coco-legacy',
		'megadetector-v6-compact',
		'u2netp-saliency',
		'arthropod-yolo11n'
	]);

	function boxIoU(a, b) {
		if (!a || !b) return null;
		const intersectionWidth = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin));
		const intersectionHeight = Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
		const intersection = intersectionWidth * intersectionHeight;
		const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
		const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
		const union = areaA + areaB - intersection;
		return union > 0 ? intersection / union : 0;
	}

	function validationIssues(record, modelRuns) {
		const issues = [];
		if (!record.photo_id) issues.push('missing_photo_id');
		if (!/^https:\/\//.test(String(record.photo_url || ''))) issues.push('missing_photo_url');
		if (!Number.isInteger(record.original_width) || record.original_width < 1 || !Number.isInteger(record.original_height) || record.original_height < 1) issues.push('invalid_image_dimensions');
		const box = record.final_box;
		const coordinates = box ? [box.xmin, box.ymin, box.xmax, box.ymax] : [];
		if (coordinates.length !== 4 || coordinates.some(value => !Number.isFinite(value) || value < 0 || value > 1) || box.xmax <= box.xmin || box.ymax <= box.ymin) issues.push('invalid_final_box');
		const attemptedModels = new Set(modelRuns.map(run => run.model_id));
		if (MODEL_IDS.some(modelId => !attemptedModels.has(modelId))) issues.push('incomplete_model_benchmark');
		if (modelRuns.some(run => run.status === 'failed' || run.status === 'timeout')) issues.push('detector_runtime_issue');
		return issues;
	}

	function priorityFlags(record, modelRuns) {
		const flags = [];
		const box = record.final_box;
		const area = box ? Math.max(0, box.xmax - box.xmin) * Math.max(0, box.ymax - box.ymin) : 0;
		if (area < 0.04) flags.push('small_subject');
		const detectedRuns = modelRuns.filter(run => run.box);
		if (!detectedRuns.length) flags.push('manual_from_scratch');
		if (modelRuns.some(run => run.status !== 'detected')) flags.push('model_failure');
		if (detectedRuns.some(run => run.iou_to_human != null && run.iou_to_human < 0.7)) flags.push('large_model_correction');
		if (detectedRuns.some(run => run.score != null && run.score < 0.5)) flags.push('low_model_confidence');
		if (!record.taxon_id && !record.taxon_name && !record.taxon_common_name) flags.push('unfamiliar_or_unidentified_taxon');
		if (record.iconic_taxon === 'Plantae') flags.push('plant');
		if (record.iconic_taxon === 'Fungi') flags.push('fungus');
		return flags;
	}

	function finalizeRecord(draft, rawRuns, { forcePending = false } = {}) {
		const modelRuns = rawRuns.map(run => ({
			...run,
			iou_to_human: run.box ? boxIoU(run.box, draft.final_box) : null
		}));
		const activeRun = modelRuns.find(run => run.model_id === draft.active_model_at_save) || null;
		const correctionIoU = activeRun?.iou_to_human ?? null;
		const issues = validationIssues(draft, modelRuns);
		const requestedAutoVerify = draft.auto_verify_requested === true;
		const eligible = requestedAutoVerify && issues.length === 0 && !forcePending;
		const now = new Date().toISOString();
		const record = {
			...draft,
			model_runs: modelRuns,
			correction_iou: correctionIoU,
			annotation_source: !activeRun?.box ? 'manual' : correctionIoU >= 0.98 ? 'model_accepted' : 'model_corrected',
			priority_flags: priorityFlags(draft, modelRuns),
			validation_issues: issues,
			auto_verify_eligible: eligible,
			verification_mode: requestedAutoVerify ? 'automatic' : 'suggestion',
			review_status: eligible ? 'verified' : 'pending',
			updated_at: now
		};
		delete record.auto_verify_requested;
		return record;
	}

	global.iNatCropJob = Object.freeze({ MODEL_IDS, boxIoU, validationIssues, priorityFlags, finalizeRecord });
})(typeof self !== 'undefined' ? self : globalThis);
