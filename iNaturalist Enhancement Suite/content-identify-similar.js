(function () {
	'use strict';

	let handleObservationFetch = null;
	let handleObservationChanging = null;
	let bufferedObservationFetchEvent = null;
	document.addEventListener('observationFetch', event => {
		if (handleObservationFetch) {
			handleObservationFetch(event);
		} else {
			bufferedObservationFetchEvent = event;
		}
	});
	document.addEventListener('inatExtObservationChanging', () => {
		bufferedObservationFetchEvent = null;
		if (handleObservationChanging) handleObservationChanging();
	});

	// Load settings from storage
	chrome.storage.sync.get({ enableSimilarSpeciesTab: true, enableIdentifyFastReview: true }, function (settings) {
		if (chrome.runtime.lastError) {
			console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
			return;
		}
		if (!settings || !settings.enableSimilarSpeciesTab) return;

		let currentTaxon = null;
		let currentPlaceId = null;
		let currentObservationId = null;
		let currentObservationKey = null;
		let currentObservationLoaded = false;
		let currentObservationState = 'pending';
		let loadSequence = 0;
		let similarAbortController = null;
		let observationRecoveryTimer = null;
		let observationRecoverySequence = 0;
		let observationRecoveryController = null;
		let observedModal = null;
		let modalObserver = null;
		let syncFrame = null;
		const panelSyncTimers = new Set();
		const taxonCache = new Map();
		let currentClassificationHtml = '';
		let currentClassificationTaxon = null;
		let classificationObserver = null;

		function shouldDeferFastIdentifyExtras() {
			return settings.enableIdentifyFastReview !== false
				&& window.location.pathname === '/observations/identify'
				&& !currentTaxon;
		}

		function getCurrentModal() {
			return document.querySelector('.ObservationModal.in, .ObservationModal');
		}

		function getModalObservationId(modal = getCurrentModal()) {
			const href = modal?.querySelector(
				'.obs-modal-header a[href^="/observations/"], a.permalink[href^="/observations/"]'
			)?.getAttribute('href');
			const match = href?.match(/^\/observations\/([^/?#]+)/);
			return match ? match[1] : null;
		}

		function cancelObservationRecovery() {
			observationRecoverySequence += 1;
			clearTimeout(observationRecoveryTimer);
			observationRecoveryTimer = null;
			if (observationRecoveryController) observationRecoveryController.abort();
			observationRecoveryController = null;
		}

		function scheduleObservationRecovery(delay = 350) {
			const observationId = getModalObservationId();
			if (!observationId) return;
			if (currentObservationLoaded && String(currentObservationId) === String(observationId)) return;

			clearTimeout(observationRecoveryTimer);
			const sequence = ++observationRecoverySequence;
			observationRecoveryTimer = setTimeout(async () => {
				observationRecoveryTimer = null;
				if (sequence !== observationRecoverySequence) return;
				if (currentObservationLoaded && String(currentObservationId) === String(observationId)) return;

				const controller = new AbortController();
				observationRecoveryController = controller;
				try {
					const response = await fetch(
						`https://api.inaturalist.org/v1/observations/${encodeURIComponent(observationId)}`,
						{ signal: controller.signal }
					);
					if (!response.ok) return;
					const data = await response.json();
					const observation = data.results?.[0];
					if (!observation || sequence !== observationRecoverySequence) return;
					if (String(getModalObservationId()) !== String(observation.id || observationId)) return;

					document.dispatchEvent(new CustomEvent('observationFetch', {
						detail: {
							location: observation.location,
							observation,
							observationId: observation.id || observationId,
							fallback: true
						}
					}));
				} catch (error) {
					if (error.name !== 'AbortError') {
						console.debug('[iNat Enhancement] Similar Species observation recovery skipped:', error);
					}
				} finally {
					if (observationRecoveryController === controller) observationRecoveryController = null;
				}
			}, delay);
		}

		function schedulePanelSync() {
			if (syncFrame !== null) return;
			const run = () => {
				syncFrame = null;
				syncSimilarSection();
			};
			if (typeof requestAnimationFrame === 'function') {
				syncFrame = requestAnimationFrame(run);
			} else {
				syncFrame = setTimeout(run, 0);
			}
		}

		function cancelPanelSyncRetries() {
			panelSyncTimers.forEach(timer => clearTimeout(timer));
			panelSyncTimers.clear();
		}

		function schedulePanelSyncRetries() {
			cancelPanelSyncRetries();
			[0, 100, 300, 600, 1200].forEach(delay => {
				const timer = setTimeout(() => {
					panelSyncTimers.delete(timer);
					schedulePanelSync();
				}, delay);
				panelSyncTimers.add(timer);
			});
		}

		function observeModal(modal) {
			if (!modal || observedModal === modal) return;
			if (modalObserver) modalObserver.disconnect();
			observedModal = modal;
			let lastObservationId = getModalObservationId(modal);
			modalObserver = new MutationObserver(() => {
				const observationId = getModalObservationId(modal);
				if (observationId && observationId !== lastObservationId) {
					lastObservationId = observationId;
					if (!currentObservationLoaded || String(currentObservationId) !== String(observationId)) {
						currentObservationLoaded = false;
						currentObservationState = 'pending';
						currentObservationId = null;
						currentTaxon = null;
						currentPlaceId = null;
					}
					scheduleObservationRecovery();
				}
				schedulePanelSync();
			});
			modalObserver.observe(modal, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['class', 'href']
			});
		}

		function removePanelFromModal(modal = getCurrentModal()) {
			if (!modal) return;
			modal.querySelectorAll('#inat-similar-section').forEach(panel => panel.remove());
			modal.querySelectorAll('.inat-inline-taxonomy[data-inat-embedded="true"]')
				.forEach(element => element.remove());
		}

		function getLeadingTaxonFromModal(modal) {
			const candidates = [...modal.querySelectorAll(
				'.leading.panel.panel-default, .ActivityItem.identification'
			)];
			if (!candidates.length) return null;

			const activeCard = candidates.find(card => (
				/suggested an ID/i.test(card.textContent || '')
				&& /leading/i.test(card.textContent || '')
				&& !/withdrawn/i.test(card.textContent || '')
			)) || candidates.find(card => (
				/suggested an ID/i.test(card.textContent || '')
				&& !/withdrawn/i.test(card.textContent || '')
			));
			if (!activeCard) return null;

			const taxonLink = [...activeCard.querySelectorAll('a[href]')].find(link => {
				const path = new URL(link.href, window.location.href).pathname;
				return /\/taxa\/\d+(?:-|$)/.test(path);
			});
			const match = taxonLink?.href.match(/\/taxa\/(\d+)/);
			if (!match) return null;

			return {
				id: Number(match[1]),
				name: taxonLink.textContent.trim(),
				rank: null
			};
		}

		function syncSimilarSection() {
			const modal = getCurrentModal();
			if (!modal) return;
			observeModal(modal);

			const infoTabInner = modal.querySelector('.info-tab-inner');
			if (!infoTabInner) {
				scheduleObservationRecovery();
				return;
			}

			const modalObservationId = getModalObservationId(modal);
			if (!modalObservationId) {
				removePanelFromModal(modal);
				scheduleObservationRecovery();
				return;
			}

			if (!currentTaxon || String(currentObservationId) !== String(modalObservationId)) {
				const leadingTaxon = getLeadingTaxonFromModal(modal);
				if (leadingTaxon) {
					currentObservationId = modalObservationId;
					currentObservationState = 'identified';
					currentTaxon = leadingTaxon;
					currentPlaceId = null;
					scheduleObservationRecovery();
				} else {
					removePanelFromModal(modal);
					scheduleObservationRecovery();
					return;
				}
			}

			if (currentObservationState !== 'identified' || !currentTaxon) {
				removePanelFromModal(modal);
				return;
			}

			const panel = ensureSimilarSection(infoTabInner);
			if (!panel) return;
			if (panel.dataset.inatObservationKey !== `${currentObservationId}:${currentTaxon.id || ''}`) {
				loadSimilarSpecies({ includeSimilar: false });
			}
		}

		// Listen for observationFetch events to track the current observation's taxon ID.
		handleObservationFetch = event => {
			const obs = event.detail?.observation;
			if (obs) {
				currentObservationId = event.detail?.observationId || obs.id || null;
				currentObservationState = obs.taxon ? 'identified' : 'unknown';
				currentObservationLoaded = true;
				currentTaxon = obs.taxon || null;
				currentPlaceId = (obs.place_ids && obs.place_ids.length) ? obs.place_ids[0] : null;
				currentObservationKey = `${currentObservationId || ''}:${currentTaxon?.id || ''}`;
				cancelObservationRecovery();
				schedulePanelSyncRetries();
			}
		};
		if (bufferedObservationFetchEvent) {
			const event = bufferedObservationFetchEvent;
			bufferedObservationFetchEvent = null;
			handleObservationFetch(event);
		}

		// Abort classification work as soon as navigation starts rather than
		// waiting for the next full observation response to arrive.
		handleObservationChanging = () => {
			cancelPanelSyncRetries();
			cancelObservationRecovery();
			loadSequence += 1;
			if (similarAbortController) similarAbortController.abort();
			similarAbortController = null;
			currentObservationId = null;
			currentObservationKey = null;
			currentObservationLoaded = false;
			currentObservationState = 'pending';
			currentTaxon = null;
			currentPlaceId = null;
			currentClassificationHtml = '';
			currentClassificationTaxon = null;
			removePanelFromModal();
			scheduleObservationRecovery();
		};

		// The native Info panel puts map/details first and identification activity after it.
		// Appending here gives the section the full sidebar width below the suggested IDs.
		document.arrive('.ObservationModal .info-tab-inner', { existing: true }, function () {
				observeModal(this.closest('.ObservationModal'));
				schedulePanelSyncRetries();
			});
			document.arrive('.ObservationModal', { existing: true }, function () {
				observeModal(this);
				schedulePanelSyncRetries();
				scheduleObservationRecovery();
			});

		function ensureSimilarSection(infoTabInner = document.querySelector('.ObservationModal .info-tab-inner')) {
			if (shouldDeferFastIdentifyExtras()) {
				removeSimilarSection();
				return null;
			}
			if (!infoTabInner) return null;
			const existingPanel = infoTabInner.querySelector('#inat-similar-section');
			if (existingPanel) return existingPanel;

			const panel = document.createElement('div');
			panel.id = 'inat-similar-section';
			panel.className = 'inat-similar-section';
			infoTabInner.appendChild(panel);
			return panel;
		}

		function removeSimilarSection() {
			loadSequence += 1;
			if (similarAbortController) similarAbortController.abort();
			similarAbortController = null;
			if (classificationObserver) {
				classificationObserver.disconnect();
				classificationObserver = null;
			}
			removePanelFromModal();
			currentClassificationHtml = '';
			currentClassificationTaxon = null;
			removeEmbeddedClassification();
		}

		// iNaturalist can render the leading identification card after the info
		// panel. Relocate a fallback taxonomy block once that card arrives.
		document.arrive('.ObservationModal .leading.panel.panel-default', { existing: true }, function () {
				schedulePanelSync();
			});
		document.arrive('.ObservationModal .ActivityItem.identification', { existing: true }, function () {
				schedulePanelSync();
			});

		// ── Core Functionality ───────────────────────────────────────────────

		async function loadSimilarSpecies({ includeSimilar = false } = {}) {
			if (shouldDeferFastIdentifyExtras()) {
				removeSimilarSection();
				return;
			}
			const panel = document.getElementById('inat-similar-section');
			if (!panel) return;
			const sequence = ++loadSequence;
			if (similarAbortController) similarAbortController.abort();
			const taxon = currentTaxon;
			const observationId = currentObservationId;
			const observationKey = `${observationId || ''}:${taxon?.id || ''}`;
			panel.dataset.inatObservationKey = observationKey;
			currentClassificationHtml = '';
			currentClassificationTaxon = null;
			removeEmbeddedClassification();

			panel.innerHTML = `
				<div class="inat-similar-header">
					<h3>Commonly Confused Species</h3>
					<p>These species are most frequently misidentified as the observed taxon on iNaturalist.</p>
				</div>
				<div class="inat-similar-loading">
					<div class="inat-similar-spinner"></div>
					<span>Loading classification...</span>
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

			const requestController = new AbortController();
			similarAbortController = requestController;
			const { signal } = requestController;

			try {
				const classificationHtml = await buildClassification(taxon, signal);
				if (!isCurrentPanel(panel, sequence)) return;
				currentClassificationHtml = classificationHtml;
				currentClassificationTaxon = taxon;
				watchClassificationPlacement(panel);
				renderClassification(panel, classificationHtml, taxon);

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

				if (!includeSimilar) {
					const loading = panel.querySelector('.inat-similar-loading');
					if (!loading) return;
					loading.outerHTML = `
						<div class="inat-similar-prompt">
							<p>Classification is ready. Load the commonly confused species comparison when needed.</p>
							<button type="button" class="inat-load-similar-btn">Load commonly confused species</button>
						</div>
					`;
					panel.querySelector('.inat-load-similar-btn')?.addEventListener('click', () => {
						loadSimilarSpecies({ includeSimilar: true });
					}, { once: true });
					return;
				}

				const data = await fetchSimilarSpecies(taxon.id, signal);
				if (!isCurrentPanel(panel, sequence)) return;
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
					renderClassification(panel, classificationHtml, taxon);
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
								<button class="inat-similar-select-btn" data-index="${index}">Select</button>
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
				renderClassification(panel, classificationHtml, taxon);

				panel.querySelectorAll('.inat-similar-select-btn').forEach(btn => {
					btn.addEventListener('click', event => {
						event.preventDefault();
						event.stopPropagation();
						const index = parseInt(btn.getAttribute('data-index'), 10);
						const item = results[index];
						if (item && item.taxon) {
							applyTaxonToForm(item.taxon);
						}
					});
				});


			} catch (error) {
				if (error.name === 'AbortError') return;
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
			} finally {
				if (similarAbortController === requestController) similarAbortController = null;
			}
		}

		function isCurrentPanel(panel, sequence) {
			return sequence === loadSequence
				&& panel.isConnected
				&& panel.dataset.inatObservationKey === `${currentObservationId || ''}:${currentTaxon?.id || ''}`
				&& panel.closest('.ObservationModal') === getCurrentModal()
				&& panel.closest('.info-tab-inner')
				&& panel.closest('.ObservationModal')?.querySelector('#inat-similar-section') === panel;
		}

		function removeEmbeddedClassification() {
			document.querySelectorAll('.inat-inline-taxonomy[data-inat-embedded="true"]')
				.forEach(element => element.remove());
		}

		function watchClassificationPlacement(panel) {
			const root = panel.closest('.info-tab-inner');
			if (!root) return;
			if (classificationObserver && classificationObserver.root === root) return;
			if (classificationObserver) classificationObserver.disconnect();

			const observer = new MutationObserver(() => {
				if (currentClassificationHtml && currentClassificationTaxon) {
					relocateClassification(panel);
				}
			});
			observer.root = root;
			observer.observe(root, { childList: true, subtree: true });
			classificationObserver = observer;
		}

		function findSuggestionCard(taxon, modal = getCurrentModal()) {
			if (!modal) return null;
			const cards = [...modal.querySelectorAll('.leading.panel.panel-default')];
			const fallbackCards = [...modal.querySelectorAll('.ActivityItem.identification')];
			const candidates = cards.length ? cards : fallbackCards;
			if (!candidates.length) return null;

			const taxonId = taxon?.id == null ? '' : String(taxon.id);
			if (taxonId) {
				const matchingCard = candidates.find(card => [...card.querySelectorAll('a[href]')]
					.some(link => new URL(link.href, window.location.href).pathname.includes(`/taxa/${taxonId}`)));
				if (matchingCard) return matchingCard;
			}

			return candidates.find(card => /suggested an id/i.test(card.textContent || '')) || candidates[0];
		}

		function renderClassification(panel, classificationHtml, taxon) {
			currentClassificationHtml = classificationHtml;
			currentClassificationTaxon = taxon;
			relocateClassification(panel);
		}

		function relocateClassification(panel) {
			if (!currentClassificationHtml || !currentClassificationTaxon || !panel.isConnected) return;
			const modal = panel.closest('.ObservationModal');
			if (!modal) return;

			let classification = modal.querySelector('.inat-inline-taxonomy[data-inat-embedded="true"]');
			if (!classification) {
				const template = document.createElement('template');
				template.innerHTML = currentClassificationHtml.trim();
				classification = template.content.firstElementChild;
				if (!classification) return;
				classification.dataset.inatEmbedded = 'true';
			}

			const suggestionCard = findSuggestionCard(currentClassificationTaxon, modal);
			if (!suggestionCard) {
				if (classification.parentElement !== panel) panel.insertBefore(classification, panel.firstChild);
				return;
			}

			classification.classList.add('inat-inline-taxonomy--embedded');
			const identification = suggestionCard.querySelector('.identification') || suggestionCard;
			if (classification.parentElement !== identification) identification.appendChild(classification);
		}

		// ── Helpers ──────────────────────────────────────────────────────────

		async function fetchSimilarSpecies(taxonId, signal) {
			const key = `inat-similar-${taxonId}`;
			const cached = await window.iNatCache.read(key);
			if (cached) {
				return cached;
			}
			const url = `https://api.inaturalist.org/v1/identifications/similar_species?taxon_id=${taxonId}`;
			const response = await fetch(url, { signal });
			if (!response.ok) {
				throw new Error(`API returned HTTP ${response.status}`);
			}
			const data = await response.json();
			await window.iNatCache.write(key, data);
			return data;
		}

		function isSpeciesLevelTaxon(taxon) {
			if (!taxon || !Number.isInteger(Number(taxon.id)) || Number(taxon.id) <= 0) return false;
			return ['species', 'subspecies', 'variety', 'form', 'hybrid'].includes(taxon.rank);
		}

		async function buildClassification(compactTaxon, signal) {
			const classificationKey = `inat-classification-${compactTaxon.id}`;
			const cachedTree = await window.iNatCache.read(classificationKey);
			if (cachedTree?.rootTaxonId && Array.isArray(cachedTree.taxa) && cachedTree.taxa.length) {
				cachedTree.taxa.forEach(taxon => {
					if (taxon?.id != null) taxonCache.set(String(taxon.id), taxon);
				});
				const cachedRootTaxon = cachedTree.taxa.find(taxon => String(taxon.id) === String(cachedTree.rootTaxonId));
				if (cachedRootTaxon) Object.assign(compactTaxon, cachedRootTaxon);
				return renderClassificationHtml(cachedTree.taxa);
			}

			const fullTaxon = await fetchTaxa([compactTaxon.id], signal).then(taxa => taxa[0] || compactTaxon);
			Object.assign(compactTaxon, fullTaxon);
			const ids = [...new Set([...(fullTaxon.ancestor_ids || []), fullTaxon.id])];
			const missingIds = ids.filter(id => !taxonCache.has(String(id)));
			if (missingIds.length) await fetchTaxa(missingIds, signal);
			const taxa = ids.map(id => taxonCache.get(String(id))).filter(Boolean);
			await window.iNatCache.write(classificationKey, {
				rootTaxonId: fullTaxon.id,
				taxonIds: ids,
				taxa
			});
			return renderClassificationHtml(taxa);
		}

		function renderClassificationHtml(taxa) {
			const links = taxa
				.map((taxon, index) => {
					const label = taxon.preferred_common_name || taxon.name;
					const separator = index ? '<span class="inat-classification-separator">›</span>' : '';
					const photoUrl = taxon.default_photo
						? getMediumPhotoUrl(taxon.default_photo.square_url || taxon.default_photo.medium_url || taxon.default_photo.url)
						: '';
					const photo = photoUrl
						? `<img class="inat-inline-taxonomy-thumb" src="${photoUrl}" alt="" loading="lazy">`
						: '<span class="inat-inline-taxonomy-thumb inat-inline-taxonomy-thumb--empty" aria-hidden="true"></span>';
					return `${separator}<a class="inat-classification-taxon" href="https://www.inaturalist.org/taxa/${taxon.id}" target="_blank" rel="noopener" title="${escapeHtml(taxon.name || label)}">${photo}<span>${escapeHtml(label)}</span></a>`;
				}).join('');

			return `
				<div class="inat-inline-taxonomy">
					<div class="inat-inline-taxonomy-label">Classification</div>
					<div class="inat-classification-path">${links}</div>
				</div>
			`;
		}

		async function fetchTaxa(ids, signal) {
			const results = [];
			const missingFromL1 = [];

			// Step 1: Check L1 in-memory cache
			for (const id of ids) {
				const idStr = String(id);
				if (taxonCache.has(idStr)) {
					results.push(taxonCache.get(idStr));
				} else {
					missingFromL1.push(id);
				}
			}

			if (missingFromL1.length === 0) {
				return results;
			}

			// Step 2: Check L2 persistent cache
			const l2Entries = await Promise.all(missingFromL1.map(async id => ({
				id,
				cached: await window.iNatCache.read(`inat-taxon-${id}`)
			})));
			const missingFromL2 = [];
			for (const { id, cached } of l2Entries) {
				if (cached) {
					taxonCache.set(String(id), cached);
					results.push(cached);
				} else {
					missingFromL2.push(id);
				}
			}

			if (missingFromL2.length === 0) {
				return results;
			}

			// Step 3: Fetch remaining from API in batches of 30
			for (let index = 0; index < missingFromL2.length; index += 30) {
				const batch = missingFromL2.slice(index, index + 30);
				const response = await fetch(`https://api.inaturalist.org/v1/taxa/${batch.join(',')}`, { signal });
				if (!response.ok) throw new Error(`Taxa API returned HTTP ${response.status}`);
				const data = await response.json();
				const newTaxa = data.results || [];
				for (const taxon of newTaxa) {
					taxonCache.set(String(taxon.id), taxon);
					results.push(taxon);
				}
				await Promise.all(newTaxa.map(taxon => window.iNatCache.write(`inat-taxon-${taxon.id}`, taxon)));
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
					if (event.detail.cancelled) return;

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
