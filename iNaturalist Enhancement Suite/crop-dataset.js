// Local, metadata-only crop annotation store. Images are deliberately not persisted.
(function initCropDataset(global) {
	'use strict';

	const STORAGE_KEY = 'iNatCropDatasetRecords';
	const SCHEMA_VERSION = 1;
	let memoryRecords = [];
	let mutationQueue = Promise.resolve();

	function clamp(value, min = 0, max = 1) {
		return Math.min(max, Math.max(min, Number(value) || 0));
	}

	function normalizePixelBox(box, imageWidth, imageHeight) {
		const width = Math.max(1, Number(imageWidth) || 1);
		const height = Math.max(1, Number(imageHeight) || 1);
		const x1 = clamp(box.x / width);
		const y1 = clamp(box.y / height);
		const x2 = clamp((box.x + box.width) / width);
		const y2 = clamp((box.y + box.height) / height);
		return {
			xmin: Math.min(x1, x2),
			ymin: Math.min(y1, y2),
			xmax: Math.max(x1, x2),
			ymax: Math.max(y1, y2)
		};
	}

	function finalBoxForSave(cropData, imageWidth, imageHeight, appliedModelBox = null) {
		const normalizedCrop = normalizePixelBox(cropData, imageWidth, imageHeight);
		const toleranceX = 0.51 / Math.max(1, Number(imageWidth) || 1);
		const toleranceY = 0.51 / Math.max(1, Number(imageHeight) || 1);
		const stillMatchesAppliedModel = appliedModelBox
			&& Math.abs(normalizedCrop.xmin - appliedModelBox.xmin) <= toleranceX
			&& Math.abs(normalizedCrop.xmax - appliedModelBox.xmax) <= toleranceX
			&& Math.abs(normalizedCrop.ymin - appliedModelBox.ymin) <= toleranceY
			&& Math.abs(normalizedCrop.ymax - appliedModelBox.ymax) <= toleranceY;
		if (stillMatchesAppliedModel) {
			return {
				xmin: clamp(appliedModelBox.xmin),
				ymin: clamp(appliedModelBox.ymin),
				xmax: clamp(appliedModelBox.xmax),
				ymax: clamp(appliedModelBox.ymax)
			};
		}
		return normalizedCrop;
	}

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

	function makeId(record) {
		if (record.annotation_id) return String(record.annotation_id);
		const identity = record.photo_id || record.photo_url || Date.now();
		return `${record.observation_id || 'unknown'}:${identity}`;
	}

	function prepareRecord(input, existing) {
		const now = new Date().toISOString();
		return {
			...(existing || {}),
			...input,
			schema_version: SCHEMA_VERSION,
			annotation_id: makeId(input),
			review_status: input.review_status || existing?.review_status || 'pending',
			created_at: existing?.created_at || input.created_at || now,
			updated_at: now
		};
	}

	function storageArea() {
		return global.chrome?.storage?.local || null;
	}

	function callStorage(method, argument) {
		const area = storageArea();
		if (!area) return Promise.resolve(null);
		return new Promise((resolve, reject) => {
			area[method](argument, result => {
				const error = global.chrome?.runtime?.lastError;
				if (error) reject(new Error(error.message)); else resolve(result);
			});
		});
	}

	function callRuntime(message) {
		if (!global.chrome?.runtime?.sendMessage) return Promise.resolve({ success: false, error: 'Extension runtime unavailable' });
		return new Promise(resolve => {
			global.chrome.runtime.sendMessage(message, response => {
				const error = global.chrome?.runtime?.lastError;
				resolve(error ? { success: false, error: error.message } : (response || { success: false, error: 'No collector response' }));
			});
		});
	}

	async function syncRecord(record) {
		const automaticallyVerifiable = record.verification_mode === 'automatic' && record.auto_verify_eligible === true;
		const outgoing = automaticallyVerifiable ? { ...record, review_status: 'verified' } : record;
		const response = await callRuntime({ action: 'syncCropAnnotation', record: outgoing });
		const now = new Date().toISOString();
		return response.success ? {
			...outgoing,
			photo_url: response.photo_url || record.photo_url,
			photo_id: response.photo_id || record.photo_id,
			sync_status: 'synced',
			synced_at: response.synced_at || now,
			sync_error: null
		} : {
			...record,
			review_status: automaticallyVerifiable ? 'pending' : record.review_status,
			sync_status: 'pending',
			sync_error: response.error || 'Collector unavailable'
		};
	}

	async function readAllDirect() {
		if (!storageArea()) return [...memoryRecords];
		const result = await callStorage('get', STORAGE_KEY);
		return Array.isArray(result?.[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
	}

	async function writeAllDirect(records) {
		if (!storageArea()) {
			memoryRecords = [...records];
			return;
		}
		await callStorage('set', { [STORAGE_KEY]: records });
	}

	function mutate(operation) {
		const result = mutationQueue.then(operation, operation);
		mutationQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	async function get(annotationId) {
		await mutationQueue;
		const records = await readAllDirect();
		return records.find(record => record.annotation_id === String(annotationId));
	}

	function put(input) {
		return mutate(async () => {
			const records = await readAllDirect();
			const annotationId = makeId(input);
			const index = records.findIndex(record => record.annotation_id === annotationId);
			let record = prepareRecord({ ...input, annotation_id: annotationId, sync_status: 'pending' }, index >= 0 ? records[index] : null);
			if (index >= 0) records[index] = record; else records.push(record);
			await writeAllDirect(records);
			record = await syncRecord(record);
			if (index >= 0) records[index] = record; else records[records.length - 1] = record;
			await writeAllDirect(records);
			return record;
		});
	}

	function syncAll() {
		return mutate(async () => {
			const records = await readAllDirect();
			let synced = 0;
			for (let index = 0; index < records.length; index++) {
				if (records[index].sync_status === 'synced' && records[index].photo_url) {
					synced++;
					continue;
				}
				records[index] = await syncRecord(records[index]);
				if (records[index].sync_status === 'synced') synced++;
			}
			await writeAllDirect(records);
			return { total: records.length, synced, pending: records.length - synced };
		});
	}

	async function collectorHealth() {
		return callRuntime({ action: 'cropCollectorHealth' });
	}

	async function update(annotationId, changes) {
		const existing = await get(annotationId);
		if (!existing) throw new Error(`Annotation not found: ${annotationId}`);
		return put({ ...existing, ...changes, annotation_id: String(annotationId) });
	}

	async function list({ status, limit } = {}) {
		await mutationQueue;
		const records = await readAllDirect();
		return records
			.filter(record => !status || record.review_status === status)
			.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
			.slice(0, limit || records.length);
	}

	function remove(annotationId) {
		return mutate(async () => {
			const records = await readAllDirect();
			await writeAllDirect(records.filter(record => record.annotation_id !== String(annotationId)));
		});
	}

	function clear() {
		return mutate(() => writeAllDirect([]));
	}

	async function stats() {
		const records = await list();
		const result = { total: records.length, pending: 0, verified: 0, rejected: 0, target: 500, by_iconic_taxon: {} };
		for (const record of records) {
			if (Object.hasOwn(result, record.review_status)) result[record.review_status]++;
			const group = record.iconic_taxon || 'Unknown';
			result.by_iconic_taxon[group] = (result.by_iconic_taxon[group] || 0) + 1;
		}
		result.remaining = Math.max(0, result.target - result.verified);
		return result;
	}

	async function exportJSON() {
		return JSON.stringify({ schema_version: SCHEMA_VERSION, exported_at: new Date().toISOString(), annotations: await list() }, null, 2);
	}

	async function importJSON(payload) {
		const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
		const annotations = Array.isArray(parsed) ? parsed : (parsed?.annotations || parsed?.records);
		if (!Array.isArray(annotations)) throw new TypeError('Import must contain an annotations array');
		return mutate(async () => {
			const records = await readAllDirect();
			const byId = new Map(records.map(record => [record.annotation_id, record]));
			const imported = annotations.map(annotation => {
				const annotationId = makeId(annotation);
				const record = prepareRecord({ ...annotation, annotation_id: annotationId }, byId.get(annotationId));
				byId.set(annotationId, record);
				return record;
			});
			await writeAllDirect([...byId.values()]);
			return imported;
		});
	}

	global.iNatCropDataset = Object.freeze({
		STORAGE_KEY, SCHEMA_VERSION,
		normalizePixelBox, finalBoxForSave, boxIoU, prepareRecord,
		put, get, list, update, remove, clear, stats, exportJSON, importJSON,
		syncAll, collectorHealth
	});
})(typeof window !== 'undefined' ? window : globalThis);
