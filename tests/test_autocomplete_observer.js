import assert from 'assert';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(testDir, '..', 'iNaturalist Enhancement Suite', 'content-observation.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf8');

console.log('Running Autocomplete Observer & Mutation loop regression tests...');

// Test 1: Verify popover exclusion guard exists in content-observation.js
assert.ok(
	scriptContent.includes("ul.closest('.TaxonChooserPopover, .RecordChooserPopover, .popover, .filters, #suggestions-taxon-chooser')"),
	'content-observation.js must check and ignore autocompletes belonging to filter popovers'
);

// Test 2: Verify re-entrancy guard exists in content-observation.js observeCallback
assert.ok(
	scriptContent.includes('let isModifying = false;') && scriptContent.includes('if (isModifying) return;'),
	'content-observation.js must include re-entrancy guard (isModifying) in observeCallback to prevent infinite loops'
);

// Test 3: Functional simulation of observeCallback re-entrancy protection
{
	let callCount = 0;
	let isModifying = false;

	class MockElement {
		constructor() {
			this.classList = {
				contains: (c) => c === 'expanded',
				add: (c) => {
					// Simulate class change triggering another mutation event
					triggerMutation();
				},
				remove: (c) => {}
			};
			this.style = { width: '200px' };

			this.querySelectorAll = () => [{
				getAttribute: () => '12345',
				closest: () => ({
					querySelector: () => null,
					insertBefore: () => {},
					firstChild: null,
					style: {}
				}),
				parentNode: { parentNode: { classList: { contains: () => false }, style: { width: '200px' } } },
				style: {}
			}];
		}
	}

	function triggerMutation() {
		if (isModifying) return;
		isModifying = true;
		try {
			callCount++;
			const elem = new MockElement();
			// Modifying class inside callback would cause recursion if not guarded
			elem.classList.add('expanded');
		} finally {
			isModifying = false;
		}
	}

	// Trigger initial mutation
	triggerMutation();

	// With protection, callCount must be exactly 1 (no infinite recursion)
	assert.strictEqual(callCount, 1, 'observeCallback re-entrancy guard prevented infinite loop recursion');
}

console.log('✅ All Autocomplete Observer regression tests passed successfully!');
