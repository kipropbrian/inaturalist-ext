import assert from 'assert';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(testDir, '..', 'iNaturalist Enhancement Suite');
const domContext = fs.readFileSync(join(extensionDir, 'domContext.js'), 'utf8');
const photosTab = fs.readFileSync(join(extensionDir, 'content-photos-tab.js'), 'utf8');
const photosTestContext = {
	globalThis: null,
	__INAT_PHOTOS_TEST__: {},
	chrome: { storage: { sync: { get() {} } } }
};
photosTestContext.globalThis = photosTestContext;
vm.runInNewContext(photosTab, photosTestContext, { filename: join(extensionDir, 'content-photos-tab.js') });
const { findExactPhotosTaxon } = photosTestContext.__INAT_PHOTOS_TEST__.helpers;

console.log('Running draft taxon Photos tab regression tests...');

assert.strictEqual(
	findExactPhotosTaxon([
		{ id: 53, name: 'Balearica regulorum', preferred_common_name: 'Gray Crowned-Crane' }
	], 'Gray Crowned-Crane').id,
	53,
	'Photos must resolve an exact manually entered common name'
);
assert.strictEqual(
	findExactPhotosTaxon([
		{ id: 53, name: 'Balearica regulorum', preferred_common_name: 'Gray Crowned-Crane' }
	], 'Unknown taxon'),
	null,
	'Photos must not guess an unresolved manual taxon'
);

assert.ok(
	domContext.includes("input.closest('.IdentificationForm')"),
	'Draft taxon events must be limited to identification forms, not taxon filters'
);
assert.ok(
	domContext.includes("'assignSelection autocompleteselect'"),
	'Draft taxon events must support both extension and native picker selections'
);
assert.ok(
	domContext.includes('selectedTaxon?.item || ui?.item || selectedTaxon'),
	'Native picker selections must read the taxon from ui.item'
);
assert.ok(
	domContext.includes("new CustomEvent('inatExtDraftTaxonSelected'"),
	'domContext.js must announce a taxon selected for an unsaved identification'
);
assert.ok(
	domContext.includes('typeof taxon.toJSON === \'function\''),
	'Draft taxon events must convert iNaturalist taxon models to plain data'
);
assert.ok(
	domContext.includes('detail: { taxon: draftTaxon }'),
	'Draft taxon event must provide the selected taxon to content scripts'
);
assert.ok(
	domContext.includes('dataset.inatExtDraftTaxon = JSON.stringify(draftTaxon)'),
	'Draft taxon selections must survive the page-to-content-script world boundary'
);
assert.ok(
	domContext.includes("$(input).data('autocomplete-item') || input.selection"),
	'Draft taxon fallback must read the native autocomplete selection before blur clears it'
);
assert.ok(
	photosTab.includes("document.addEventListener('inatExtDraftTaxonSelected'"),
	'content-photos-tab.js must consume draft taxon selections'
);
assert.ok(
	photosTab.includes('syncDraftTaxonFromInput();'),
	'Photos must resolve the active identification input when the native selection event is unavailable'
);
assert.ok(
	photosTab.includes('getStoredDraftTaxon()'),
	'Photos must consume the DOM-backed draft taxon handoff'
);
assert.ok(
	photosTab.includes(".ui-autocomplete.taxon-autocomplete .ac-result.taxon"),
	'Photos must react to native autocomplete selections'
);
assert.ok(
	photosTab.includes('setTaxon(taxon || getStoredDraftTaxon());'),
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
