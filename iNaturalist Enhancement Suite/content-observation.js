chrome.storage.sync.get({
	enableColorVision: true,
	enableCVPercentages: true,
	enableCopyGeo: true,
	enableIdentifierStats: true,
	enableQuickPlant: true,
	enableLogging: false
}, function(items) {
	if (chrome.runtime.lastError) {
		console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
		return;
	}
	// Use shared logging from logging.js
	const logDebug = window.iNatLogDebug || console.debug;
	const log = window.iNatLog || console.log;

	const DEFAULT_KEY_NAME = 'default';
	const FLAG_CLASS = 'expanded';

	logDebug('Settings loaded:', items);

	if (items.enableIdentifierStats) {
		document.arrive('.ActivityItem.identification', async div => {
			const userAnchor = div.querySelector('a.user')
			const taxonAnchor = div.querySelector('.taxon > a')
			if (userAnchor && taxonAnchor) {
				const user = userAnchor.innerHTML;
				const taxonParts = taxonAnchor.href.split('/')
				const taxonId = taxonParts[taxonParts.length - 1];
				const url = `https://api.inaturalist.org/v1/identifications/categories?user_login=${user}&taxon_id=${taxonId}`;

				const key = `inat-userstats-${user}-${taxonId}`;
				let data = await window.iNatCache.read(key);
				if (!data) {
					const response = await fetch(url);
					data = await response.json();
					await window.iNatCache.write(key, data);
				}

				if (data && data.results && data.results.length) {
					const leading = data.results.find(c => c.category === 'leading');
					const improving = data.results.find(c => c.category === 'improving');
					const supporting = data.results.find(c => c.category === 'supporting');
					const maverick = data.results.find(c => c.category === 'maverick');
					const leadingCount = leading ? leading.count : 0;
					const improvingCount = improving ? improving.count : 0;
					const supportingCount = supporting ? supporting.count : 0;
					const maverickCount = maverick ? maverick.count : 0;
					const span = div.querySelector('span.title_text');
					if (span) {
						const title = `Leading: ${leadingCount}&#010;Improving: ${improvingCount}&#010;Supporting: ${supportingCount}&#010;Maverick: ${maverickCount}`;
						const countMarkup = `<span title="${title}">(${leadingCount + improvingCount})</span>`;
						span.innerHTML = span.innerHTML.replace('</a>', `</a> ${countMarkup}`);
					}
				}
			}
		})
	}


	let location;
	let currentTaxon = null;
	let currentSpeciesGuess = null;
	let computerVisionResults = new Map();
	const hierarchyTaxaCache = new Map();

	function injectHierarchyStyles() {
		if (document.getElementById('inat-main-cv-hierarchy-styles')) return;
		const style = document.createElement('style');
		style.id = 'inat-main-cv-hierarchy-styles';
		style.textContent = `
			.inat-main-cv-hierarchy {
				display: flex;
				flex-wrap: wrap;
				gap: 3px 5px;
				width: 100%;
				margin-top: 5px;
				padding-top: 5px;
				border-top: 1px solid rgba(0, 0, 0, 0.08);
				font-size: 10px;
				line-height: 1.35;
			}
			.inat-main-cv-hierarchy a {
				color: #5f7044;
				text-decoration: none;
			}
			.inat-main-cv-hierarchy a:hover {
				color: #337ab7;
				text-decoration: underline;
			}
			.inat-main-cv-hierarchy-separator {
				color: #aaa;
			}
			.inat-main-cv-hierarchy-loading {
				color: #999;
				font-style: italic;
			}
		`;
		document.head.appendChild(style);
	}

	injectHierarchyStyles();

	if (window.location.pathname === '/observations/identify') {
		enableIdentifyAutoPaging();
	}

	function enableIdentifyAutoPaging() {
		document.documentElement.style.overscrollBehaviorY = 'none';
		let observedPagination = null;
		let loadingPage = false;
		let pageLoaded = false;
		let lastTriggeredPage = null;
		let lastActivePage = null;
		let lastGridSignature = null;
		let fallbackTimer = null;
		let debounceTimer = null;
		let cooldownActive = false;
		let cooldownSecondsLeft = 0;
		let cooldownTimer = null;

		const startCooldown = pagination => {
			clearTimeout(cooldownTimer);
			cooldownActive = true;
			cooldownSecondsLeft = 5;

			const tick = () => {
				if (cooldownSecondsLeft > 0) {
					if (observedPagination) {
						showAutoPagingStatus(observedPagination, `Auto-paging cooldown: ${cooldownSecondsLeft}s`);
					}
					cooldownSecondsLeft--;
					cooldownTimer = setTimeout(tick, 1000);
				} else {
					cooldownActive = false;
					if (observedPagination) {
						showAutoPagingStatus(observedPagination, 'Scroll beyond the bottom to load the next page');
					}
				}
			};
			tick();
		};

		const clearCooldown = () => {
			clearTimeout(cooldownTimer);
			cooldownActive = false;
			cooldownSecondsLeft = 0;
		};

		const maybeLoadNextPage = event => {
			if (loadingPage) {
				event.preventDefault();
				
				// Keep resetting the lock release timer as long as wheel/swipe events continue
				if (pageLoaded) {
					clearTimeout(debounceTimer);
					debounceTimer = setTimeout(() => {
						loadingPage = false;
						lastTriggeredPage = null;
						document.documentElement.style.overflowY = '';
						hideAutoPagingOverlay();
						if (observedPagination) {
							showAutoPagingStatus(observedPagination, cooldownActive ? `Auto-paging cooldown: ${cooldownSecondsLeft + 1}s` : 'Scroll beyond the bottom to load the next page');
						}
					}, 150);
				}
				return true;
			}

			if (cooldownActive) return false;

			const deltaY = getWheelDeltaPixels(event);
			if (deltaY <= 0) return false;

			const pagination = observedPagination || document.querySelector('.PaginationControl .rc-pagination:not(.collapse)');
			if (!pagination) return false;

			const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
			const reachesBottom = window.scrollY + deltaY >= maxScrollY - 10;
			if (!reachesBottom) return false;

			const currentPage = getCurrentIdentifyPage(pagination);
			const nextItem = pagination.querySelector('li.rc-pagination-next[aria-disabled="false"]');
			if (!nextItem || currentPage === lastTriggeredPage) return false;

			event.preventDefault();

			loadingPage = true;
			pageLoaded = false;
			lastTriggeredPage = currentPage;
			lastGridSignature = getIdentifyGridSignature();

			// Temporarily disable scroll to kill momentum scrolling and freeze page
			document.documentElement.style.overflowY = 'hidden';

			// Scroll immediately to top
			window.scrollTo(0, 0);

			showAutoPagingOverlay('Loading next page...');
			showAutoPagingStatus(pagination, 'Loading next page...');
			nextItem.click();

			clearTimeout(fallbackTimer);
			fallbackTimer = setTimeout(() => {
				loadingPage = false;
				lastTriggeredPage = null;
				document.documentElement.style.overflowY = '';
				hideAutoPagingOverlay();
				clearCooldown();
				if (observedPagination) {
					showAutoPagingStatus(observedPagination, 'Scroll beyond the bottom to load the next page');
				}
			}, 10000);

			return true;
		};

		window.addEventListener('wheel', event => {
			maybeLoadNextPage(event);
		}, { passive: false });

		const watchPagination = () => {
			const pagination = document.querySelector('.PaginationControl .rc-pagination:not(.collapse)');
			if (!pagination) return;

			if (pagination !== observedPagination) {
				observedPagination = pagination;
				showAutoPagingStatus(pagination, cooldownActive ? `Auto-paging cooldown: ${cooldownSecondsLeft + 1}s` : 'Scroll beyond the bottom to load the next page');
				lastActivePage = getCurrentIdentifyPage(pagination);
			}

			const currentPage = getCurrentIdentifyPage(pagination);
			const currentGridSignature = getIdentifyGridSignature();

			// Detect if page was changed (either automatically or manually)
			if (currentPage && currentPage !== lastActivePage) {
				if (loadingPage && !pageLoaded) {
					// Auto-paging change detected, but we wait for observations to actually load
					if (currentGridSignature !== lastGridSignature) {
						pageLoaded = true;
						clearTimeout(fallbackTimer);
						hideAutoPagingOverlay();

						// Release lock only after 150ms of scroll inactivity
						clearTimeout(debounceTimer);
						debounceTimer = setTimeout(() => {
							loadingPage = false;
							lastTriggeredPage = null;
							document.documentElement.style.overflowY = '';
							startCooldown(pagination);
						}, 150);
						lastActivePage = currentPage;
					}
				} else if (!loadingPage) {
					// Manual page change detected (user clicked Next / Prev)
					window.scrollTo(0, 0);
					
					// Clear cooldown since user manually navigated
					clearCooldown();

					// Lock auto-paging briefly to prevent accidental trigger from click momentum
					loadingPage = true;
					pageLoaded = true;
					clearTimeout(debounceTimer);
					debounceTimer = setTimeout(() => {
						loadingPage = false;
						lastTriggeredPage = null;
						document.documentElement.style.overflowY = '';
					}, 800);
					lastActivePage = currentPage;
				}
			}
		};

		const pageObserver = new MutationObserver(watchPagination);
		pageObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
		watchPagination();
	}

	function getIdentifyGridSignature() {
		const grid = document.querySelector('#Identify .ObservationsGrid');
		if (!grid) return '';
		const items = Array.from(grid.querySelectorAll('.ObservationsGridItem'));
		return items.map(item => (
			item.querySelector('a[href^="/observations/"]')?.getAttribute('href') || ''
		)).filter(Boolean).join('|');
	}



	function getWheelDeltaPixels(event) {
		if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
		if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight;
		return event.deltaY;
	}

	function getCurrentIdentifyPage(pagination) {
		const activePage = pagination.querySelector('.rc-pagination-item-active');
		return activePage ? activePage.textContent.trim() : null;
	}

	function showAutoPagingStatus(pagination, message) {
		if (!pagination) return;
		const control = pagination.closest('.PaginationControl');
		if (!control) return;

		let status = control.querySelector('.inat-identify-auto-page-status');
		if (!status) {
			status = document.createElement('div');
			status.className = 'inat-identify-auto-page-status';
			status.style.cssText = 'margin: 8px 0; color: #777; font-size: 12px;';
			status.setAttribute('aria-live', 'polite');
			control.appendChild(status);
		}
		if (status.textContent !== message) {
			status.textContent = message;
		}
	}

	function showAutoPagingOverlay(message) {
		let overlay = document.getElementById('inat-identify-auto-page-overlay');
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = 'inat-identify-auto-page-overlay';
			overlay.style.cssText = `
				position: fixed;
				inset: 0;
				z-index: 2147483646;
				display: flex;
				align-items: center;
				justify-content: center;
				background: rgba(255, 255, 255, 0.4);
				backdrop-filter: blur(1px);
			`;
			overlay.innerHTML = `
				<div style="display:flex;align-items:center;gap:10px;padding:14px 18px;background:#fff;border:1px solid #d8e4c0;border-radius:7px;box-shadow:0 8px 30px rgba(0,0,0,.16);font-size:14px;color:#4f7200;font-weight:600;">
					<span class="inat-auto-page-spinner"></span>
					<span class="inat-auto-page-message"></span>
				</div>
			`;
			const style = document.createElement('style');
			style.textContent = `
				.inat-auto-page-spinner {
					width: 18px;
					height: 18px;
					border: 2px solid #dce8c5;
					border-top-color: #74ac00;
					border-radius: 50%;
					animation: inat-auto-page-spin .7s linear infinite;
				}
				@keyframes inat-auto-page-spin { to { transform: rotate(360deg); } }
			`;
			document.head.appendChild(style);
			document.body.appendChild(overlay);
		}
		overlay.querySelector('.inat-auto-page-message').textContent = message;
		overlay.style.display = 'flex';
	}

	function hideAutoPagingOverlay() {
		const overlay = document.getElementById('inat-identify-auto-page-overlay');
		if (overlay) overlay.style.display = 'none';
	}

	document.addEventListener('observationFetch', event => {
		log('observationFetch handler', event.detail);

		const obs = event.detail?.observation;
		currentTaxon = obs ? (obs.taxon || null) : null;
		currentSpeciesGuess = obs ? (obs.species_guess || null) : null;
		if (items.enableQuickPlant) {
			updateQuickPlantVisibility();
		}

		if (items.enableCopyGeo) {
			const detail = event.detail;
			if (detail) {
				location = detail.location;
				if (location) {
					const ul = document.querySelector(".map-and-details .details ul:not([role])");
					if (ul) {
						const itemClass = 'copy-geo-item';
						let li = ul.querySelector('.' + itemClass);
						if (!li) {
							li = document.createElement('li');
							li.className = itemClass;

							const button = document.createElement('button');
							button.className = 'btn btn-xs btn-default';
							button.title = 'Copy to clipboard';
							button.innerHTML = '<i class="fa fa-clipboard"></i>';
							button.style.marginLeft = '-20px';
							button.onclick = async function() {
								await navigator.clipboard.writeText(location);
							}
							li.appendChild(button);

							const label = document.createElement('span');
							label.style.marginLeft = '4px';
							li.appendChild(label);

							ul.appendChild(li);
						}

						const [lat, lng] = location.split(',');
						li.querySelector('span').textContent = `Lat/Lon: ${parseFloat(lat).toFixed(5)}, ${parseFloat(lng).toFixed(5)}`;
					}
				}
			}
		}
	});

	// cache the CV response for a photo
	document.addEventListener('computerVisionResponse', event => {
		log('computerVisionResponse handler', event.detail);

		if (items.enableColorVision || items.enableCVPercentages) {
			const detail = event.detail;
			if (detail && detail.data) {
				const key = detail.filename || DEFAULT_KEY_NAME;
				logDebug('key', key);

				computerVisionResults.set(key, detail.data);
			}
		}
	});

	// colorization
	document.arrive('.TaxonAutocomplete > ul', ul => {
		// triggered when the subtree changes, i.e. the CV rows are created, or classes are added/removed
		function observeCallback(mutations) {
			for (const mutation of mutations) {
				const element = mutation.target;
				switch (mutation.type) {
					case 'childList': {
						const divs = element.querySelectorAll('div.ac.vision');

						// short-circuit if the CV rows haven't been populated yet
						if (!divs.length) {
							return;
						}

						let parent = element.parentNode;

						// in the upload workflow, we need to work up the tree to find a parent element
						if (window.location.href.indexOf('upload') > -1) {
							do {
								if (parent.classList.contains('cellDropzone')) {
									break;
								}

								parent = parent.parentNode;
							} while (parent.parentNode);
						}

						logDebug('parent', parent);

						// img will be falsy here on the single-observation page
						const img = parent.querySelector('img.img-thumbnail');
						const key = img ? img.alt : DEFAULT_KEY_NAME;

						logDebug('key', key);

						const computerVision = computerVisionResults.get(key);
						if (!computerVision) {
							return;
						}

						// color each suggestion based on the cached CV results
						for (const div of divs) {
							const taxonId = div.getAttribute('data-taxon-id');
							const result = computerVision.results.find(t => t.taxon.id == taxonId);
							let score;
							if (result) {
								score = result.combined_score;
							} else if (computerVision.common_ancestor && computerVision.common_ancestor.taxon && computerVision.common_ancestor.taxon.id == taxonId) {
								score = computerVision.common_ancestor.score;
							}

							if (score) {
								let hue = score * 1.2;
								chrome.storage.sync.get({
									enableColorVision: true,
									colorDisplayMode: 'sidebar',
									enableColorBlindMode: false,
									enableCVPercentages: true
								}, function(colorItems) {
									if (chrome.runtime.lastError) {
										console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
										return;
									}
									if (colorItems.enableColorBlindMode) {
										hue = hue * -1 + 240;
									}

									const li = div.closest('li');

									// Apply color coding if enabled
									if (colorItems.enableColorVision) {
										if (colorItems.colorDisplayMode === 'gradient') {
											div.style.background = 'linear-gradient(to right, hsl(' + hue + ',50%,50%), white 90%)';
										} else {
											// Add rounded sidebar element instead of border-left
											if (!li.querySelector('.cv-sidebar')) {
												const ul = div.parentNode.parentNode;
												if (!ul.classList.contains(FLAG_CLASS)) {
													ul.style.width = parseInt(ul.style.width) + 18 + 'px';
													ul.classList.add(FLAG_CLASS);
												}

												const sidebar = document.createElement('div');
												sidebar.className = 'cv-sidebar';
												sidebar.style.cssText = 'width: 6px; background: hsl(' + hue + ', 50%, 50%); border-radius: 3px; position: absolute; left: 4px; top: 4px; bottom: 4px;';

												if (li) {
													li.style.position = 'relative';
													li.style.paddingLeft = '14px';
													li.insertBefore(sidebar, li.firstChild);
												}
											}
										}
									}

									// Add score badge if not already present
									if (colorItems.enableCVPercentages && !div.querySelector('.cv-score-badge')) {
										const badge = document.createElement('span');
										badge.className = 'cv-score-badge';
										badge.textContent = score.toFixed(1) + '%';
										badge.style.cssText = 'font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; background: #74ac00; color: white; flex-shrink: 0; margin-left: auto; margin-right: 8px;';

										// Find View link by looking for anchor with "View" text
										const links = div.querySelectorAll('a');
										let viewLink = null;
										for (const link of links) {
											if (link.textContent.trim() === 'View') {
												viewLink = link;
												break;
											}
										}

										div.style.display = 'flex';
										div.style.alignItems = 'center';

										if (viewLink) {
											div.insertBefore(badge, viewLink);
										} else {
											div.appendChild(badge);
										}
									}
								});
							}

							if (
								computerVision.common_ancestor?.taxon
								&& computerVision.common_ancestor.taxon.id == taxonId
							) {
								addMainSuggestionHierarchy(div, computerVision.common_ancestor.taxon);
							}
						}

						break;
					}

					case 'attributes': {
						// reset the flag so we fix the menu width again when the CV menu is reopened
						const classList = mutation.target.classList;
						if (!classList.contains('open') && mutation.oldValue.indexOf(' open') > -1 && classList.contains(FLAG_CLASS)) {
							classList.remove(FLAG_CLASS);
						}

						break;
					}
				}
			}
		}

		// listen for individual CV rows to be created
		const observer = new MutationObserver(observeCallback);
		const options = {
			childList: true,
			subtree: true,
			attributeFilter: ['class'],
			attributeOldValue: true
		};

		observer.observe(ul, options);
	});

	async function addMainSuggestionHierarchy(row, compactTaxon) {
		if (row.querySelector('.inat-main-cv-hierarchy')) return;

		const hierarchy = document.createElement('div');
		hierarchy.className = 'inat-main-cv-hierarchy';
		hierarchy.innerHTML = '<span class="inat-main-cv-hierarchy-loading">Loading classification...</span>';
		hierarchy.addEventListener('click', event => event.stopPropagation());
		row.style.flexWrap = 'wrap';
		row.appendChild(hierarchy);

		try {
			const fullTaxon = await fetchTaxon(compactTaxon.id);
			const taxonIds = [...(fullTaxon.ancestor_ids || []), fullTaxon.id];
			const missingIds = taxonIds.filter(id => !hierarchyTaxaCache.has(String(id)));
			if (missingIds.length) await fetchTaxa(missingIds);
			if (!hierarchy.isConnected) return;

			const taxa = taxonIds
				.map(id => hierarchyTaxaCache.get(String(id)))
				.filter(Boolean);
			hierarchy.innerHTML = taxa.map((taxon, index) => {
				const label = taxon.preferred_common_name || taxon.name;
				const separator = index
					? '<span class="inat-main-cv-hierarchy-separator">›</span>'
					: '';
				return `${separator}<a href="https://www.inaturalist.org/taxa/${taxon.id}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
			}).join('');
		} catch (error) {
			logDebug('Could not load main CV hierarchy:', error);
			hierarchy.innerHTML = '<span class="inat-main-cv-hierarchy-loading">Classification unavailable</span>';
		}
	}

	async function fetchTaxon(taxonId) {
		const cached = hierarchyTaxaCache.get(String(taxonId));
		if (cached?.ancestor_ids) return cached;

		// Check L2 cache
		const persistentKey = `inat-taxon-${taxonId}`;
		const persistentResult = await window.iNatCache.read(persistentKey);
		if (persistentResult?.ancestor_ids) {
			hierarchyTaxaCache.set(String(taxonId), persistentResult);
			return persistentResult;
		}

		const taxa = await fetchTaxa([taxonId]);
		return taxa[0] || {};
	}

	async function fetchTaxa(ids) {
		const results = [];
		const missingFromL1 = [];

		// Step 1: Check L1 in-memory cache
		for (const id of ids) {
			const idStr = String(id);
			if (hierarchyTaxaCache.has(idStr)) {
				results.push(hierarchyTaxaCache.get(idStr));
			} else {
				missingFromL1.push(id);
			}
		}

		if (missingFromL1.length === 0) {
			return results;
		}

		// Step 2: Check L2 persistent cache
		const missingFromL2 = [];
		for (const id of missingFromL1) {
			const key = `inat-taxon-${id}`;
			const cached = await window.iNatCache.read(key);
			if (cached) {
				hierarchyTaxaCache.set(String(id), cached);
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
			const response = await fetch(`https://api.inaturalist.org/v1/taxa/${batch.join(',')}`);
			if (!response.ok) throw new Error(`Taxa API returned HTTP ${response.status}`);
			const data = await response.json();
			for (const taxon of data.results || []) {
				hierarchyTaxaCache.set(String(taxon.id), taxon);
				results.push(taxon);
				await window.iNatCache.write(`inat-taxon-${taxon.id}`, taxon);
			}
		}
		return results;
	}

	function escapeHtml(value) {
		const element = document.createElement('div');
		element.textContent = String(value == null ? '' : value);
		return element.innerHTML;
	}

	function updateQuickPlantVisibility() {
		const containers = document.querySelectorAll('.inat-quick-add-container');
		for (const container of containers) {
			if (currentTaxon === null) {
				container.style.setProperty('display', 'grid', 'important');
			} else {
				container.style.setProperty('display', 'none', 'important');
			}

			// Update the placeholder text and visibility
			const labelEl = container.querySelector('.inat-quick-add-placeholder-label');
			const containerEl = container.querySelector('.inat-quick-add-placeholder-wrapper-container');
			const valEl = container.querySelector('.inat-quick-add-placeholder-value');
			
			if (labelEl && containerEl && valEl) {
				if (currentSpeciesGuess) {
					labelEl.style.setProperty('display', 'inline-block', 'important');
					containerEl.style.setProperty('display', 'flex', 'important');
					valEl.textContent = currentSpeciesGuess;
				} else {
					labelEl.style.setProperty('display', 'none', 'important');
					containerEl.style.setProperty('display', 'none', 'important');
				}
			}
		}
	}

	// Quick-add taxon definitions: photoUrl, label, taxon id, colour accent
	const QUICK_ADD_TAXA = [
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/301768574/square.jpg',
			label: 'Vascular Plants',
			taxon: { id: 211194, name: 'Tracheophyta', preferred_common_name: 'Vascular Plants', rank: 'phylum', iconic_taxon_name: 'Plantae' },
			accent: { bg: '#f0f7e6', border: '#a4d257', hoverBg: '#e2f0cc', hoverBorder: '#7db53a', text: '#3d6b00' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/76692662/square.jpg',
			label: 'Grasses',
			taxon: { id: 47434, name: 'Poaceae', preferred_common_name: 'Grasses', rank: 'family', iconic_taxon_name: 'Plantae' },
			accent: { bg: '#edf4e3', border: '#92c347', hoverBg: '#e0ecce', hoverBorder: '#719f2d', text: '#365111' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/36127/square.jpg',
			label: 'Lepidoptera',
			taxon: { id: 47157, name: 'Lepidoptera', preferred_common_name: 'Butterflies and Moths', rank: 'order', iconic_taxon_name: 'Insecta' },
			accent: { bg: '#f5f0fc', border: '#c9a8f5', hoverBg: '#ece0fb', hoverBorder: '#a97ee0', text: '#5a2d91' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/145526721/square.jpg',
			label: 'Diptera',
			taxon: { id: 47822, name: 'Diptera', preferred_common_name: 'Flies', rank: 'order', iconic_taxon_name: 'Insecta' },
			accent: { bg: '#edf5f8', border: '#8bb8c7', hoverBg: '#dcecf1', hoverBorder: '#5e98aa', text: '#285d6d' }
		},
		{
			photoUrl: 'https://static.inaturalist.org/photos/250916813/square.jpg',
			label: 'Grasshoppers & Locusts',
			taxon: { id: 47650, name: 'Acridoidea', preferred_common_name: 'Short-horned Grasshoppers and Locusts', rank: 'superfamily', iconic_taxon_name: 'Insecta' },
			accent: { bg: '#f5f5df', border: '#b6b75e', hoverBg: '#ebebc8', hoverBorder: '#92943b', text: '#565816' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/6993855/square.jpg',
			label: 'Mushrooms & Puffballs',
			taxon: { id: 50814, name: 'Agaricomycetes', preferred_common_name: 'Mushrooms, Bracket Fungi, Puffballs, and Allies', rank: 'class', iconic_taxon_name: 'Fungi' },
			accent: { bg: '#f7f1e8', border: '#c8a77b', hoverBg: '#efe3d3', hoverBorder: '#a98250', text: '#65451f' }
		}
	];

	function makeQuickAddBtn(def, input) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'inat-quick-add-btn';
		btn.dataset.inatQuickTaxon = def.taxon.id;
		btn.title = `Identify as ${def.taxon.preferred_common_name || def.taxon.name}`;
		btn.style.setProperty('--qa-bg',           def.accent.bg);
		btn.style.setProperty('--qa-border',       def.accent.border);
		btn.style.setProperty('--qa-hover-bg',     def.accent.hoverBg);
		btn.style.setProperty('--qa-hover-border', def.accent.hoverBorder);
		btn.style.setProperty('--qa-text',         def.accent.text);
		btn.innerHTML = `<span class="inat-quick-add-thumb-wrap" aria-hidden="true"><img src="${def.photoUrl}" class="inat-quick-add-thumb"></span><span class="inat-quick-add-text">${def.label}</span>`;

		btn.addEventListener('click', function(e) {
			e.preventDefault();
			e.stopPropagation();
			input.setAttribute('data-inat-target-input', 'true');
			const requestId = Math.random().toString(36).substring(2);
			const isIdentify = window.location.pathname.includes('/observations/identify');
			document.dispatchEvent(new CustomEvent('selectTaxonRequest', {
				detail: { taxon: def.taxon, requestId, isIdentifyPage: isIdentify }
			}));
		});

		return btn;
	}

	function setupQuickPlant() {
		// Only enhance identification forms. The Identify page also has a taxon
		// autocomplete in its filter bar, but that control is not an ID form.
		document.arrive('.IdentificationForm .TaxonAutocomplete input[name="taxon_name"], .IdentificationForm .TaxonAutocomplete input[type="search"]', { existing: true }, function() {
			const input = this;
			const autocomplete = input.closest('.TaxonAutocomplete');
			if (!autocomplete || autocomplete.dataset.inatQuickPlant === 'true') return;
			autocomplete.dataset.inatQuickPlant = 'true';

			const wrapper = document.createElement('div');
			wrapper.className = 'inat-quick-add-container';

			// Row 1 Label
			const label = document.createElement('span');
			label.className = 'inat-quick-add-label';
			label.textContent = 'Quick ID';

			// Row 1 Content
			const btnRow = document.createElement('div');
			btnRow.className = 'inat-quick-add-btn-row';

			for (const def of QUICK_ADD_TAXA) {
				btnRow.appendChild(makeQuickAddBtn(def, input));
			}

			wrapper.appendChild(label);
			wrapper.appendChild(btnRow);

			// Row 2 Label
			const placeholderLabel = document.createElement('span');
			placeholderLabel.className = 'inat-quick-add-placeholder-label';
			placeholderLabel.textContent = 'Placeholder';
			
			// Row 2 Content wrapper container (for grid cell border)
			const placeholderWrapperContainer = document.createElement('div');
			placeholderWrapperContainer.className = 'inat-quick-add-placeholder-wrapper-container';

			// The copyable pill itself
			const placeholderWrapper = document.createElement('div');
			placeholderWrapper.className = 'inat-quick-add-placeholder-wrapper';
			placeholderWrapper.title = 'Click to copy placeholder to clipboard';
			
			const placeholderVal = document.createElement('span');
			placeholderVal.className = 'inat-quick-add-placeholder-value';
			
			const copyIcon = document.createElement('span');
			copyIcon.className = 'inat-quick-add-placeholder-copy';
			copyIcon.innerHTML = '📋';

			placeholderWrapper.appendChild(placeholderVal);
			placeholderWrapper.appendChild(copyIcon);
			placeholderWrapperContainer.appendChild(placeholderWrapper);
			
			wrapper.appendChild(placeholderLabel);
			wrapper.appendChild(placeholderWrapperContainer);

			// Copy logic
			const copyAction = async (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (placeholderVal.textContent && placeholderVal.textContent !== 'Copied!') {
					const originalText = placeholderVal.textContent;
					const textToCopy = `Placeholder: ${originalText}`;
					await navigator.clipboard.writeText(textToCopy);
					
					// Visual feedback
					placeholderVal.textContent = 'Copied!';
					placeholderVal.classList.add('copied');
					copyIcon.innerHTML = '✅';
					setTimeout(() => {
						placeholderVal.textContent = originalText;
						placeholderVal.classList.remove('copied');
						copyIcon.innerHTML = '📋';
					}, 1000);
				}
			};
			placeholderWrapper.addEventListener('click', copyAction);

			// Set initial visibility of wrapper
			wrapper.style.setProperty('display', currentTaxon === null ? 'grid' : 'none', 'important');

			// Set initial visibility and content of placeholder section
			if (currentSpeciesGuess) {
				placeholderLabel.style.setProperty('display', 'inline-block', 'important');
				placeholderWrapperContainer.style.setProperty('display', 'flex', 'important');
				placeholderVal.textContent = currentSpeciesGuess;
			} else {
				placeholderLabel.style.setProperty('display', 'none', 'important');
				placeholderWrapperContainer.style.setProperty('display', 'none', 'important');
			}

			autocomplete.insertAdjacentElement('afterend', wrapper);
		});
	}

	if (items.enableQuickPlant) {
		setupQuickPlant();
	}


	chrome.storage.sync.get({
		colorDisplayMode: 'sidebar'
	}, function(items) {
		if (chrome.runtime.lastError) {
			console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
			return;
		}
		const link = document.createElement('link');
		link.type = 'text/css';
		link.rel = 'stylesheet';
		link.href = chrome.runtime.getURL(items.colorDisplayMode + '.css');
		document.documentElement.appendChild(link);
	});
});
