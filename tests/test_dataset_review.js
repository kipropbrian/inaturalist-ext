import assert from 'node:assert/strict';

await import('../iNaturalist Enhancement Suite/dataset-review.js');

const review = globalThis.iNatDatasetReview;
const records = [
	{ annotation_id: '10:100', review_status: 'pending', taxon_common_name: 'Beetle', photo_id: '100', priority_flags: ['small_subject'], created_at: '2026-07-29T06:00:00Z' },
	{ annotation_id: '20:200', review_status: 'verified', taxon_common_name: 'Moth', photo_id: '200', priority_flags: [], created_at: '2026-07-29T07:00:00Z' },
	{ annotation_id: '30:300', review_status: 'pending', taxon_common_name: 'Ant', photo_id: '300', priority_flags: [], created_at: '2026-07-29T05:00:00Z' }
];

assert.deepEqual(
	review.selectRecords(records, { status: 'pending', sort: 'newest' }).map(review.idOf),
	['10:100', '30:300'],
	'the review queue should be stable by creation time rather than updated time'
);
assert.deepEqual(
	review.selectRecords(records, { status: 'all', query: '100' }).map(review.idOf),
	['10:100'],
	'search should find annotation and photo IDs'
);
assert.deepEqual(
	review.selectRecords(records, { status: 'all', query: 'beetle' }).map(review.idOf),
	['10:100'],
	'search should find taxon labels'
);
assert.equal(
	review.nextAfterAction(['10:100', '30:300'], '10:100', ['30:300']),
	'30:300',
	'approving an item should advance to the next item still in the queue'
);

console.log('Success! Dataset review queue tests passed.');
