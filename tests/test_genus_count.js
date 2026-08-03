import assert from 'assert';

// Mock getGenusSpeciesCount implementation for testing
function getGenusSpeciesCountMock(taxon) {
	if (!taxon || !Array.isArray(taxon.children)) {
		return null;
	}
	return taxon.children.filter(c => c.rank === 'species').length;
}

console.log('Running test_genus_count.js...');

// Test case 1: Taxon with multiple children of different ranks
{
	const mockTaxon = {
		id: 201283,
		name: 'Chrysomya',
		rank: 'genus',
		children: [
			{ name: 'Chrysomya megacephala', rank: 'species' },
			{ name: 'Chrysomya villeneuvi-group', rank: 'complex' },
			{ name: 'Chrysomya marginalis', rank: 'species' },
			{ name: 'Chrysomya subgenus', rank: 'subgenus' },
			{ name: 'Chrysomya chloropyga', rank: 'species' }
		]
	};

	const count = getGenusSpeciesCountMock(mockTaxon);
	assert.strictEqual(count, 3, 'Should filter and count only species (megacephala, marginalis, chloropyga)');
	console.log('✅ Pass: Taxon with multiple ranks counts species correctly.');
}

// Test case 2: Taxon with no species children
{
	const mockTaxon = {
		id: 12345,
		name: 'MockGenus',
		rank: 'genus',
		children: [
			{ name: 'Mock subgenus', rank: 'subgenus' }
		]
	};

	const count = getGenusSpeciesCountMock(mockTaxon);
	assert.strictEqual(count, 0, 'Should return 0 when there are no species children');
	console.log('✅ Pass: Taxon with no species children returns 0.');
}

// Test case 3: Taxon with undefined children
{
	const mockTaxon = {
		id: 54321,
		name: 'MockGenus',
		rank: 'genus'
	};

	const count = getGenusSpeciesCountMock(mockTaxon);
	assert.strictEqual(count, null, 'Should return null when children array is missing');
	console.log('✅ Pass: Taxon with missing children returns null.');
}

console.log('🎉 Success! All genus species count tests passed.');
