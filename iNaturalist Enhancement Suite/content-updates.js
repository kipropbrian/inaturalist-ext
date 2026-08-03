(function () {
	'use strict';

	const API_BASE = 'https://api.inaturalist.org/v1';
	const DEFAULT_MODE = 'all';
	const VALID_MODES = new Set(['attention', 'comments', 'disagreements', 'all']);
	const MIN_FILTERED_RESULTS = 10;
	const MAX_AUTOLOAD_PAGES = 12;
	const CACHE_VERSION = 2;
	const CACHE_TTL_MS = 60 * 60 * 1000;
	const NEGATIVE_CLASSIFICATION_TTL_MS = 10 * 60 * 1000;
	const observationCache = new Map();

	function parseTimestamp(value) {
		const timestamp = Date.parse(value || '');
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	function userLogin(item) {
		return item && item.user && typeof item.user.login === 'string'
			? item.user.login.toLowerCase()
			: '';
	}

	function classifyObservationUpdate(observation, currentUserLogin) {
		const empty = {
			comment: false,
			standardComment: false,
			identificationNote: false,
			disagreement: false,
			hasOwnIdentification: false
		};
		if (!observation || !currentUserLogin) return empty;

		const login = currentUserLogin.toLowerCase();
		const identifications = Array.isArray(observation.identifications)
			? observation.identifications
			: [];
		const ownIdentificationTimes = identifications
			.filter(identification => userLogin(identification) === login)
			.map(identification => parseTimestamp(identification.created_at))
			.filter(timestamp => timestamp !== null);

		if (!ownIdentificationTimes.length) return empty;
		const firstOwnIdentification = Math.min(...ownIdentificationTimes);
		const isLaterActivityBySomeoneElse = item => {
			const timestamp = parseTimestamp(item && item.created_at);
			return userLogin(item) && userLogin(item) !== login
				&& timestamp !== null
				&& timestamp > firstOwnIdentification;
		};

		const standardComment = (Array.isArray(observation.comments) ? observation.comments : [])
			.some(comment => isLaterActivityBySomeoneElse(comment));
		const identificationNote = identifications.some(identification => (
			isLaterActivityBySomeoneElse(identification)
			&& String(identification.body || '').trim().length > 0
		));
		const disagreement = identifications.some(identification => (
			isLaterActivityBySomeoneElse(identification)
			&& identification.disagreement === true
		));

		return {
			comment: standardComment || identificationNote,
			standardComment,
			identificationNote,
			disagreement,
			hasOwnIdentification: true
		};
	}

	function matchesMode(classification, mode) {
		if (mode === 'all') return true;
		if (!classification) return false;
		if (mode === 'comments') return classification.comment;
		if (mode === 'disagreements') return classification.disagreement;
		return classification.comment || classification.disagreement;
	}

	function shouldAutoLoad({ mode, visible, hasMore, pagesLoaded }) {
		return mode !== 'all'
			&& visible < MIN_FILTERED_RESULTS
			&& hasMore
			&& pagesLoaded < MAX_AUTOLOAD_PAGES;
	}

	function cacheKeyForUser(currentUserLogin) {
		return `inat-updates-${String(currentUserLogin || '').trim().toLowerCase()}`;
	}

	function isUsableUpdatesCache(cache, currentUserLogin, now = Date.now()) {
		return Boolean(cache)
			&& cache.version === CACHE_VERSION
			&& cache.userLogin === String(currentUserLogin || '').trim().toLowerCase()
			&& Number.isFinite(cache.cachedAt)
			&& now - cache.cachedAt <= CACHE_TTL_MS
			&& typeof cache.itemsHtml === 'string'
			&& cache.classifications
			&& typeof cache.classifications === 'object';
	}

	function shouldRestoreClassification(classification, savedAt, now = Date.now()) {
		if (!classification) return false;
		if (classification.comment || classification.disagreement) return true;
		return Number.isFinite(savedAt) && now - savedAt <= NEGATIVE_CLASSIFICATION_TTL_MS;
	}

	function extractObservationId(value) {
		if (!value) return '';
		try {
			const pathname = new URL(value, window.location.origin).pathname;
			const match = pathname.match(/^\/observations\/(\d+)/);
			return match ? match[1] : '';
		} catch (error) {
			return '';
		}
	}

	if (typeof globalThis !== 'undefined' && globalThis.__INAT_UPDATES_TEST__) {
		globalThis.__INAT_UPDATES_TEST__.helpers = {
			classifyObservationUpdate,
			extractObservationId,
			matchesMode,
			parseTimestamp,
			shouldAutoLoad,
			cacheKeyForUser,
			isUsableUpdatesCache,
			shouldRestoreClassification
		};
		return;
	}

	start(DEFAULT_MODE);

	async function start(initialMode) {
		if (window.location.pathname !== '/home') return;

		const [updatesPane, updatesTarget] = await Promise.all([
			waitForElement('#updates'),
			waitForElement('#updates_target')
		]);
		if (!updatesPane || !updatesTarget || document.getElementById('inat-update-filter')) return;
		await waitForUpdateItems(updatesTarget);

		const currentUserLogin = findCurrentUserLogin();
		if (!currentUserLogin) {
			console.warn('[iNat Enhancement Suite] Could not determine the signed-in iNaturalist user.');
			return;
		}

		const state = {
			mode: initialMode,
			currentUserLogin,
			refreshing: false,
			refreshRequested: false,
			refreshTimer: null,
			apiFailed: false,
			autoLoadedPages: 0,
			paginationExhausted: false,
			paginationFailed: false,
			seenPageCursors: new Set(),
			classifications: new Map(),
			classificationSavedAt: new Map(),
			scannedUpdates: 0,
			cacheRestored: false,
			cacheSavedAt: null,
			paginationLoadedThisVisit: false,
			filterDataLoaded: false,
			originalPaginationHtml: updatesTarget.querySelector(':scope > .pagination')?.outerHTML || ''
		};
		const controls = injectControls(updatesPane, initialMode);

		controls.select.addEventListener('change', async () => {
			state.mode = VALID_MODES.has(controls.select.value) ? controls.select.value : DEFAULT_MODE;
			state.paginationFailed = false;
			if (state.mode === 'all') {
				restoreNativeUpdatesView(updatesTarget, state);
				applyCurrentFilter(updatesTarget, controls.status, state);
				return;
			}
			if (!state.filterDataLoaded) await restoreUpdatesCache(updatesTarget, controls.status, state);
			await refresh(updatesTarget, controls.status, state);
			if (state.mode !== 'all') state.filterDataLoaded = true;
		});

		const observer = new MutationObserver(mutations => {
			const hasNewUpdate = mutations.some(mutation => Array.from(mutation.addedNodes).some(node => (
				node.nodeType === Node.ELEMENT_NODE
				&& (node.matches('li.observation_multiple_added')
					|| node.querySelector('li.observation_multiple_added'))
			)));
			if (hasNewUpdate) scheduleRefresh(updatesTarget, controls.status, state);
		});
		observer.observe(updatesTarget, { childList: true, subtree: true });
		await refresh(updatesTarget, controls.status, state);
	}

	function waitForElement(selector) {
		const existing = document.querySelector(selector);
		if (existing) return Promise.resolve(existing);

		return new Promise(resolve => {
			const observer = new MutationObserver(() => {
				const element = document.querySelector(selector);
				if (!element) return;
				observer.disconnect();
				resolve(element);
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
			setTimeout(() => {
				observer.disconnect();
				resolve(document.querySelector(selector));
			}, 10000);
		});
	}

	function waitForUpdateItems(target) {
		if (getUpdateItems(target).length || findMoreLink(target)) return Promise.resolve();
		return new Promise(resolve => {
			const observer = new MutationObserver(() => {
				if (!getUpdateItems(target).length && !findMoreLink(target)) return;
				observer.disconnect();
				resolve();
			});
			observer.observe(target, { childList: true, subtree: true });
			setTimeout(() => {
				observer.disconnect();
				resolve();
			}, 10000);
		});
	}

	function findCurrentUserLogin() {
		const link = document.querySelector('h1 a[href*="/people/"]');
		if (!link) return '';
		try {
			const match = new URL(link.href, window.location.origin).pathname.match(/^\/people\/([^/]+)/);
			return match ? decodeURIComponent(match[1]).trim() : '';
		} catch (error) {
			return (link.textContent || '').trim();
		}
	}

	function injectControls(updatesPane, initialMode) {
		const container = document.createElement('section');
		container.id = 'inat-update-filter';
		container.setAttribute('aria-label', 'Update attention filter');
		container.innerHTML = `
			<div class="inat-update-filter-row">
				<label for="inat-update-filter-mode">Show</label>
				<select id="inat-update-filter-mode">
					<option value="attention">Comments or disagreements</option>
					<option value="comments">Comments only</option>
					<option value="disagreements">Disagreements only</option>
					<option value="all">Everything</option>
				</select>
				<span id="inat-update-filter-status" role="status">Checking loaded updates…</span>
			</div>
			<p>Comments include normal observation comments and notes attached to identifications. Activity must have been added by someone else after one of your IDs.</p>
		`;
		updatesPane.insertBefore(container, updatesPane.firstChild);
		const select = container.querySelector('#inat-update-filter-mode');
		select.value = initialMode;
		return {
			select,
			status: container.querySelector('#inat-update-filter-status')
		};
	}

	function scheduleRefresh(target, status, state) {
		clearTimeout(state.refreshTimer);
		state.refreshTimer = setTimeout(() => refresh(target, status, state), 120);
	}

	async function refresh(target, status, state) {
		if (state.refreshing) {
			state.refreshRequested = true;
			return;
		}
		state.refreshing = true;
		try {
			do {
				state.refreshRequested = false;
				const summary = await refreshOnce(target, status, state);
				if (shouldAutoLoad({
					mode: state.mode,
					visible: summary.visible,
					hasMore: summary.hasMore,
					pagesLoaded: state.autoLoadedPages
				})) {
					status.textContent = `Found ${summary.visible.toLocaleString()} matching update${summary.visible === 1 ? '' : 's'} in ${summary.total.toLocaleString()} loaded updates. Loading older updates (${state.autoLoadedPages + 1}/${MAX_AUTOLOAD_PAGES})…`;
					try {
						const loaded = await loadOlderUpdates(target, state);
						state.autoLoadedPages += 1;
						state.scannedUpdates += loaded.added;
						state.paginationLoadedThisVisit = state.paginationLoadedThisVisit || loaded.added > 0;
						state.paginationExhausted = !loaded.hasMore;
						state.refreshRequested = loaded.added > 0;
					} catch (error) {
						state.paginationFailed = true;
						console.error('[iNat Enhancement Suite] Failed to load older updates:', error);
						applyCurrentFilter(target, status, state);
					}
				}
			} while (state.refreshRequested);
			await saveUpdatesCache(target, state);
		} finally {
			state.refreshing = false;
			if (state.refreshRequested) scheduleRefresh(target, status, state);
		}
	}

	async function refreshOnce(target, status, state) {
		const items = getUpdateItems(target);
		if (!state.scannedUpdates) state.scannedUpdates = items.length;
		if (state.mode === 'all') return applyCurrentFilter(target, status, state);
		const ids = [...new Set(items.map(item => observationIdForItem(item)).filter(Boolean))];
		const missingIds = ids.filter(id => !observationCache.has(id) && !state.classifications.has(id));

		if (missingIds.length) {
			status.textContent = `Checking ${missingIds.length.toLocaleString()} newly loaded update${missingIds.length === 1 ? '' : 's'}…`;
			state.apiFailed = false;
			for (let offset = 0; offset < missingIds.length; offset += 100) {
				const batch = missingIds.slice(offset, offset + 100);
				try {
					await fetchObservationBatch(batch);
				} catch (error) {
					state.apiFailed = true;
					console.error('[iNat Enhancement Suite] Failed to inspect update activity:', error);
				}
			}
		}

		for (const item of items) {
			const observationId = observationIdForItem(item);
			const observation = observationId ? observationCache.get(observationId) : null;
			let classification = observationId ? state.classifications.get(observationId) : null;
			if (observation) {
				classification = classifyObservationUpdate(observation, state.currentUserLogin);
				state.classifications.set(observationId, classification);
				state.classificationSavedAt.set(observationId, Date.now());
			}
			if (!classification) classification = classificationForItem(item) || classifyFromRenderedUpdate(item);
			applyClassification(item, classification);
		}

		return applyCurrentFilter(target, status, state);
	}

	async function loadOlderUpdates(target, state) {
		const moreLink = findMoreLink(target);
		if (!moreLink) return { added: 0, hasMore: false };

		const cursor = moreLink.dataset.from || moreLink.getAttribute('href') || '';
		if (!cursor || state.seenPageCursors.has(cursor)) {
			return { added: 0, hasMore: false };
		}

		const response = await fetch(new URL(moreLink.getAttribute('href'), window.location.origin).href, {
			credentials: 'same-origin',
			headers: { 'X-Requested-With': 'XMLHttpRequest' }
		});
		if (!response.ok) throw new Error(`Updates pagination error ${response.status}`);
		if (state.mode === 'all') return { added: 0, hasMore: Boolean(findMoreLink(target)) };

		const documentFragment = new DOMParser().parseFromString(await response.text(), 'text/html');
		const loadedTimeline = documentFragment.querySelector('ul.timeline');
		const loadedItems = loadedTimeline
			? Array.from(loadedTimeline.querySelectorAll(':scope > li'))
			: [];
		if (!loadedItems.length) return { added: 0, hasMore: false };
		state.seenPageCursors.add(cursor);

		let timeline = target.querySelector(':scope > ul.timeline');
		if (!timeline) {
			timeline = document.createElement('ul');
			timeline.className = 'timeline';
			target.prepend(timeline);
		}
		for (const item of loadedItems) {
			item.dataset.inatUpdateAutoloaded = 'true';
			timeline.appendChild(document.importNode(item, true));
		}

		const currentPagination = target.querySelector(':scope > .pagination');
		const loadedPagination = documentFragment.querySelector('.pagination');
		const nextMoreLink = loadedPagination && loadedPagination.querySelector('#more_pagination');
		if (nextMoreLink) {
			const importedPagination = document.importNode(loadedPagination, true);
			if (currentPagination) currentPagination.replaceWith(importedPagination);
			else target.appendChild(importedPagination);
		} else if (currentPagination) {
			currentPagination.remove();
		}

		return { added: loadedItems.length, hasMore: Boolean(nextMoreLink) };
	}

	function findMoreLink(target) {
		return target.querySelector(':scope > .pagination #more_pagination');
	}

	function getUpdateItems(target) {
		return Array.from(target.querySelectorAll(':scope > ul.timeline > li'));
	}

	function observationIdForItem(item) {
		const link = item.querySelector('a[href*="/observations/"]');
		return link ? extractObservationId(link.href) : '';
	}

	function updateItemKey(item) {
		const observationId = observationIdForItem(item);
		const timestamp = item.querySelector('.time[title]')?.getAttribute('title') || '';
		return observationId ? `${observationId}|${timestamp}` : '';
	}

	function restoreNativeUpdatesView(target, state) {
		for (const item of target.querySelectorAll('[data-inat-update-cached="true"], [data-inat-update-autoloaded="true"]')) {
			item.remove();
		}
		const currentPagination = target.querySelector(':scope > .pagination');
		if (state.originalPaginationHtml) {
			const parsed = new DOMParser().parseFromString(state.originalPaginationHtml, 'text/html');
			const pagination = parsed.querySelector('.pagination');
			if (pagination) {
				const imported = document.importNode(pagination, true);
				if (currentPagination) currentPagination.replaceWith(imported);
				else target.appendChild(imported);
			}
		} else if (currentPagination) {
			currentPagination.remove();
		}
		state.autoLoadedPages = 0;
		state.scannedUpdates = getUpdateItems(target).length;
		state.paginationExhausted = false;
		state.paginationFailed = false;
		state.cacheRestored = false;
		state.filterDataLoaded = false;
		state.paginationLoadedThisVisit = false;
	}

	async function restoreUpdatesCache(target, status, state) {
		if (!window.iNatCache) return;
		status.textContent = 'Restoring cached update matches…';
		const cached = await window.iNatCache.read(cacheKeyForUser(state.currentUserLogin));
		if (!isUsableUpdatesCache(cached, state.currentUserLogin)) return;

		for (const [observationId, record] of Object.entries(cached.classifications)) {
			const classification = record && record.classification;
			const savedAt = record && record.savedAt;
			if (!shouldRestoreClassification(classification, savedAt)) continue;
			state.classifications.set(observationId, classification);
			state.classificationSavedAt.set(observationId, savedAt);
		}

		const parsed = new DOMParser().parseFromString(
			`<ul class="timeline">${cached.itemsHtml}</ul>`,
			'text/html'
		);
		const cachedItems = Array.from(parsed.querySelectorAll('ul.timeline > li'));
		let timeline = target.querySelector(':scope > ul.timeline');
		if (!timeline) {
			timeline = document.createElement('ul');
			timeline.className = 'timeline';
			target.prepend(timeline);
		}
		const existingKeys = new Set(getUpdateItems(target).map(updateItemKey).filter(Boolean));
		for (const cachedItem of cachedItems) {
			const key = updateItemKey(cachedItem);
			if (!key || existingKeys.has(key)) continue;
			existingKeys.add(key);
			cachedItem.dataset.inatUpdateCached = 'true';
			timeline.appendChild(document.importNode(cachedItem, true));
		}

		const currentPagination = target.querySelector(':scope > .pagination');
		if (cached.paginationHtml) {
			const paginationDocument = new DOMParser().parseFromString(cached.paginationHtml, 'text/html');
			const cachedPagination = paginationDocument.querySelector('.pagination');
			if (cachedPagination) {
				const importedPagination = document.importNode(cachedPagination, true);
				if (currentPagination) currentPagination.replaceWith(importedPagination);
				else target.appendChild(importedPagination);
			}
		} else if (cached.paginationExhausted && currentPagination) {
			currentPagination.remove();
		}

		state.autoLoadedPages = Number.isFinite(cached.autoLoadedPages) ? cached.autoLoadedPages : 0;
		state.scannedUpdates = Number.isFinite(cached.scannedUpdates) ? cached.scannedUpdates : getUpdateItems(target).length;
		state.paginationExhausted = cached.paginationExhausted === true;
		state.cacheRestored = true;
		state.cacheSavedAt = Number.isFinite(cached.cachedAt) ? cached.cachedAt : null;
	}

	async function saveUpdatesCache(target, state) {
		if (state.mode === 'all' || !window.iNatCache || !state.classifications.size) return;
		const matchingItems = getUpdateItems(target).filter(item => {
			const classification = classificationForItem(item);
			return classification && (classification.comment || classification.disagreement);
		});
		const pagination = target.querySelector(':scope > .pagination');
		const cachedAt = state.cacheRestored && !state.paginationLoadedThisVisit && state.cacheSavedAt
			? state.cacheSavedAt
			: Date.now();
		await window.iNatCache.write(cacheKeyForUser(state.currentUserLogin), {
			version: CACHE_VERSION,
			userLogin: state.currentUserLogin.toLowerCase(),
			cachedAt,
			autoLoadedPages: state.autoLoadedPages,
			scannedUpdates: state.scannedUpdates,
			paginationExhausted: state.paginationExhausted,
			paginationHtml: pagination ? pagination.outerHTML : '',
			itemsHtml: matchingItems.map(item => item.outerHTML).join(''),
			classifications: Object.fromEntries(Array.from(state.classifications, ([observationId, classification]) => [
				observationId,
				{
					classification,
					savedAt: state.classificationSavedAt.get(observationId) || cachedAt
				}
			]))
		});
		state.cacheSavedAt = cachedAt;
	}

	async function fetchObservationBatch(ids) {
		const params = new URLSearchParams({ id: ids.join(','), per_page: '200' });
		const response = await fetch(`${API_BASE}/observations?${params}`);
		if (!response.ok) throw new Error(`Observation API error ${response.status}`);
		const data = await response.json();
		const found = new Set();
		for (const observation of data.results || []) {
			const id = String(observation.id);
			found.add(id);
			observationCache.set(id, observation);
		}
		for (const id of ids) {
			if (!found.has(String(id))) observationCache.set(String(id), null);
		}
	}

	function classifyFromRenderedUpdate(item) {
		const text = (item.textContent || '').toLowerCase();
		const hasComment = text.includes('added a comment') || Boolean(item.querySelector('.readable.body'));
		return {
			comment: hasComment,
			standardComment: hasComment,
			identificationNote: false,
			disagreement: false,
			hasOwnIdentification: text.includes('you added an identification')
		};
	}

	function applyClassification(item, classification) {
		item.dataset.inatUpdateReady = 'true';
		item.dataset.inatUpdateComment = classification.comment ? 'true' : 'false';
		item.dataset.inatUpdateDisagreement = classification.disagreement ? 'true' : 'false';
		item.dataset.inatUpdateOwnIdentification = classification.hasOwnIdentification ? 'true' : 'false';
		renderSignalBadges(item, classification);
	}

	function renderSignalBadges(item, classification) {
		const signature = `${classification.comment ? 'comment' : ''}|${classification.disagreement ? 'disagreement' : ''}`;
		if (item.dataset.inatUpdateBadgeSignature === signature) return;
		item.dataset.inatUpdateBadgeSignature = signature;

		const existing = item.querySelector(':scope > .timeline-panel > .timeline-heading .inat-update-signals');
		if (existing) existing.remove();
		if (!classification.comment && !classification.disagreement) return;

		const heading = item.querySelector(':scope > .timeline-panel > .timeline-heading .timeline-title');
		if (!heading) return;
		const signals = document.createElement('span');
		signals.className = 'inat-update-signals';
		if (classification.comment) {
			const comment = document.createElement('span');
			comment.className = 'inat-update-signal inat-update-signal--comment';
			comment.textContent = 'Comment';
			signals.appendChild(comment);
		}
		if (classification.disagreement) {
			const disagreement = document.createElement('span');
			disagreement.className = 'inat-update-signal inat-update-signal--disagreement';
			disagreement.textContent = 'Disagreement';
			signals.appendChild(disagreement);
		}
		heading.appendChild(signals);
	}

	function classificationForItem(item) {
		if (item.dataset.inatUpdateReady !== 'true') return null;
		return {
			comment: item.dataset.inatUpdateComment === 'true',
			disagreement: item.dataset.inatUpdateDisagreement === 'true'
		};
	}

	function applyCurrentFilter(target, status, state) {
		const items = getUpdateItems(target);
		const active = state.mode !== 'all';
		target.classList.toggle('inat-update-filter-active', active);

		let visible = 0;
		let ready = 0;
		for (const item of items) {
			const classification = classificationForItem(item);
			if (classification) ready += 1;
			const show = state.mode === 'all' || matchesMode(classification, state.mode);
			item.classList.toggle('inat-update-hidden', !show);
			if (show) visible += 1;
		}

		const pending = items.length - ready;
		const hasMore = Boolean(findMoreLink(target)) && !state.paginationExhausted;
		const summary = { total: items.length, visible, pending, hasMore };
		if (pending > 0 && state.mode !== 'all') {
			status.textContent = `Checking ${pending.toLocaleString()} of ${items.length.toLocaleString()} loaded updates…`;
			return summary;
		}
		if (state.mode === 'all') {
			status.textContent = `Showing all ${items.length.toLocaleString()} loaded updates.`;
			return summary;
		}

		const modeLabel = state.mode === 'comments'
			? 'comments'
			: state.mode === 'disagreements'
				? 'disagreements'
				: 'comments or disagreements';
		const pageCount = state.autoLoadedPages + 1;
		const pageSummary = state.autoLoadedPages > 0
			? ` after scanning ${Math.max(state.scannedUpdates, items.length).toLocaleString()} updates across ${pageCount.toLocaleString()} batches`
			: '';
		let suffix = state.apiFailed ? ' Some disagreement checks could not be completed.' : '';
		if (state.cacheRestored) suffix += ' Restored from the local cache.';
		if (state.paginationFailed) suffix += ' Older updates could not be loaded.';
		else if (state.paginationExhausted) suffix += ' Reached the end of available updates.';
		else if (state.autoLoadedPages >= MAX_AUTOLOAD_PAGES && visible < MIN_FILTERED_RESULTS) {
			suffix += ` Paused after ${MAX_AUTOLOAD_PAGES} older batches.`;
		}
		status.textContent = visible
			? `Showing ${visible.toLocaleString()} matching update${visible === 1 ? '' : 's'} from ${items.length.toLocaleString()} loaded updates${pageSummary} with ${modeLabel}.${suffix}`
			: `No matching updates with ${modeLabel} were found in ${items.length.toLocaleString()} loaded updates${pageSummary}.${suffix}`;
		return summary;
	}
})();
