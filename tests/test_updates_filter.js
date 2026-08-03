import assert from 'assert';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(testDir, '..', 'iNaturalist Enhancement Suite', 'content-updates.js');
const context = {
	URL,
	window: { location: { origin: 'https://www.inaturalist.org' } },
	__INAT_UPDATES_TEST__: {}
};
vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });

const {
	classifyObservationUpdate,
	cacheKeyForUser,
	extractObservationId,
	isUsableUpdatesCache,
	matchesMode,
	shouldAutoLoad,
	shouldRestoreClassification
} = context.__INAT_UPDATES_TEST__.helpers;

const ownId = {
	user: { login: 'brian_maiyo' },
	created_at: '2026-07-10T10:00:00Z',
	disagreement: null,
	body: null
};

function observation({ identifications = [], comments = [] } = {}) {
	return {
		identifications: [ownId, ...identifications],
		comments
	};
}

console.log('Running update attention filter tests...');

assert.strictEqual(matchesMode(null, 'all'), true);

{
	const result = classifyObservationUpdate(observation({
		comments: [{
			user: { login: 'jakob' },
			created_at: '2026-07-10T10:05:00Z',
			body: 'Were the bats roosting in trees?'
		}]
	}), 'brian_maiyo');
	assert.strictEqual(result.comment, true);
	assert.strictEqual(result.standardComment, true);
	assert.strictEqual(result.disagreement, false);
}

{
	const result = classifyObservationUpdate(observation({
		identifications: [{
			user: { login: 'plantperson7654' },
			created_at: '2026-07-10T10:06:00Z',
			disagreement: true,
			body: 'Please split the photos into two observations.'
		}]
	}), 'brian_maiyo');
	assert.strictEqual(result.comment, true);
	assert.strictEqual(result.identificationNote, true);
	assert.strictEqual(result.disagreement, true);
	assert.strictEqual(matchesMode(result, 'attention'), true);
	assert.strictEqual(matchesMode(result, 'comments'), true);
	assert.strictEqual(matchesMode(result, 'disagreements'), true);
}

{
	const result = classifyObservationUpdate(observation({
		identifications: [{
			user: { login: 'ordinary_identifier' },
			created_at: '2026-07-10T10:06:00Z',
			disagreement: false,
			body: ''
		}]
	}), 'brian_maiyo');
	assert.strictEqual(result.comment, false);
	assert.strictEqual(result.disagreement, false);
	assert.strictEqual(matchesMode(result, 'attention'), false);
	assert.strictEqual(matchesMode(result, 'all'), true);
}

{
	const result = classifyObservationUpdate(observation({
		comments: [{
			user: { login: 'early_commenter' },
			created_at: '2026-07-10T09:59:00Z',
			body: 'This happened before Brian identified it.'
		}],
		identifications: [{
			user: { login: 'early_identifier' },
			created_at: '2026-07-10T09:58:00Z',
			disagreement: true,
			body: ''
		}]
	}), 'brian_maiyo');
	assert.strictEqual(result.comment, false);
	assert.strictEqual(result.disagreement, false);
}

{
	const result = classifyObservationUpdate({
		comments: [{
			user: { login: 'someone' },
			created_at: '2026-07-10T10:05:00Z'
		}],
		identifications: []
	}, 'brian_maiyo');
	assert.strictEqual(result.hasOwnIdentification, false);
	assert.strictEqual(matchesMode(result, 'attention'), false);
}

assert.strictEqual(
	extractObservationId('https://www.inaturalist.org/observations/381333474#activity'),
	'381333474'
);
assert.strictEqual(extractObservationId('/taxa/40827-Eidolon-helvum'), '');
assert.strictEqual(cacheKeyForUser(' Brian_Maiyo '), 'inat-updates-brian_maiyo');

assert.strictEqual(isUsableUpdatesCache({
	version: 2,
	userLogin: 'brian_maiyo',
	cachedAt: 500_000,
	itemsHtml: '<li></li>',
	classifications: {}
}, 'brian_maiyo', 1_000_000), true);
assert.strictEqual(isUsableUpdatesCache({
	version: 2,
	userLogin: 'someone_else',
	cachedAt: 500_000,
	itemsHtml: '<li></li>',
	classifications: {}
}, 'brian_maiyo', 1_000_000), false);
assert.strictEqual(isUsableUpdatesCache({
	version: 1,
	userLogin: 'brian_maiyo',
	cachedAt: 500_000,
	itemsHtml: '<li></li>',
	classifications: {}
}, 'brian_maiyo', 1_000_000), false);
assert.strictEqual(isUsableUpdatesCache({
	version: 2,
	userLogin: 'brian_maiyo',
	cachedAt: 1,
	itemsHtml: '<li></li>',
	classifications: {}
}, 'brian_maiyo', 4_000_001), false);

assert.strictEqual(shouldRestoreClassification({ comment: true, disagreement: false }, 0, 1_000_000), true);
assert.strictEqual(shouldRestoreClassification({ comment: false, disagreement: true }, 0, 1_000_000), true);
assert.strictEqual(shouldRestoreClassification({ comment: false, disagreement: false }, 500_000, 1_000_000), true);
assert.strictEqual(shouldRestoreClassification({ comment: false, disagreement: false }, 1, 1_000_000), false);

assert.strictEqual(shouldAutoLoad({
	mode: 'comments',
	visible: 5,
	hasMore: true,
	pagesLoaded: 0
}), true);
assert.strictEqual(shouldAutoLoad({
	mode: 'disagreements',
	visible: 1,
	hasMore: true,
	pagesLoaded: 0
}), true);
assert.strictEqual(shouldAutoLoad({
	mode: 'comments',
	visible: 10,
	hasMore: true,
	pagesLoaded: 0
}), false);
assert.strictEqual(shouldAutoLoad({
	mode: 'all',
	visible: 0,
	hasMore: true,
	pagesLoaded: 0
}), false);
assert.strictEqual(shouldAutoLoad({
	mode: 'comments',
	visible: 5,
	hasMore: false,
	pagesLoaded: 0
}), false);
assert.strictEqual(shouldAutoLoad({
	mode: 'disagreements',
	visible: 1,
	hasMore: true,
	pagesLoaded: 12
}), false);

console.log('Success! Update attention filter tests passed.');
