(function () {
	'use strict';

	// Load settings from storage
	chrome.storage.sync.get({ enableTaxonPhotosTab: true }, function (settings) {
		if (chrome.runtime.lastError || !settings || !settings.enableTaxonPhotosTab) return;

		let currentTaxon = null;
		let currentPlaceId = 97392; // Default to Africa (place_id: 97392)
		let currentQualityGrade = ''; // Default to Any
		let currentTabActive = false;
		let currentPage = 1;
		let isLoading = false;
		let hasMore = true;
		let photosCtrl = null;
		let tabObserver = null;

		// ── Listen for observation fetch event ───────────────────────────────
		document.addEventListener('observationFetch', event => {
			const obs = event.detail.observation;
			if (!obs) return;

			const taxon = obs.taxon;
			
			// We only show the tab for Order level or below (rank_level <= 40)
			if (taxon && typeof taxon.rank_level === 'number' && taxon.rank_level <= 40) {
				currentTaxon = taxon;
				ensureTabInjected();
				resetPhotos();
				if (currentTabActive) {
					loadPhotos();
				}
			} else {
				// No taxon, or taxon is above Order level (e.g. Class, Kingdom/plants, etc.)
				currentTaxon = null;
				deactivateCustomTab();
				removeTabElements();
			}
		});

		// ── Modal Arrive & Leave hooks ───────────────────────────────────────
		document.arrive('.ObservationModal .sidebar', { existing: true }, function () {
			if (currentTaxon) {
				ensureTabInjected();
			}
		});

		document.leave('.ObservationModal', function () {
			currentTabActive = false;
			stopTabObserver();
			resetPhotos();
		});

		// ── Tab Management ───────────────────────────────────────────────────
		function ensureTabInjected() {
			const modal = document.querySelector('.ObservationModal');
			if (!modal) return;

			const tabsList = modal.querySelector('.inat-tabs');
			const sidebar = modal.querySelector('.sidebar');
			if (!tabsList || !sidebar) return;

			// 1. Inject Tab Button
			let tabLi = document.getElementById('inat-taxon-photos-tab-li');
			if (!tabLi) {
				tabLi = document.createElement('li');
				tabLi.id = 'inat-taxon-photos-tab-li';
				tabLi.className = 'taxon-photos-tab-li';
				tabLi.innerHTML = `<button type="button" class="btn btn-nostyle">Photos</button>`;
				tabsList.appendChild(tabLi);

				tabLi.querySelector('button').addEventListener('click', e => {
					e.preventDefault();
					activateCustomTab();
				});
			}

			// Intercept clicks on native tab buttons to yield when custom tab is active
			if (!tabsList.dataset.inatPhotosClickInit) {
				tabsList.dataset.inatPhotosClickInit = 'true';
				tabsList.addEventListener('click', e => {
					const btn = e.target.closest('button');
					if (!btn) return;
					const li = btn.closest('li');
					if (li && !li.classList.contains('taxon-photos-tab-li')) {
						if (currentTabActive) {
							deactivateCustomTab();
							// Highlight native tab clicked in UI
							li.classList.add('active');
						}
					}
				});
			}

			// 2. Inject Tab Panel
			let panel = document.getElementById('inat-taxon-photos-panel');
			if (!panel) {
				panel = document.createElement('div');
				panel.id = 'inat-taxon-photos-panel';
				panel.className = 'inat-tab taxon-photos-tab';
				panel.innerHTML = `
					<div class="taxon-photos-header">
						<h3 class="taxon-name-title">Taxon Photos</h3>
						<p class="taxon-photos-desc" style="margin-bottom: 6px;">Observations of this taxon from iNaturalist.</p>
						<a href="" target="_blank" rel="noopener" class="taxon-photos-browse-link" style="display: inline-block; font-size: 11px; font-weight: bold; color: #74ac00; text-decoration: none; margin-bottom: 12px;">Browse photos on iNaturalist &raquo;</a>
						<div class="taxon-photos-controls" style="display: flex; flex-direction: column; gap: 8px; border-top: 1px solid rgba(0, 0, 0, 0.05); padding-top: 8px;">
							<label for="taxon-photos-africa-chk" style="display: flex; align-items: center; gap: 6px; font-weight: normal; margin: 0; cursor: pointer; font-size: 13px;">
								<input type="checkbox" id="taxon-photos-africa-chk" checked>
								<span>Filter by Africa</span>
							</label>
							<label for="taxon-photos-quality-select" style="display: flex; align-items: center; gap: 6px; font-weight: normal; margin: 0; cursor: pointer; font-size: 13px;">
								<span>Quality:</span>
								<select id="taxon-photos-quality-select" style="padding: 2px 4px; font-size: 12px; border: 1px solid #ccc; border-radius: 3px; background: #fff; cursor: pointer;">
									<option value="">Any</option>
									<option value="research">Research Grade</option>
								</select>
							</label>
						</div>
					</div>
					<div id="taxon-photos-error-container" class="taxon-photos-error" style="display: none;"></div>
					<ul class="taxon-photos-grid"></ul>
					<div class="taxon-photos-loading-container" style="display: none;">
						<div class="taxon-photos-spinner"></div>
						<span>Loading photos...</span>
					</div>
					
					<div class="taxon-photos-pagination-container" style="display: none; align-items: center; justify-content: space-between; margin-top: 15px; padding-top: 12px; border-top: 1px solid rgba(0, 0, 0, 0.08);">
						<button type="button" class="taxon-photos-prev-btn" style="padding: 6px 12px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background: #f8f8f8; cursor: pointer; font-weight: 600;">&lsaquo; Prev</button>
						<span class="taxon-photos-page-display" style="font-size: 12px; color: #555; font-weight: bold;">Page 1</span>
						<button type="button" class="taxon-photos-next-btn" style="padding: 6px 12px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background: #f8f8f8; cursor: pointer; font-weight: 600;">Next &rsaquo;</button>
					</div>
				`;
				sidebar.appendChild(panel);

				// Africa checkbox event
				panel.querySelector('#taxon-photos-africa-chk').addEventListener('change', e => {
					currentPlaceId = e.target.checked ? 97392 : null;
					resetPhotos();
					loadPhotos();
				});

				// Quality Select event
				panel.querySelector('#taxon-photos-quality-select').addEventListener('change', e => {
					currentQualityGrade = e.target.value;
					resetPhotos();
					loadPhotos();
				});

				// Prev Button Click
				panel.querySelector('.taxon-photos-prev-btn').addEventListener('click', () => {
					if (!isLoading && currentPage > 1) {
						currentPage--;
						const grid = panel.querySelector('.taxon-photos-grid');
						if (grid) grid.innerHTML = '';
						loadPhotos();
					}
				});

				// Next Button Click
				panel.querySelector('.taxon-photos-next-btn').addEventListener('click', () => {
					if (!isLoading && hasMore) {
						currentPage++;
						const grid = panel.querySelector('.taxon-photos-grid');
						if (grid) grid.innerHTML = '';
						loadPhotos();
					}
				});
			}

			// Update header details with current taxon info
			updateHeaderDetails();
			startTabObserver();
		}

		function removeTabElements() {
			const tabLi = document.getElementById('inat-taxon-photos-tab-li');
			if (tabLi) tabLi.remove();

			const panel = document.getElementById('inat-taxon-photos-panel');
			if (panel) panel.remove();

			stopTabObserver();
		}

		function updateHeaderDetails() {
			const panel = document.getElementById('inat-taxon-photos-panel');
			if (!panel || !currentTaxon) return;

			const titleEl = panel.querySelector('.taxon-name-title');
			if (titleEl) {
				const common = currentTaxon.preferred_common_name || '';
				const sci = currentTaxon.name || '';
				if (common && sci) {
					titleEl.innerHTML = `${escapeHtml(common)} (<em>${escapeHtml(sci)}</em>) Photos`;
				} else {
					titleEl.innerHTML = `<em>${escapeHtml(sci || common || 'Taxon')}</em> Photos`;
				}
			}

			const browseLink = panel.querySelector('.taxon-photos-browse-link');
			if (browseLink) {
				browseLink.href = `https://www.inaturalist.org/taxa/${currentTaxon.id}/browse_photos`;
			}
		}

		function activateCustomTab() {
			currentTabActive = true;

			// Make tab button active
			const tabLi = document.getElementById('inat-taxon-photos-tab-li');
			if (tabLi) tabLi.classList.add('active');

			// Deactivate native tab buttons
			document.querySelectorAll('.ObservationModal .inat-tabs li:not(.taxon-photos-tab-li)').forEach(li => {
				li.classList.remove('active');
			});

			// Make panel active
			const panel = document.getElementById('inat-taxon-photos-panel');
			if (panel) panel.classList.add('active');

			// Hide native panels in sidebar via parent class on modal
			const modal = document.querySelector('.ObservationModal');
			if (modal) modal.classList.add('inat-custom-tab-active');

			// If grid is empty, fetch initial photos
			const grid = panel ? panel.querySelector('.taxon-photos-grid') : null;
			if (grid && grid.children.length === 0 && !isLoading) {
				resetPhotos();
				loadPhotos();
			}
		}

		function deactivateCustomTab() {
			currentTabActive = false;

			const tabLi = document.getElementById('inat-taxon-photos-tab-li');
			if (tabLi) tabLi.classList.remove('active');

			const panel = document.getElementById('inat-taxon-photos-panel');
			if (panel) panel.classList.remove('active');

			const modal = document.querySelector('.ObservationModal');
			if (modal) modal.classList.remove('inat-custom-tab-active');
		}

		function startTabObserver() {
			if (tabObserver) return;
			const tabsList = document.querySelector('.ObservationModal .inat-tabs');
			if (!tabsList) return;

			tabObserver = new MutationObserver(mutations => {
				mutations.forEach(mutation => {
					if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
						const target = mutation.target;
						// If a native tab button becomes active, we yield and deactivate ours
						if (target.classList.contains('active') && !target.classList.contains('taxon-photos-tab-li')) {
							deactivateCustomTab();
						}
					}
				});
			});

			tabObserver.observe(tabsList, {
				subtree: true,
				attributes: true,
				attributeFilter: ['class']
			});
		}

		function stopTabObserver() {
			if (tabObserver) {
				tabObserver.disconnect();
				tabObserver = null;
			}
		}

		// ── Photos Loading & Fetching ────────────────────────────────────────
		function resetPhotos() {
			currentPage = 1;
			hasMore = true;
			isLoading = false;
			if (photosCtrl) {
				photosCtrl.abort();
				photosCtrl = null;
			}

			const panel = document.getElementById('inat-taxon-photos-panel');
			if (panel) {
				const grid = panel.querySelector('.taxon-photos-grid');
				if (grid) grid.innerHTML = '';

				const err = panel.querySelector('#taxon-photos-error-container');
				if (err) {
					err.style.display = 'none';
					err.textContent = '';
				}

				const pagination = panel.querySelector('.taxon-photos-pagination-container');
				if (pagination) pagination.style.display = 'none';
			}
		}

		async function loadPhotos() {
			if (!currentTaxon || isLoading) return;

			const panel = document.getElementById('inat-taxon-photos-panel');
			if (!panel) return;

			const grid = panel.querySelector('.taxon-photos-grid');
			const loader = panel.querySelector('.taxon-photos-loading-container');
			const errContainer = panel.querySelector('#taxon-photos-error-container');
			const pagination = panel.querySelector('.taxon-photos-pagination-container');

			isLoading = true;
			if (loader) loader.style.display = 'flex';
			if (errContainer) errContainer.style.display = 'none';
			if (pagination) pagination.style.display = 'none';

			if (photosCtrl) photosCtrl.abort();
			photosCtrl = new AbortController();

			try {
				let url = `https://api.inaturalist.org/v1/observations?taxon_id=${currentTaxon.id}&photos=true&per_page=12&page=${currentPage}&only_id=false`;
				if (currentPlaceId) {
					url += `&place_id=${currentPlaceId}`;
				}
				if (currentQualityGrade) {
					url += `&quality_grade=${currentQualityGrade}`;
				}

				const res = await fetch(url, { signal: photosCtrl.signal });
				if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

				const data = await res.json();
				const observations = data.results || [];

				if (currentPage === 1 && observations.length === 0) {
					renderEmptyState(grid);
					hasMore = false;
				} else {
					renderPhotoGrid(grid, observations);
					// If we pulled fewer observations than per_page (12), there are no more next pages
					hasMore = observations.length === 12;
				}

				updatePaginationControls(panel);

			} catch (err) {
				if (err.name !== 'AbortError') {
					console.error('[iNat Enhancement] Taxon Photos error:', err);
					if (errContainer) {
						errContainer.textContent = `Failed to load photos: ${err.message}`;
						errContainer.style.display = 'block';
					}
				}
			} finally {
				isLoading = false;
				if (loader) loader.style.display = 'none';
			}
		}

		function renderPhotoGrid(grid, observations) {
			if (!grid) return;

			let html = '';
			observations.forEach(obs => {
				const photo = obs.photos && obs.photos[0];
				if (!photo) return;

				const photoUrl = getMediumPhotoUrl(photo.url);
				if (!photoUrl) return;

				const obsUrl = `https://www.inaturalist.org/observations/${obs.id}`;
				const userLogin = obs.user ? obs.user.login : 'unknown';
				const taxonName = obs.taxon ? (obs.taxon.preferred_common_name || obs.taxon.name) : 'Taxon';
				const titleText = `${taxonName} observed by ${userLogin}`;

				html += `
					<li class="taxon-photos-item">
						<a href="${escapeAttr(obsUrl)}" target="_blank" rel="noopener" title="${escapeAttr(titleText)}">
							<img src="${escapeAttr(photoUrl)}" alt="${escapeAttr(titleText)}" loading="lazy">
						</a>
					</li>
				`;
			});

			grid.innerHTML = html;
		}

		function renderEmptyState(grid) {
			if (!grid) return;
			const msg = currentPlaceId
				? `<strong>No photos found in Africa</strong>Try unchecking the "Filter by Africa" checkbox above to view photos globally.`
				: `<strong>No photos found</strong>There are no observations with photos for this taxon.`;

			grid.innerHTML = `<li style="grid-column: span 3;"><div class="taxon-photos-empty">${msg}</div></li>`;
		}

		function updatePaginationControls(panel) {
			if (!panel) return;
			const pagination = panel.querySelector('.taxon-photos-pagination-container');
			if (!pagination) return;

			const prevBtn = pagination.querySelector('.taxon-photos-prev-btn');
			const nextBtn = pagination.querySelector('.taxon-photos-next-btn');
			const display = pagination.querySelector('.taxon-photos-page-display');

			// Hide pagination if on first page and there is no next page
			if (currentPage === 1 && !hasMore) {
				pagination.style.display = 'none';
				return;
			}

			pagination.style.display = 'flex';
			display.textContent = `Page ${currentPage}`;

			// Update Previous button state
			if (currentPage > 1) {
				prevBtn.removeAttribute('disabled');
				prevBtn.style.opacity = '1';
				prevBtn.style.cursor = 'pointer';
			} else {
				prevBtn.setAttribute('disabled', 'true');
				prevBtn.style.opacity = '0.5';
				prevBtn.style.cursor = 'not-allowed';
			}

			// Update Next button state
			if (hasMore) {
				nextBtn.removeAttribute('disabled');
				nextBtn.style.opacity = '1';
				nextBtn.style.cursor = 'pointer';
			} else {
				nextBtn.setAttribute('disabled', 'true');
				nextBtn.style.opacity = '0.5';
				nextBtn.style.cursor = 'not-allowed';
			}
		}

		// ── Helpers ──────────────────────────────────────────────────────────
		function getMediumPhotoUrl(url) {
			if (!url) return '';
			return url.replace(/\/(square|small|thumb|large|original)\./i, '/medium.');
		}

		// Simple HTML escape helper
		function escapeHtml(v) {
			const d = document.createElement('div');
			d.textContent = String(v == null ? '' : v);
			return d.innerHTML;
		}

		// Simple attribute escape helper
		function escapeAttr(v) {
			return escapeHtml(v).replace(/"/g, '&quot;');
		}
	});
})();
