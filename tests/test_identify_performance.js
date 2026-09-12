import assert from 'assert';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(testDir, '..', 'iNaturalist Enhancement Suite');
const read = name => fs.readFileSync(join(extensionDir, name), 'utf8');

const observation = read('content-observation.js');
const domContext = read('domContext.js');
const similar = read('content-identify-similar.js');
const background = read('background.js');
const photos = read('content-photos-tab.js');
const options = read('options.js');

console.log('Running Identify performance and lifecycle regression tests...');

assert.ok(observation.includes("window.addEventListener('scroll'"), 'Identify paging must use scroll events');
assert.ok(observation.includes('{ passive: true }'), 'Identify paging scroll listener must be passive');
assert.ok(!observation.includes("window.addEventListener('wheel'"), 'Identify paging must not intercept every wheel event');
assert.ok(!observation.includes('passive: false'), 'Identify paging must not install a blocking event listener');
assert.ok(!observation.includes('attributes: true'), 'Identify pagination observer must not watch every attribute mutation');
assert.ok(observation.includes("document.arrive('ul.ui-autocomplete.taxon-autocomplete'"), 'Taxon colorization must follow the current native autocomplete menu');

assert.ok(domContext.includes('inspectFetchResponse(response, requestUrl, options).catch'), 'Fetch inspection must be detached from the native response promise');
assert.ok(domContext.includes('return response;'), 'The native fetch response must be returned immediately after the request resolves');

assert.ok(similar.includes('new AbortController()'), 'Similar-species requests must be cancellable');
assert.ok(similar.includes('observationKey'), 'Similar-species rendering must deduplicate repeated observation events');
assert.ok(similar.includes('Promise.all(missingFromL1.map'), 'Taxon persistent-cache reads must run concurrently');

assert.ok(!background.includes('getDetectorModel().catch(() => {})'), 'The detector must not warm eagerly in the background worker');
assert.ok(photos.includes('if (!storedDraftTaxon) syncDraftTaxonFromInput();'), 'Photos must not refetch a draft taxon already delivered by the page-world bridge');
assert.ok(options.includes('enableIdentifyAutoPaging'), 'Identify auto-paging must be configurable');

console.log('✅ Identify performance and lifecycle regression tests passed successfully!');
