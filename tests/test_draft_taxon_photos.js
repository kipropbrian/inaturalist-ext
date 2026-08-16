import assert from 'assert';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(testDir, '..', 'iNaturalist Enhancement Suite');
const domContext = fs.readFileSync(join(extensionDir, 'domContext.js'), 'utf8');
const photosTab = fs.readFileSync(join(extensionDir, 'content-photos-tab.js'), 'utf8');

console.log('Running draft taxon Photos tab regression tests...');

assert.ok(
	domContext.includes("input.closest('.IdentificationForm')"),
	'Draft taxon events must be limited to identification forms, not taxon filters'
);
assert.ok(
	domContext.includes("new CustomEvent('inatExtDraftTaxonSelected'"),
	'domContext.js must announce a taxon selected for an unsaved identification'
);
assert.ok(
	domContext.includes('typeof selectedTaxon.toJSON === \'function\''),
	'Draft taxon events must convert iNaturalist taxon models to plain data'
);
assert.ok(
	domContext.includes('detail: { taxon: draftTaxon }'),
	'Draft taxon event must provide the selected taxon to content scripts'
);
assert.ok(
	photosTab.includes("document.addEventListener('inatExtDraftTaxonSelected'"),
	'content-photos-tab.js must consume draft taxon selections'
);
assert.ok(
	photosTab.includes('setTaxon(event.detail?.taxon);'),
	'Draft taxon selections must use the same tab lifecycle as observation taxa'
);
assert.ok(
	photosTab.includes('if (isSameTaxon && !forceRefresh)'),
	'Reselecting the same taxon must preserve the already loaded Photos gallery'
);
assert.ok(
	photosTab.includes("return typeof taxon.rank_level !== 'number' || taxon.rank_level <= 40;"),
	'A selected taxon with an ID must work even when autocomplete omits rank_level'
);
assert.ok(
	photosTab.includes("document.arrive('.ObservationModal .sidebar', { existing: true }, function () {\n\t\t\tensureTabInjected();"),
	'Photos must remain available even when the observation has no taxon'
);
assert.ok(
	photosTab.includes('if (!currentTaxon) {\n\t\t\t\trenderTaxonUnavailable();\n\t\t\t\treturn;'),
	'An unknown taxon must show an empty state without loading photos'
);
assert.ok(
	photosTab.includes("new CustomEvent('inatExtCloseTaxonAutocomplete')"),
	'Opening Photos must close a visible native autocomplete menu'
);
assert.ok(
	photosTab.includes("new CustomEvent('inatExtRequestDraftTaxon')"),
	'Opening Photos must request the current draft taxon as a fallback'
);
assert.ok(
	domContext.includes("document.addEventListener('inatExtRequestDraftTaxon'"),
	'domContext.js must return the selected native autocomplete taxon on request'
);
assert.ok(
	domContext.includes(".ObservationModal .TaxonAutocomplete > ul"),
	'Autocomplete cleanup must include menus inside the observation modal'
);

console.log('✅ Draft taxon Photos tab regression tests passed successfully!');
