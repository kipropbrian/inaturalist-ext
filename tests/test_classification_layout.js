import assert from 'assert';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(testDir, '..', 'iNaturalist Enhancement Suite');
const similarScript = fs.readFileSync(join(extensionDir, 'content-identify-similar.js'), 'utf8');
const similarCss = fs.readFileSync(join(extensionDir, 'similar-species.css'), 'utf8');
const cacheScript = fs.readFileSync(join(extensionDir, 'cache.js'), 'utf8');

console.log('Running classification layout regression tests...');

assert.ok(
	similarScript.includes(".ObservationModal .leading.panel.panel-default"),
	'Classification placement must target the native leading suggestion panel'
);
assert.ok(
	similarScript.includes("suggestionCard.querySelector('.identification')"),
	'Classification must be inserted into the native identification div'
);
assert.ok(
	similarScript.includes('classification.classList.add(\'inat-inline-taxonomy--embedded\')'),
	'Classification must use the embedded card style when a suggestion panel exists'
);
assert.ok(
	similarScript.includes('inat-inline-taxonomy-thumb'),
	'Classification taxa must render thumbnail images'
);
assert.ok(
	similarScript.includes('removeEmbeddedClassification()'),
	'Reloading similar-species results must remove stale embedded classifications'
);
assert.ok(
	similarScript.includes('new MutationObserver') && similarScript.includes('relocateClassification(panel)'),
	'Classification must relocate when the native leading panel renders later'
);
assert.ok(
	similarScript.includes('loadSimilarSpecies({ includeSimilar: false })')
		&& similarScript.includes('relocateClassification(panel)'),
	'Classification must load lazily when the active suggestion panel settles'
);
assert.ok(
	similarScript.includes('const classificationKey = `inat-classification-${compactTaxon.id}`')
		&& similarScript.includes('await window.iNatCache.write(classificationKey'),
	'Classification trees must use a persistent tree cache'
);
assert.ok(
	cacheScript.includes("'inat-classification-': 365 * 24 * 60 * 60 * 1000"),
	'Classification tree cache must be long lived'
);
assert.ok(
	similarCss.includes('.inat-inline-taxonomy--embedded'),
	'Embedded classification styling must be defined'
);
assert.ok(
	similarCss.includes('text-transform: uppercase'),
	'Classification heading must use compact label styling'
);

console.log('✅ Classification layout regression tests passed successfully!');
