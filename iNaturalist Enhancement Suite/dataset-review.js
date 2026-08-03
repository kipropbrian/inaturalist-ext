// Pure annotation-queue helpers shared by the dataset page and Node tests.
(function initDatasetReview(global) {
	'use strict';

	function idOf(record) {
		return String(record?.annotation_id || record?.id || record?.photo_id || '');
	}

	function statusOf(record) {
		return record?.review_status || record?.status || 'pending';
	}

	function flagsOf(record) {
		const value = record?.priority_flags || record?.priority || [];
		return Array.isArray(value)
			? value
			: String(value || '').split(',').map(flag => flag.trim()).filter(Boolean);
	}

	function searchableText(record) {
		return [
			idOf(record),
			record?.observation_id,
			record?.photo_id,
			record?.taxon_name,
			record?.taxon_common_name,
			record?.iconic_taxon,
			...flagsOf(record)
		].filter(Boolean).join(' ').toLocaleLowerCase();
	}

	function createdTime(record) {
		const value = Date.parse(record?.created_at || record?.updated_at || '');
		return Number.isFinite(value) ? value : 0;
	}

	function compareRecords(a, b, sort = 'newest') {
		if (sort === 'oldest') return createdTime(a) - createdTime(b) || idOf(a).localeCompare(idOf(b));
		if (sort === 'taxon') {
			const labelA = String(a?.taxon_common_name || a?.taxon_name || '').toLocaleLowerCase();
			const labelB = String(b?.taxon_common_name || b?.taxon_name || '').toLocaleLowerCase();
			return labelA.localeCompare(labelB) || idOf(a).localeCompare(idOf(b));
		}
		if (sort === 'priority') {
			const pendingDifference = Number(statusOf(b) === 'pending') - Number(statusOf(a) === 'pending');
			const flagDifference = flagsOf(b).length - flagsOf(a).length;
			return pendingDifference || flagDifference || createdTime(b) - createdTime(a) || idOf(a).localeCompare(idOf(b));
		}
		return createdTime(b) - createdTime(a) || idOf(a).localeCompare(idOf(b));
	}

	function selectRecords(records, { status = 'pending', query = '', sort = 'newest' } = {}) {
		const needle = String(query || '').trim().toLocaleLowerCase();
		return [...(records || [])]
			.filter(record => status === 'all' || statusOf(record) === status)
			.filter(record => !needle || searchableText(record).includes(needle))
			.sort((a, b) => compareRecords(a, b, sort));
	}

	function nextAfterAction(beforeIds, selectedId, afterIds) {
		const before = (beforeIds || []).map(String);
		const after = (afterIds || []).map(String);
		if (!after.length) return null;
		const available = new Set(after.filter(id => id !== String(selectedId)));
		const currentIndex = before.indexOf(String(selectedId));
		for (let index = currentIndex + 1; index < before.length; index++) {
			if (available.has(before[index])) return before[index];
		}
		for (let index = currentIndex - 1; index >= 0; index--) {
			if (available.has(before[index])) return before[index];
		}
		return after.find(id => id !== String(selectedId)) || null;
	}

	global.iNatDatasetReview = Object.freeze({
		idOf,
		statusOf,
		flagsOf,
		selectRecords,
		nextAfterAction
	});
})(typeof window !== 'undefined' ? window : globalThis);
