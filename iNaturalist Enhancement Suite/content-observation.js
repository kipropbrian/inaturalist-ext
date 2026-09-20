let currentIdentifyObservationState = 'pending';
let currentIdentifyObservationId = null;
let currentTaxon = null;
let currentSpeciesGuess = null;
let handleObservationFetch = null;
let handleObservationChanging = null;
let bufferedObservationFetchEvent = null;
let observationFallbackSequence = 0;
let observationFallbackTimer = null;
let observationFallbackController = null;

function getCurrentModalObservationId() {
	const modal = document.querySelector('.ObservationModal.in, .ObservationModal');
	const href = modal?.querySelector(
		'.obs-modal-header a[href^="/observations/"], a.permalink[href^="/observations/"]'
	)?.getAttribute('href');
	const match = href?.match(/^\/observations\/([^/?#]+)/);
	return match ? match[1] : null;
}

function cancelObservationStateFallback() {
	observationFallbackSequence += 1;
	clearTimeout(observationFallbackTimer);
	observationFallbackTimer = null;
	if (observationFallbackController) observationFallbackController.abort();
	observationFallbackController = null;
}

function scheduleObservationStateFallback(delay = 350) {
	if (currentIdentifyObservationState !== 'pending') return;
	const observationId = getCurrentModalObservationId();
	if (!observationId) return;
	clearTimeout(observationFallbackTimer);
	const sequence = ++observationFallbackSequence;
	observationFallbackTimer = setTimeout(async () => {
		observationFallbackTimer = null;
		if (sequence !== observationFallbackSequence || currentIdentifyObservationState !== 'pending') return;

		const controller = new AbortController();
		observationFallbackController = controller;
		try {
			const response = await fetch(
				`https://api.inaturalist.org/v1/observations/${encodeURIComponent(observationId)}`,
				{ signal: controller.signal }
			);
			if (!response.ok) return;
			const data = await response.json();
			const observation = data.results?.[0];
			if (!observation || sequence !== observationFallbackSequence) return;
			if (String(getCurrentModalObservationId()) !== String(observation.id || observationId)) return;
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
				console.debug('[iNat Enhancement] Observation state fallback skipped:', error);
			}
		} finally {
			if (observationFallbackController === controller) observationFallbackController = null;
		}
	}, delay);
}

// Settings storage is asynchronous and iNaturalist may fetch a cached
// observation before its callback runs. Keep the lifecycle event synchronous so
// Quick ID, classification, and placeholder state cannot remain stuck at
// "pending" after a fast modal load.
document.addEventListener('observationFetch', event => {
	cancelObservationStateFallback();
	const obs = event.detail?.observation;
	currentIdentifyObservationId = event.detail?.observationId || obs?.id || null;
	currentTaxon = obs ? (obs.taxon || null) : null;
	currentSpeciesGuess = obs ? (obs.species_guess || null) : null;
	currentIdentifyObservationState = obs
		? (obs.taxon ? 'identified' : 'unknown')
		: 'pending';
	if (handleObservationFetch) {
		handleObservationFetch(event);
	} else {
		bufferedObservationFetchEvent = event;
	}
});

document.addEventListener('inatExtObservationChanging', () => {
	cancelObservationStateFallback();
	bufferedObservationFetchEvent = null;
	currentIdentifyObservationId = null;
	currentTaxon = null;
	currentSpeciesGuess = null;
	currentIdentifyObservationState = 'pending';
	if (handleObservationChanging) handleObservationChanging();
});

chrome.storage.sync.get({
	enableColorVision: true,
	enableCVPercentages: true,
	enableCopyGeo: true,
	enableIdentifierStats: true,
	enableQuickPlant: true,
	enableIdentifyAutoPaging: true,
	enableIdentifyFastReview: true,
	enableLogging: false
}, function(items) {
	if (chrome.runtime.lastError) {
		console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
		return;
	}
	// Use shared logging from logging.js
	const logDebug = window.iNatLogDebug || console.debug;
	const log = window.iNatLog || console.log;
	const identifyFastReview = window.location.pathname === '/observations/identify'
		&& items.enableIdentifyFastReview !== false;

	const DEFAULT_KEY_NAME = 'default';
	const FLAG_CLASS = 'expanded';
	let updateIdentifyFastReviewMode = () => {};
	let refreshIdentifierStats = () => {};
	let refreshIdentifyColorization = () => {};
	const shouldDeferFastIdentifyEnhancements = () => (
		identifyFastReview && currentIdentifyObservationState !== 'identified'
	);
	const shouldShowMainCvHierarchy = () => {
		// Main CV hierarchy rows are useful on identified observations, but they
		// add work to the unknown fast-review path where the reviewer is moving
		// quickly and has no confirmed taxon to inspect.
		if (currentIdentifyObservationState === 'unknown') return false;
		return window.location.pathname !== '/observations/identify'
			|| currentIdentifyObservationState === 'identified';
	};

	logDebug('Settings loaded:', items);

	async function enhanceIdentifierStats(div) {
		if (!div || div.dataset.inatIdentifierStatsLoaded === 'true') return;
		if (shouldDeferFastIdentifyEnhancements()) return;

		const userAnchor = div.querySelector('a.user');
		const taxonAnchor = div.querySelector('.taxon > a');
		if (!userAnchor || !taxonAnchor) return;
		div.dataset.inatIdentifierStatsLoaded = 'true';

		const user = userAnchor.innerHTML;
		const taxonParts = taxonAnchor.href.split('/');
		const taxonId = taxonParts[taxonParts.length - 1];
		const url = `https://api.inaturalist.org/v1/identifications/categories?user_login=${user}&taxon_id=${taxonId}`;

		const key = `inat-userstats-${user}-${taxonId}`;
		let data = await window.iNatCache.read(key);
		if (!data) {
			const response = await fetch(url);
			data = await response.json();
			await window.iNatCache.write(key, data);
		}

		if (!div.isConnected || shouldDeferFastIdentifyEnhancements()) {
			delete div.dataset.inatIdentifierStatsLoaded;
			return;
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
			if (span && !span.querySelector('.inat-identifier-stats')) {
				const title = `Leading: ${leadingCount}&#010;Improving: ${improvingCount}&#010;Supporting: ${supportingCount}&#010;Maverick: ${maverickCount}`;
				const countMarkup = `<span class="inat-identifier-stats" title="${title}">(${leadingCount + improvingCount})</span>`;
				span.innerHTML = span.innerHTML.replace('</a>', `</a> ${countMarkup}`);
			}
		}
	}

	if (items.enableIdentifierStats) {
		document.arrive('.ActivityItem.identification', enhanceIdentifierStats);
		refreshIdentifierStats = () => {
			if (shouldDeferFastIdentifyEnhancements()) return;
			document.querySelectorAll('.ActivityItem.identification').forEach(enhanceIdentifierStats);
		};
	}


	let location;
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

	function injectIdentifyPhotoStyles() {
		if (document.getElementById('inat-identify-photo-styles')) return;
		const style = document.createElement('style');
		style.id = 'inat-identify-photo-styles';
		style.textContent = `
			#Identify .ObservationsGridItem a.media.photo span.photo-count {
				display: inline-flex !important;
				align-items: center !important;
				justify-content: center !important;
				gap: 4px !important;
				min-width: 38px !important;
				height: 20px !important;
				box-sizing: border-box !important;
				padding: 3px 6px !important;
				white-space: nowrap !important;
				border: 1px solid rgba(255, 255, 255, 0.95) !important;
				border-radius: 4px !important;
				background: rgba(20, 30, 40, 0.82) !important;
				color: #fff !important;
				font-size: 12px !important;
				font-weight: 700 !important;
				line-height: 1 !important;
				text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35) !important;
			}
			#Identify .ObservationsGridItem a.media.photo span.photo-count::before {
				content: '\\f03e';
				font-family: FontAwesome !important;
				font-size: 11px !important;
				font-weight: 400 !important;
				flex: 0 0 auto !important;
			}
			.ObservationModal .obs-media .image-gallery {
				position: relative;
			}
			.ObservationModal .inat-identify-photo-count {
				position: absolute;
				top: 10px;
				left: 10px;
				z-index: 20;
				display: inline-flex;
				align-items: center;
				gap: 5px;
				padding: 4px 8px;
				border: 1px solid rgba(255, 255, 255, 0.9);
				border-radius: 4px;
				background: rgba(20, 30, 40, 0.78);
				color: #fff;
				font-size: 12px;
				font-weight: 700;
				line-height: 1;
				pointer-events: none;
				text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
			}
			.ObservationModal .inat-identify-photo-count-icon {
				font-family: FontAwesome;
				font-size: 11px;
				font-weight: 400;
			}
		`;
		document.head.appendChild(style);
	}

	function normalizeIdentifyPhotoCountBadge(badge) {
		const count = Number.parseInt(badge?.textContent?.trim(), 10);
		if (!badge || !Number.isFinite(count) || count < 1) return;
		const label = `${count} photo${count === 1 ? '' : 's'}`;
		badge.title = label;
		badge.setAttribute('aria-label', label);
	}

	function updateIdentifyPhotoCount(modal) {
		const media = modal?.querySelector('.obs-media');
		if (!media) return;
		const slides = Array.from(media.querySelectorAll('.image-gallery-slide'));
		const thumbnails = media.querySelectorAll('.image-gallery-thumbnail');
		const total = Math.max(slides.length, thumbnails.length);
		let badge = media.querySelector('.inat-identify-photo-count');
		if (!total) {
			badge?.remove();
			return;
		}

		if (!badge) {
			badge = document.createElement('div');
			badge.className = 'inat-identify-photo-count';
			badge.setAttribute('role', 'status');
			media.querySelector('.image-gallery')?.appendChild(badge);
		}
		const activeSlide = media.querySelector('.image-gallery-slide.center')
			|| media.querySelector('.image-gallery-slide[aria-hidden="false"]');
		const activeIndex = Math.max(0, slides.indexOf(activeSlide));
		badge.replaceChildren();
		const icon = document.createElement('span');
		icon.className = 'inat-identify-photo-count-icon';
		icon.setAttribute('aria-hidden', 'true');
		icon.textContent = String.fromCharCode(0xf03e);
		const label = document.createElement('span');
		label.textContent = `${activeIndex + 1} / ${total}`;
		badge.append(icon, label);
		badge.setAttribute('aria-label', `Photo ${activeIndex + 1} of ${total}`);
	}

	function enableIdentifyPhotoBadges() {
		injectIdentifyPhotoStyles();
		document.arrive('#Identify .ObservationsGridItem .photo-count', { existing: true }, function() {
			normalizeIdentifyPhotoCountBadge(this);
		});
		document.arrive('.ObservationModal .obs-media', { existing: true }, function() {
			if (identifyFastReview) {
				updateIdentifyPhotoCount(this.closest('.ObservationModal'));
				return;
			}
			if (this.dataset.inatPhotoBadgeObserved === 'true') {
				updateIdentifyPhotoCount(this.closest('.ObservationModal'));
				return;
			}
			this.dataset.inatPhotoBadgeObserved = 'true';
			const modal = this.closest('.ObservationModal');
			const observer = new MutationObserver(mutations => {
				if (mutations.some(mutation => !mutation.target.closest?.('.inat-identify-photo-count'))) {
					updateIdentifyPhotoCount(modal);
				}
			});
			observer.observe(this, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['class', 'aria-hidden']
			});
			updateIdentifyPhotoCount(modal);
		});
	}

	injectHierarchyStyles();

	if (window.location.pathname === '/observations/identify') {
		enableIdentifyPhotoBadges();
		if (items.enableIdentifyAutoPaging) enableIdentifyAutoPaging();
		if (identifyFastReview) enableIdentifyFastReview();
	}

	function enableIdentifyFastReview() {
		const root = document.documentElement;

		let prefetchedObservationId = null;
		let prefetchedImage = null;
		let prefetchTimer = null;
		const getModalObservationId = () => {
			const modal = document.querySelector('.ObservationModal.in, .ObservationModal');
			const href = modal?.querySelector(
				'.obs-modal-header a[href^="/observations/"], a.permalink[href^="/observations/"]'
			)?.getAttribute('href');
			const match = href?.match(/^\/observations\/([^/?#]+)/);
			return match ? match[1] : null;
		};
		const getBackgroundImageUrl = element => {
			const backgroundImage = element?.style?.backgroundImage || '';
			const match = backgroundImage.match(/url\(\s*(["']?)(.*?)\1\s*\)/i);
			return match ? match[2] : null;
		};
		const prefetchNextIdentifyPhoto = () => {
			const currentObservationId = getModalObservationId();
			if (!currentObservationId) return;
			const cards = Array.from(document.querySelectorAll('#Identify .ObservationsGridItem'));
			const currentIndex = cards.findIndex(card => (
				card.querySelector('a[href^="/observations/"]')?.getAttribute('href')
					?.match(/^\/observations\/([^/?#]+)/)?.[1] === currentObservationId
			));
			const nextCard = currentIndex >= 0 ? cards[currentIndex + 1] : null;
			const nextLink = nextCard?.querySelector('a.media.photo[href^="/observations/"]');
			const nextObservationId = nextLink?.getAttribute('href')?.match(/^\/observations\/([^/?#]+)/)?.[1];
			const thumbnailUrl = getBackgroundImageUrl(nextLink);
			if (!nextObservationId || !thumbnailUrl || nextObservationId === prefetchedObservationId) return;

			// Identify cards expose a small/medium background while the modal uses
			// medium/large. Reuse the modal's current size so the prefetched URL can
			// satisfy the gallery request from the browser cache.
			const currentImageUrl = document.querySelector('.ObservationModal .image-gallery-image img')?.currentSrc
				|| document.querySelector('.ObservationModal .image-gallery-image img')?.src
				|| '';
			const size = currentImageUrl.match(/\/(small|medium|large|original)(?=\.[^/?#]+)/i)?.[1] || 'medium';
			const photoUrl = thumbnailUrl.replace(/\/(square|small|medium|large|original)(?=\.[^/?#]+)/i, `/${size}`);
			if (!/^https:\/\//i.test(photoUrl)) return;

			if (prefetchedImage) prefetchedImage.src = '';
			prefetchedObservationId = nextObservationId;
			prefetchedImage = new Image();
			prefetchedImage.decoding = 'async';
			if ('fetchPriority' in prefetchedImage) prefetchedImage.fetchPriority = 'low';
			prefetchedImage.src = photoUrl;
		};
		const scheduleNextPhotoPrefetch = () => {
			clearTimeout(prefetchTimer);
			prefetchTimer = setTimeout(() => {
				prefetchTimer = null;
				prefetchNextIdentifyPhoto();
			}, 500);
		};

		// Keep inactive gallery slides from downloading their full-size sources while
		// the reviewer is moving through observations. The native gallery creates all
		// slide images at once, so loading/fetchPriority hints alone still allow every
		// large S3 image to start downloading.
		const EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
		const ORIGINAL_SRC_KEY = 'inatFastOriginalSrc';
		const ORIGINAL_SRCSET_KEY = 'inatFastOriginalSrcset';
		let optimizeFrame = null;
		const isActiveGalleryImage = (image, index) => {
			const slide = image.closest('.image-gallery-slide');
			return slide?.classList.contains('center')
				|| slide?.getAttribute('aria-hidden') === 'false'
				|| (!slide && index === 0);
		};
		const restoreGalleryImage = image => {
			const originalSrc = image.dataset[ORIGINAL_SRC_KEY];
			const originalSrcset = image.dataset[ORIGINAL_SRCSET_KEY];
			const currentSrc = image.getAttribute('src');
			if (currentSrc === EMPTY_IMAGE_SRC && originalSrc) {
				image.setAttribute('src', originalSrc);
			}
			if (!image.hasAttribute('src') && !originalSrc) {
				delete image.dataset[ORIGINAL_SRC_KEY];
			}
			if (originalSrcset && !image.hasAttribute('srcset')) {
				image.setAttribute('srcset', originalSrcset);
			}
			delete image.dataset[ORIGINAL_SRC_KEY];
			delete image.dataset[ORIGINAL_SRCSET_KEY];
		};
		const restoreIdentifyThumbnails = () => {
			const modal = document.querySelector('.ObservationModal.in, .ObservationModal');
			if (!modal) return;
			// Taxon images in existing identifications are not gallery slides, but
			// they can be created while detached and caught by the page-world
			// download guard. Restore them as soon as they enter the modal.
			modal.querySelectorAll(
				'img.taxon-image[data-inat-fast-original-src], '
				+ 'img.inat-quick-add-thumb[data-inat-fast-original-src], '
				+ '.image-gallery-thumbnail img[data-inat-fast-original-src]'
			).forEach(restoreGalleryImage);
		};
		const deferGalleryImage = image => {
			const currentSrc = image.getAttribute('src');
			const currentSrcset = image.getAttribute('srcset');
			if (currentSrc && currentSrc !== EMPTY_IMAGE_SRC) {
				image.dataset[ORIGINAL_SRC_KEY] = currentSrc;
			}
			if (currentSrcset) {
				image.dataset[ORIGINAL_SRCSET_KEY] = currentSrcset;
			}
			if (currentSrc && currentSrc !== EMPTY_IMAGE_SRC) {
				image.setAttribute('src', EMPTY_IMAGE_SRC);
			}
			if (image.hasAttribute('srcset')) {
				image.removeAttribute('srcset');
			}
		};
		const optimizeModalImages = () => {
			optimizeFrame = null;
			const modal = document.querySelector('.ObservationModal.in, .ObservationModal');
			if (!modal) return;
			updateIdentifyPhotoCount(modal);
			restoreIdentifyThumbnails();
			if (!shouldDeferFastIdentifyEnhancements()) {
				modal.querySelectorAll('.obs-media .image-gallery-slide img').forEach(image => {
					restoreGalleryImage(image);
					image.loading = 'eager';
					image.decoding = 'auto';
					if ('fetchPriority' in image) image.fetchPriority = 'auto';
				});
				return;
			}
			modal.querySelectorAll('.obs-media .image-gallery-slide img').forEach((image, index) => {
				const isActive = isActiveGalleryImage(image, index);
				image.loading = isActive ? 'eager' : 'lazy';
				image.decoding = 'async';
				if ('fetchPriority' in image) {
					image.fetchPriority = isActive ? 'high' : 'low';
				}
				if (isActive) {
					restoreGalleryImage(image);
				} else {
					deferGalleryImage(image);
				}
			});
		};
		const scheduleImageOptimization = () => {
			if (optimizeFrame !== null) return;
			optimizeFrame = requestAnimationFrame(optimizeModalImages);
		};
		updateIdentifyFastReviewMode = () => {
			if (root) root.classList.toggle('inat-fast-identify-review', shouldDeferFastIdentifyEnhancements());
			scheduleImageOptimization();
		};
		updateIdentifyFastReviewMode();

		document.arrive('.ObservationModal .obs-media', { existing: true }, function() {
			if (this.dataset.inatFastReviewObserved === 'true') return;
			this.dataset.inatFastReviewObserved = 'true';
			new MutationObserver(scheduleImageOptimization).observe(this, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['class', 'aria-hidden', 'src', 'srcset']
			});
			scheduleImageOptimization();
			scheduleNextPhotoPrefetch();
		});
		document.arrive(
			'.ObservationModal img.taxon-image, .ObservationModal img.inat-quick-add-thumb',
			{ existing: true },
			restoreGalleryImage
		);
		document.addEventListener('inatExtObservationChanging', scheduleImageOptimization);
		document.addEventListener('observationFetch', () => {
			scheduleImageOptimization();
			scheduleNextPhotoPrefetch();
		});

		// content-visibility reduces paint/layout work for the map while preserving
		// the native map and details when the reviewer scrolls to them.
		const style = document.createElement('style');
		style.id = 'inat-fast-identify-review-styles';
		style.textContent = `
			.inat-fast-identify-review .ObservationModal .map-and-details > .TaxonMap {
				content-visibility: auto;
				contain-intrinsic-size: 420px 220px;
			}
		`;
		(document.head || root)?.appendChild(style);
	}

	function enableIdentifyAutoPaging() {
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
		let scrollFrame = null;
		let paginationFrame = null;
		let autoPagingWheelGuard = null;

		const stopAutoPagingScrollGuard = () => {
			if (!autoPagingWheelGuard) return;
			window.removeEventListener('wheel', autoPagingWheelGuard);
			autoPagingWheelGuard = null;
		};

		const startAutoPagingScrollGuard = () => {
			if (autoPagingWheelGuard) return;
			autoPagingWheelGuard = event => {
				if (!loadingPage || pageLoaded || event.deltaY <= 0) return;
				event.preventDefault();
				const scrollingElement = document.scrollingElement || document.documentElement;
				const bottom = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
				window.scrollTo({ top: bottom, left: 0, behavior: 'auto' });
			};
			// This listener is installed only during the short native page-swap
			// transition. Normal Identify scrolling remains passive.
			window.addEventListener('wheel', autoPagingWheelGuard, { passive: false });
		};

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

		const maybeLoadNextPage = () => {
			if (loadingPage || cooldownActive) return;

			const pagination = observedPagination || document.querySelector('.PaginationControl .rc-pagination:not(.collapse)');
			if (!pagination) return;

			const scrollingElement = document.scrollingElement || document.documentElement;
			const reachesBottom = window.scrollY + window.innerHeight >= scrollingElement.scrollHeight - 20;
			if (!reachesBottom) return;

			const currentPage = getCurrentIdentifyPage(pagination);
			const nextItem = pagination.querySelector('li.rc-pagination-next[aria-disabled="false"]');
			if (!nextItem || currentPage === lastTriggeredPage) return;

			loadingPage = true;
			pageLoaded = false;
			lastTriggeredPage = currentPage;
			lastGridSignature = getIdentifyGridSignature();

			showAutoPagingOverlay('Loading next page...');
			showAutoPagingStatus(pagination, 'Loading next page...');
			startAutoPagingScrollGuard();
			nextItem.click();

			clearTimeout(fallbackTimer);
			fallbackTimer = setTimeout(() => {
				loadingPage = false;
				lastTriggeredPage = null;
				clearTimeout(debounceTimer);
				stopAutoPagingScrollGuard();
				hideAutoPagingOverlay();
				clearCooldown();
				if (observedPagination) {
					showAutoPagingStatus(observedPagination, 'Scroll beyond the bottom to load the next page');
				}
			}, 10000);

		};

		window.addEventListener('scroll', () => {
			if (scrollFrame !== null) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = null;
				maybeLoadNextPage();
			});
		}, { passive: true });

		const watchPagination = () => {
			const pagination = document.querySelector('.PaginationControl .rc-pagination:not(.collapse)');
			if (!pagination) return;

			if (pagination !== observedPagination) {
				observedPagination = pagination;
				showAutoPagingStatus(pagination, cooldownActive ? `Auto-paging cooldown: ${cooldownSecondsLeft + 1}s` : 'Scroll beyond the bottom to load the next page');
				// Keep the previous page marker across React pagination-node
				// replacement so a manual or automatic page change is still seen.
				if (lastActivePage === null) lastActivePage = getCurrentIdentifyPage(pagination);
			}

			const currentPage = getCurrentIdentifyPage(pagination);
			const currentGridSignature = getIdentifyGridSignature();

			// Detect if page was changed (either automatically or manually)
			if (currentPage && currentPage !== lastActivePage) {
				if (loadingPage && !pageLoaded) {
					// Auto-paging change detected, but we wait for observations to actually load
						if (currentGridSignature && currentGridSignature !== lastGridSignature) {
						pageLoaded = true;
						clearTimeout(fallbackTimer);
						hideAutoPagingOverlay();
						// The old grid can leave the browser's scroll position beyond the
						// new document height. Reset immediately after the replacement
						// grid appears so auto-next cannot strand the reviewer past the
						// footer or trigger another page from layout churn.
						window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

						// Release lock only after 150ms of scroll inactivity
						clearTimeout(debounceTimer);
						debounceTimer = setTimeout(() => {
							loadingPage = false;
							lastTriggeredPage = null;
							pageLoaded = false;
							stopAutoPagingScrollGuard();
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
					}, 800);
					lastActivePage = currentPage;
				}
			}
		};

		const schedulePaginationCheck = () => {
			if (paginationFrame !== null) return;
			paginationFrame = requestAnimationFrame(() => {
				paginationFrame = null;
				watchPagination();
			});
		};
		const pageObserver = new MutationObserver(schedulePaginationCheck);
		const identifyRoot = document.querySelector('#Identify') || document.body || document.documentElement;
		pageObserver.observe(identifyRoot, { childList: true, subtree: true });
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

	handleObservationFetch = event => {
		log('observationFetch handler', event.detail);

		const obs = event.detail?.observation;
		currentIdentifyObservationId = event.detail?.observationId || obs?.id || null;
		currentTaxon = obs ? (obs.taxon || null) : null;
		currentSpeciesGuess = obs ? (obs.species_guess || null) : null;
		currentIdentifyObservationState = obs
			? (obs.taxon ? 'identified' : 'unknown')
			: 'pending';
		updateIdentifyFastReviewMode();
		refreshIdentifierStats();
		if (shouldShowMainCvHierarchy()) {
			refreshIdentifyColorization();
		} else {
			clearMainSuggestionHierarchies();
		}
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
	};
	if (bufferedObservationFetchEvent) {
		const event = bufferedObservationFetchEvent;
		bufferedObservationFetchEvent = null;
		handleObservationFetch(event);
	}

	// The modal swaps observations before the full observationFetch response
	// arrives. Clear extension-owned draft UI immediately so the previous
	// observation's placeholder cannot remain visible during that gap.
	handleObservationChanging = () => {
		clearQuickPlantPlaceholderDisplay();
		clearMainSuggestionHierarchies();
		computerVisionResults.delete(DEFAULT_KEY_NAME);
		currentIdentifyObservationId = null;
		currentTaxon = null;
		currentSpeciesGuess = null;
		currentIdentifyObservationState = 'pending';
		updateIdentifyFastReviewMode();
		if (items.enableQuickPlant) updateQuickPlantVisibility();
	};

	// Cache the lightweight CV response even in fast review. The expensive
	// autocomplete decoration remains deferred until an identified observation
	// is active, so identified observations can still recover the original UI.
	document.addEventListener('computerVisionResponse', event => {
		log('computerVisionResponse handler', event.detail);

		if (items.enableColorVision || items.enableCVPercentages) {
			const detail = event.detail;
			if (detail && detail.data) {
				const key = detail.filename || DEFAULT_KEY_NAME;
				logDebug('key', key);

				computerVisionResults.set(key, detail.data);
				// The suggestion menu can mount before the CV response arrives.
				// Replay the lightweight row/hierarchy pass only for
				// identified/normal observations; unknown fast review deliberately
				// has no hierarchy work.
				if (shouldShowMainCvHierarchy()) {
					refreshIdentifyColorization();
				} else {
					clearMainSuggestionHierarchies();
				}
			}
		}
	});

	// colorization
	const identifyColorizationRefreshers = new Set();
	refreshIdentifyColorization = () => {
		identifyColorizationRefreshers.forEach(refresh => refresh());
	};
	function clearMainSuggestionHierarchies() {
		document.querySelectorAll('.inat-main-cv-hierarchy').forEach(element => element.remove());
	}
	document.arrive('ul.ui-autocomplete.taxon-autocomplete', ul => {
			// Ignore autocompletes belonging to filter popovers (e.g., Suggestions tab filters)
			if (ul.closest('.TaxonChooserPopover, .RecordChooserPopover, .popover, .filters, #suggestions-taxon-chooser')) {
				return;
			}

		let isModifying = false;

			// triggered when the subtree changes, i.e. the CV rows are created, or classes are added/removed
			function observeCallback(mutations) {
				if (isModifying) return;
				isModifying = true;
			try {
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

								// Keep the CV hierarchy rows available during fast review. The
								// expensive colour/sidebar and percentage work remains deferred
								// until an identified observation is active.
								if (score && !shouldDeferFastIdentifyEnhancements()) {
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
					shouldShowMainCvHierarchy()
					&& computerVision.common_ancestor?.taxon
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
			} finally {
				isModifying = false;
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
			identifyColorizationRefreshers.add(() => {
				if (ul.isConnected) observeCallback([{ type: 'childList', target: ul }]);
			});
		});

	async function addMainSuggestionHierarchy(row, compactTaxon) {
		const taxonKey = compactTaxon?.id == null ? '' : String(compactTaxon.id);
		const observationId = currentIdentifyObservationId;
		const existingHierarchy = row.querySelector('.inat-main-cv-hierarchy');
		if (existingHierarchy?.dataset.inatTaxonId === taxonKey) return;
		if (existingHierarchy) existingHierarchy.remove();

		const hierarchy = document.createElement('div');
		hierarchy.className = 'inat-main-cv-hierarchy';
		hierarchy.dataset.inatTaxonId = taxonKey;
		hierarchy.innerHTML = '<span class="inat-main-cv-hierarchy-loading">Loading classification...</span>';
		hierarchy.addEventListener('click', event => event.stopPropagation());
		row.style.flexWrap = 'wrap';
		row.appendChild(hierarchy);

		try {
			const fullTaxon = await fetchTaxon(compactTaxon.id);
			const taxonIds = [...(fullTaxon.ancestor_ids || []), fullTaxon.id];
			const missingIds = taxonIds.filter(id => !hierarchyTaxaCache.has(String(id)));
			if (missingIds.length) await fetchTaxa(missingIds);
			if (!hierarchy.isConnected
				|| !shouldShowMainCvHierarchy()
				|| String(currentIdentifyObservationId || '') !== String(observationId || '')
				|| row.querySelector('.inat-main-cv-hierarchy') !== hierarchy) return;

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

	function shouldShowQuickIdControls() {
		return currentIdentifyObservationState === 'unknown';
	}

	function clearQuickPlantPlaceholderDisplay() {
		document.querySelectorAll('.inat-quick-add-container').forEach(container => {
			const labelEl = container.querySelector('.inat-quick-add-placeholder-label');
			const containerEl = container.querySelector('.inat-quick-add-placeholder-wrapper-container');
			const valEl = container.querySelector('.inat-quick-add-placeholder-value');
			if (valEl) valEl.textContent = '';
			labelEl?.style.setProperty('display', 'none', 'important');
			containerEl?.style.setProperty('display', 'none', 'important');
		});
	}

	function updateQuickPlantVisibility() {
		const containers = document.querySelectorAll('.inat-quick-add-container');
		const showQuickId = shouldShowQuickIdControls();
		for (const container of containers) {
			if (showQuickId) {
				container.style.setProperty('display', 'grid', 'important');
			} else {
				container.style.setProperty('display', 'none', 'important');
			}

			// Update the placeholder text and visibility
			const labelEl = container.querySelector('.inat-quick-add-placeholder-label');
			const containerEl = container.querySelector('.inat-quick-add-placeholder-wrapper-container');
			const valEl = container.querySelector('.inat-quick-add-placeholder-value');
			
			if (labelEl && containerEl && valEl) {
				if (showQuickId && currentSpeciesGuess) {
					labelEl.style.setProperty('display', 'inline-block', 'important');
					containerEl.style.setProperty('display', 'flex', 'important');
					valEl.textContent = currentSpeciesGuess;
				} else {
					labelEl.style.setProperty('display', 'none', 'important');
					containerEl.style.setProperty('display', 'none', 'important');
					valEl.textContent = '';
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
			photoUrl: 'https://static.inaturalist.org/photos/4608305/square.jpeg',
			label: 'Nightshades',
			taxon: { id: 48516, name: 'Solanaceae', preferred_common_name: 'nightshade family', rank: 'family', iconic_taxon_name: 'Plantae' },
			accent: { bg: '#f2eef9', border: '#b9a5d8', hoverBg: '#e8def3', hoverBorder: '#9678c1', text: '#5a3e7d' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/149905022/square.jpg',
			label: 'Morning Glories',
			taxon: { id: 52346, name: 'Ipomoea', preferred_common_name: 'morning-glories', rank: 'genus', iconic_taxon_name: 'Plantae' },
			accent: { bg: '#eef1fb', border: '#a8b6e2', hoverBg: '#e0e6f7', hoverBorder: '#8195d0', text: '#3e518b' }
		},
		{
			photoUrl: 'https://static.inaturalist.org/photos/247609877/square.jpg',
			label: 'Gastropods',
			taxon: { id: 47114, name: 'Gastropoda', preferred_common_name: 'Gastropods', rank: 'class', iconic_taxon_name: 'Mollusca' },
			accent: { bg: '#f5eee8', border: '#c99d79', hoverBg: '#eee0d3', hoverBorder: '#aa754e', text: '#704526' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/54589881/square.jpg',
			label: 'Grasses and allies',
			taxon: { id: 47162, name: 'Poales', preferred_common_name: 'Grasses, Sedges, and Cattails', rank: 'order', iconic_taxon_name: 'Plantae' },
			accent: { bg: '#edf4e3', border: '#92c347', hoverBg: '#e0ecce', hoverBorder: '#719f2d', text: '#365111' }
		},
		{
			photoUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/224614153/square.jpeg',
			label: 'Acacia and allies',
			taxon: { id: 373578, name: 'Mimosoideae', preferred_common_name: 'Acacias, Mimosas, Mesquites, and Allies', rank: 'subfamily', iconic_taxon_name: 'Plantae' },
			accent: { bg: '#fbf7e8', border: '#d9bf65', hoverBg: '#f6eece', hoverBorder: '#bfa13b', text: '#5c480a' }
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
			wrapper.style.setProperty('display', shouldShowQuickIdControls() ? 'grid' : 'none', 'important');

			// Set initial visibility and content of placeholder section
			if (shouldShowQuickIdControls() && currentSpeciesGuess) {
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

	// A modal can be restored from iNaturalist's client cache without producing a
	// fetch response for the page-world bridge. Observe its identity and resolve
	// the observation only while the extension state is still pending.
	document.arrive('.ObservationModal', { existing: true }, function() {
		if (this.dataset.inatObservationFallbackObserved === 'true') return;
		this.dataset.inatObservationFallbackObserved = 'true';
		let lastObservationId = getCurrentModalObservationId();
		scheduleObservationStateFallback();
		new MutationObserver(() => {
			const observationId = getCurrentModalObservationId();
			if (observationId && observationId !== lastObservationId) {
				lastObservationId = observationId;
				if (String(currentIdentifyObservationId || '') !== String(observationId)) {
					document.dispatchEvent(new CustomEvent('inatExtObservationChanging', {
						detail: { observationId }
					}));
				}
				scheduleObservationStateFallback();
			}
		}).observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
	});


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
