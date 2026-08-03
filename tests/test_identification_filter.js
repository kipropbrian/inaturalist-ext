import assert from 'assert';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(testDir, '..', 'iNaturalist Enhancement Suite', 'content-identifications.js');
const context = {
	URLSearchParams,
	globalThis: null,
	chrome: {
		storage: { sync: { get() {} } }
	},
	__INAT_IDENTIFICATIONS_TEST__: {}
};
context.globalThis = context;

vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });

const { applyTaxonFilter, findExactTaxon, parseTaxonQuery } = context.__INAT_IDENTIFICATIONS_TEST__.helpers;

console.log('Running identification taxon filter tests...');

assert.deepStrictEqual(
	JSON.parse(JSON.stringify(parseTaxonQuery('Birds'))),
	{ exclude: false, query: 'Birds' }
);
assert.deepStrictEqual(
	JSON.parse(JSON.stringify(parseTaxonQuery('  !Birds  '))),
	{ exclude: true, query: 'Birds' }
);
assert.deepStrictEqual(
	JSON.parse(JSON.stringify(parseTaxonQuery('!  Aves'))),
	{ exclude: true, query: 'Aves' }
);

const taxa = [
	{ id: 3, name: 'Aves', preferred_common_name: 'Birds' },
	{ id: 47126, name: 'Plantae', preferred_common_name: 'Plants' }
];
assert.strictEqual(findExactTaxon(taxa, 'Birds').id, 3);
assert.strictEqual(findExactTaxon(taxa, 'birds').id, 3);
assert.strictEqual(findExactTaxon(taxa, 'Aves').id, 3);
assert.strictEqual(findExactTaxon(taxa, 'Bird').id, 3);
assert.strictEqual(findExactTaxon(taxa, 'Hawk'), null);

{
	const params = new URLSearchParams();
	applyTaxonFilter(params, { id: '3', exclude: false });
	assert.strictEqual(params.toString(), 'taxon_id=3');
}

{
	const params = new URLSearchParams();
	applyTaxonFilter(params, { id: '3', exclude: true });
	assert.strictEqual(params.toString(), 'without_taxon_id=3');
}

{
	const params = new URLSearchParams();
	applyTaxonFilter(params, null);
	assert.strictEqual(params.toString(), '');
}

console.log('Identification taxon filter tests passed.');
