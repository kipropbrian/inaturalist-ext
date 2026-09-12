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

console.log('✅ All Quick ID options regression tests passed successfully!');
