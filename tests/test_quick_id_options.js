import assert from 'assert';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(testDir, '..', 'iNaturalist Enhancement Suite', 'content-observation.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf8');

console.log('Running Quick ID options regression tests...');

// Extract QUICK_ADD_TAXA array definition from content-observation.js
const match = scriptContent.match(/const QUICK_ADD_TAXA\s*=\s*(\[[\s\S]*?\n\t\];)/);
assert.ok(match, 'QUICK_ADD_TAXA definition must exist in content-observation.js');

const taxa = eval(match[1]);

// Test: Poaceae (family) must not be present
const poaceae = taxa.find(t => t.taxon?.id === 47434 || t.taxon?.name === 'Poaceae');
assert.strictEqual(poaceae, undefined, 'Family Poaceae (47434) should not be present in QUICK_ADD_TAXA');

// Test: Poales (order) must be present with label "Grasses and allies"
const poales = taxa.find(t => t.taxon?.id === 47162);
assert.ok(poales, 'Order Poales (id 47162) must be present in QUICK_ADD_TAXA');
assert.strictEqual(poales.label, 'Grasses and allies', 'Label must be "Grasses and allies"');
assert.strictEqual(poales.taxon.name, 'Poales', 'Taxon name must be "Poales"');
assert.strictEqual(poales.taxon.rank, 'order', 'Taxon rank must be "order"');
assert.strictEqual(poales.taxon.preferred_common_name, 'Grasses, Sedges, and Cattails', 'Preferred common name must match "Grasses, Sedges, and Cattails"');
assert.strictEqual(poales.taxon.iconic_taxon_name, 'Plantae', 'Iconic taxon name must be "Plantae"');
assert.ok(poales.photoUrl.includes('54589881'), 'Photo URL should match Poales default photo');
// Test: Mimosoideae (subfamily) must be present with label "Acacia and allies"
const acacias = taxa.find(t => t.taxon?.id === 373578);
assert.ok(acacias, 'Subfamily Mimosoideae (id 373578) must be present in QUICK_ADD_TAXA');
assert.strictEqual(acacias.label, 'Acacia and allies', 'Label must be "Acacia and allies"');
assert.strictEqual(acacias.taxon.name, 'Mimosoideae', 'Taxon name must be "Mimosoideae"');
assert.strictEqual(acacias.taxon.rank, 'subfamily', 'Taxon rank must be "subfamily"');
assert.strictEqual(acacias.taxon.preferred_common_name, 'Acacias, Mimosas, Mesquites, and Allies', 'Preferred common name must match "Acacias, Mimosas, Mesquites, and Allies"');
assert.strictEqual(acacias.taxon.iconic_taxon_name, 'Plantae', 'Iconic taxon name must be "Plantae"');
assert.ok(acacias.photoUrl.includes('224614153'), 'Photo URL should match Mimosoideae default photo');

// Test: Solanaceae (family) must be present with label "Nightshades"
const nightshades = taxa.find(t => t.taxon?.id === 48516);
assert.ok(nightshades, 'Family Solanaceae (id 48516) must be present in QUICK_ADD_TAXA');
assert.strictEqual(nightshades.label, 'Nightshades', 'Label must be "Nightshades"');
assert.strictEqual(nightshades.taxon.name, 'Solanaceae', 'Taxon name must be "Solanaceae"');
assert.strictEqual(nightshades.taxon.rank, 'family', 'Taxon rank must be "family"');
assert.strictEqual(nightshades.taxon.preferred_common_name, 'nightshade family', 'Preferred common name must match "nightshade family"');
assert.strictEqual(nightshades.taxon.iconic_taxon_name, 'Plantae', 'Iconic taxon name must be "Plantae"');
assert.ok(nightshades.photoUrl.includes('4608305'), 'Photo URL should match Solanaceae default photo');

// Test: Ipomoea (genus) must be present with label "Morning Glories"
const ipomoea = taxa.find(t => t.taxon?.id === 52346);
assert.ok(ipomoea, 'Genus Ipomoea (id 52346) must be present in QUICK_ADD_TAXA');
assert.strictEqual(ipomoea.label, 'Morning Glories', 'Label must be "Morning Glories"');
assert.strictEqual(ipomoea.taxon.name, 'Ipomoea', 'Taxon name must be "Ipomoea"');
assert.strictEqual(ipomoea.taxon.rank, 'genus', 'Taxon rank must be "genus"');
assert.strictEqual(ipomoea.taxon.preferred_common_name, 'morning-glories', 'Preferred common name must match "morning-glories"');
assert.strictEqual(ipomoea.taxon.iconic_taxon_name, 'Plantae', 'Iconic taxon name must be "Plantae"');
assert.ok(ipomoea.photoUrl.includes('149905022'), 'Photo URL should match Ipomoea default photo');

console.log('✅ All Quick ID options regression tests passed successfully!');
