(function () {
	'use strict';

	// Load settings from storage
	chrome.storage.sync.get({ enableSimilarSpeciesTab: true }, function (settings) {
		if (!settings.enableSimilarSpeciesTab) return;

		let currentTaxonId = null;
		let currentPlaceId = null;

		// Listen for observationFetch events to track the current observation's taxon ID
		document.addEventListener('observationFetch', event => {
			const obs = event.detail.observation;
			if (obs) {
				currentTaxonId = obs.taxon ? obs.taxon.id : null;
				currentPlaceId = (obs.place_ids && obs.place_ids.length) ? obs.place_ids[0] : null;

				// If our similar species tab is active, reload suggestions automatically
				const tabBtn = document.getElementById('inat-similar-tab-btn');
				if (tabBtn && tabBtn.classList.contains('active')) {
					loadSimilarSpecies();
				}
			}
		});

		// Listen for the tabs to load in the observation modal
		document.arrive('ul.inat-tabs', { existing: true }, function () {
			const tabList = this;
			if (tabList.querySelector('#inat-similar-tab-btn')) return; // Already injected

			const sidebar = tabList.parentNode.querySelector('.sidebar');
			if (!sidebar) return; // Should have a sidebar sibling

			// Create tab button element
			const li = document.createElement('li');
			li.id = 'inat-similar-tab-btn';
			li.innerHTML = '<button type="button" class="btn btn-nostyle">Similar Species</button>';

			// Append tab button
			tabList.appendChild(li);

			// Create tab panel container
			const panel = document.createElement('div');
			panel.id = 'inat-similar-tab-panel';
			panel.className = 'inat-tab similar-tab';
			panel.style.display = 'none';

			// Append tab panel to sidebar
			sidebar.appendChild(panel);

			// Bind click event
			const btn = li.querySelector('button');
			btn.addEventListener('click', e => {
				e.preventDefault();
				activateSimilarTab();
			});

			// Watch for clicks on any native tab buttons to deactivate our tab and restore states
			tabList.addEventListener('click', e => {
				const button = e.target.closest('button');
				if (!button) return;
				const tabItem = button.closest('li');
				if (tabItem && tabItem !== li) {
					deactivateSimilarTab();
					tabItem.classList.add('active');
				}
			});

			function activateSimilarTab() {
				li.classList.add('active');

				// Remove active class from native tab buttons
				Array.from(tabList.children).forEach(sibling => {
					if (sibling !== li) {
						sibling.classList.remove('active');
					}
				});

				// Hide React tab content panels inside sidebar
				Array.from(sidebar.children).forEach(child => {
					if (child !== panel) {
						child.style.display = 'none';
					}
				});

				panel.style.display = 'block';
				loadSimilarSpecies();
			}

			function deactivateSimilarTab() {
				if (!li.classList.contains('active')) return;

				li.classList.remove('active');
				panel.style.display = 'none';

				// Restore React tab content panels inside sidebar
				Array.from(sidebar.children).forEach(child => {
					if (child !== panel) {
						child.style.display = '';
					}
				});
			}

			// Watch for native tab activations (handles click & keyboard navigation e.g. SHIFT + arrow keys)
			const observer = new MutationObserver(mutations => {
				mutations.forEach(mutation => {
					if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
						const target = mutation.target;
						if (target !== li && target.classList.contains('active')) {
							deactivateSimilarTab();
						}
					}
				});
			});
			observer.observe(tabList, { attributes: true, subtree: true, attributeFilter: ['class'] });
		});

		// ── Core Functionality ───────────────────────────────────────────────

		async function loadSimilarSpecies() {
			const panel = document.getElementById('inat-similar-tab-panel');
			if (!panel) return;

			// Fallback to DOM parsing if currentTaxonId is not loaded yet
			if (!currentTaxonId) {
				currentTaxonId = getTaxonIdFromDOM();
			}

			panel.innerHTML = `
				<div class="inat-similar-header">
					<h3>Commonly Confused Species</h3>
					<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
				</div>
				<div class="inat-similar-loading">
					<div class="inat-similar-spinner"></div>
					<span>Loading similar species...</span>
				</div>
			`;

			if (!currentTaxonId) {
				panel.innerHTML = `
					<div class="inat-similar-header">
						<h3>Commonly Confused Species</h3>
						<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
					</div>
					<div class="inat-similar-empty">
						No similar species data available (observation is unidentified).
					</div>
				`;
				return;
			}

			try {
				const data = await fetchSimilarSpecies(currentTaxonId);
				const results = data.results || [];

				if (!results.length) {
					panel.innerHTML = `
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
					<div class="inat-similar-header">
						<h3>Commonly Confused Species</h3>
						<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
					</div>
					${gridHTML}
				`;

			} catch (error) {
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

		// ── Helpers ──────────────────────────────────────────────────────────

		async function fetchSimilarSpecies(taxonId) {
			const url = `https://api.inaturalist.org/v1/identifications/similar_species?taxon_id=${taxonId}`;
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`API returned HTTP ${response.status}`);
			}
			return await response.json();
		}

		function getTaxonIdFromDOM() {
			const selectors = [
				'.ObservationModal a[href*="/taxa/"]',
				'.ObservationDetail a[href*="/taxa/"]',
				'.obs-media a[href*="/taxa/"]',
				'.right-col a[href*="/taxa/"]',
				'a[href*="/taxa/"]'
			];

			for (const selector of selectors) {
				const links = document.querySelectorAll(selector);
				for (const link of links) {
					const href = link.getAttribute('href');
					if (href) {
						const match = href.match(/\/taxa\/(\d+)/);
						if (match) {
							return match[1];
						}
					}
				}
			}
			return null;
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
