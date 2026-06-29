(function () {
	'use strict';

	// Load settings from storage
	chrome.storage.sync.get({ enableSimilarSpeciesTab: true }, function (settings) {
		if (chrome.runtime.lastError) {
			console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
			return;
		}
		if (!settings || !settings.enableSimilarSpeciesTab) return;

		let currentTaxon = null;
		let currentPlaceId = null;
		let loadSequence = 0;
		const taxonCache = new Map();

		// Listen for observationFetch events to track the current observation's taxon ID
		document.addEventListener('observationFetch', event => {
			const obs = event.detail.observation;
			if (obs) {
				currentTaxon = obs.taxon || null;
				currentPlaceId = (obs.place_ids && obs.place_ids.length) ? obs.place_ids[0] : null;

				if (document.getElementById('inat-similar-section')) {
					loadSimilarSpecies();
				}
			}
		});

		// The native Info panel puts map/details first and identification activity after it.
		// Appending here gives the section the full sidebar width below the suggested IDs.
		document.arrive('.ObservationModal .info-tab-inner', { existing: true }, function () {
			if (this.querySelector('#inat-similar-section')) return;
			const panel = document.createElement('div');
			panel.id = 'inat-similar-section';
			panel.className = 'inat-similar-section';
			this.appendChild(panel);
			loadSimilarSpecies();
		});

		// ── Core Functionality ───────────────────────────────────────────────

		async function loadSimilarSpecies() {
			const panel = document.getElementById('inat-similar-section');
			if (!panel) return;
			const sequence = ++loadSequence;
			const taxon = currentTaxon;

			panel.innerHTML = `
				<div id="inat-similar-classification"></div>
				<div class="inat-similar-header">
					<h3>Commonly Confused Species</h3>
					<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
				</div>
				<div class="inat-similar-loading">
					<div class="inat-similar-spinner"></div>
					<span>Loading similar species...</span>
				</div>
			`;

			if (!taxon) {
				panel.innerHTML = `
					<div class="inat-similar-empty">
						No classification is available because this observation is unidentified.
					</div>
				`;
				return;
			}

			try {
				const classificationHtml = await buildClassification(taxon);
				if (!isCurrentPanel(panel, sequence)) return;
				const classification = panel.querySelector('#inat-similar-classification');
				if (!classification) return;
				classification.innerHTML = classificationHtml;

				if (!isSpeciesLevelTaxon(taxon)) {
					const loading = panel.querySelector('.inat-similar-loading');
					if (!loading) return;
					loading.outerHTML = `
						<div class="inat-similar-empty">
							Similar-species comparisons are available when an observation is identified to species or below.
						</div>
					`;
					return;
				}

				const data = await fetchSimilarSpecies(taxon.id);
				if (!isCurrentPanel(panel, sequence)) return;
				const results = data.results || [];

				if (!results.length) {
					panel.innerHTML = `
						${classificationHtml}
						<div class="inat-similar-header">
							<h3>Commonly Confused Species</h3>
							<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
						</div>
						<div class="inat-similar-empty">
							No commonly confused species found for this taxon.
						</div>
					`;
					return;
				}

				let gridHTML = '<ul class="inat-similar-grid">';
				results.forEach((item, index) => {
					const taxon = item.taxon;
					if (!taxon) return;

					const photoUrl = taxon.default_photo ? getMediumPhotoUrl(taxon.default_photo.url) : '';
					const commonName = taxon.preferred_common_name || '';
					const scientificName = taxon.name || '';
					const rank = taxon.rank || 'species';
					const count = item.count || 0;
					const taxonUrl = `https://www.inaturalist.org/taxa/${taxon.id}`;

					gridHTML += `
						<li class="inat-similar-card" data-index="${index}">
							<a href="${taxonUrl}" class="inat-similar-photo-wrap" target="_blank" rel="noopener">
								${photoUrl ? `<img src="${photoUrl}" alt="${escapeHtml(scientificName)}" loading="lazy">` : `<div class="inat-similar-photo-wrap--empty"></div>`}
								<span class="inat-similar-rank">${escapeHtml(rank)}</span>
								<span class="inat-similar-count-badge">${count.toLocaleString()} confused</span>
							</a>
							<div class="inat-similar-footer">
								<div class="inat-similar-names">
									${commonName ? `<a href="${taxonUrl}" class="inat-similar-common" target="_blank" rel="noopener" title="${escapeHtml(commonName)}">${escapeHtml(commonName)}</a>` : ''}
									<a href="${taxonUrl}" class="inat-similar-scientific" target="_blank" rel="noopener" title="${escapeHtml(scientificName)}">${escapeHtml(scientificName)}</a>
								</div>
							</div>
						</li>
					`;
				});
				gridHTML += '</ul>';

				panel.innerHTML = `
					${classificationHtml}
					<div class="inat-similar-header">
						<h3>Commonly Confused Species</h3>
						<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
					</div>
					${gridHTML}
				`;

			} catch (error) {
				if (!isCurrentPanel(panel, sequence)) return;
				console.error('[iNat Enhancement] Error loading similar species:', error);
				panel.innerHTML = `
					<div class="inat-similar-header">
						<h3>Commonly Confused Species</h3>
						<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
					</div>
					<div class="inat-similar-error">
						Failed to load similar species: ${escapeHtml(error.message || error)}
					</div>
				`;
			}
		}

		function isCurrentPanel(panel, sequence) {
			return sequence === loadSequence
				&& panel.isConnected
				&& document.getElementById('inat-similar-section') === panel;
		}

		// ── Helpers ──────────────────────────────────────────────────────────

		async function fetchSimilarSpecies(taxonId) {
			const url = `https://api.inaturalist.org/v1/identifications/similar_species?taxon_id=${taxonId}`;
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`API returned HTTP ${response.status}`);
			}
			return await response.json();
		}

		function isSpeciesLevelTaxon(taxon) {
			if (!taxon || !Number.isInteger(Number(taxon.id)) || Number(taxon.id) <= 0) return false;
			return ['species', 'subspecies', 'variety', 'form', 'hybrid'].includes(taxon.rank);
		}

		async function buildClassification(compactTaxon) {
			const fullTaxon = await fetchTaxa([compactTaxon.id]).then(taxa => taxa[0] || compactTaxon);
			const ids = [...new Set([...(fullTaxon.ancestor_ids || []), fullTaxon.id])];
			const missingIds = ids.filter(id => !taxonCache.has(String(id)));
			if (missingIds.length) await fetchTaxa(missingIds);

			const links = ids.map(id => taxonCache.get(String(id)))
				.filter(Boolean)
				.map((taxon, index) => {
					const label = taxon.preferred_common_name || taxon.name;
					const separator = index ? '<span class="inat-classification-separator">›</span>' : '';
					return `${separator}<a href="https://www.inaturalist.org/taxa/${taxon.id}" target="_blank" rel="noopener" title="${escapeHtml(taxon.name || label)}">${escapeHtml(label)}</a>`;
				}).join('');

			return `
				<div class="inat-similar-classification">
					<h3>Classification</h3>
					<div class="inat-classification-path">${links}</div>
				</div>
			`;
		}

		async function fetchTaxa(ids) {
			const results = [];
			for (let index = 0; index < ids.length; index += 30) {
				const batch = ids.slice(index, index + 30);
				const response = await fetch(`https://api.inaturalist.org/v1/taxa/${batch.join(',')}`);
				if (!response.ok) throw new Error(`Taxa API returned HTTP ${response.status}`);
				const data = await response.json();
				(data.results || []).forEach(taxon => {
					taxonCache.set(String(taxon.id), taxon);
					results.push(taxon);
				});
			}
			return results;
		}

		function getMediumPhotoUrl(url) {
			if (!url) return '';
			return url.replace(/\/(square|small|thumb|large|original)\./i, '/medium.');
		}

		function escapeHtml(v) {
			const d = document.createElement('div');
			d.textContent = String(v == null ? '' : v);
			return d.innerHTML;
		}

		function applyTaxonToForm(taxon) {
			const input = document.querySelector('.IdentificationForm .TaxonAutocomplete input');
			if (!input) {
				const addIdButton = document.querySelector('button:has(i.icon-identification)');
				if (addIdButton) {
					addIdButton.click();
				}
			}

			const delay = input ? 50 : 500;
			setTimeout(() => {
				const requestId = Math.random().toString(36).substring(2);

				function handleResponse(event) {
					if (event.detail.requestId !== requestId) return;
					document.removeEventListener('selectTaxonResponse', handleResponse);

					if (event.detail.success) {
						console.log('[iNat Enhancement] Similar species ID applied:', taxon.name);
					} else {
						console.error('[iNat Enhancement] Failed to apply similar species ID:', event.detail.error);
					}
				}
				document.addEventListener('selectTaxonResponse', handleResponse);

				document.dispatchEvent(new CustomEvent('selectTaxonRequest', {
					detail: { taxon, requestId, isIdentifyPage: true }
				}));
			}, delay);
		}
	});
})();
