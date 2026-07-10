chrome.storage.sync.get({
	enableCount: true,
	enableLogging: false
}, async function(items) {
	if (chrome.runtime.lastError) {
		console.error('[iNat Enhancement Suite] Failed to load settings from storage:', chrome.runtime.lastError.message);
		return;
	}
	// Use shared logging from logging.js
	const logDebug = window.iNatLogDebug || console.debug;

	logDebug('Settings loaded:', items);

	if (!items.enableCount) {
		return;
	}

	document.arrive('.NumObservations > div > div > a.btn[href*="user_id"]', async a => {
		const href = a.href;
		const userMatch = href.match(/[?&]user_id=([^&]+)/i);
		if (!userMatch) {
			return;
		}

		const user = userMatch[1];
		const taxonMatch = href.match(/[?&]taxon_id=(\d+)/i);
		if (!taxonMatch) {
			return;
		}

		const taxonId = taxonMatch[1];
		let placeId = null;
		const placeMatch = href.match(/[?&]place_id=(\d+)/i);
		if (placeMatch) {
			placeId = placeMatch[1];
		}

		logDebug({ user, taxonId, placeId });

		const count = await getObservationCount(user, taxonId, placeId);
		if (count) {
			for (const span of a.querySelectorAll('span')) {
				span.innerHTML += `: <b>${count}</b>`;
				logDebug(span);
			}
		}
	});

	const counts = new Map();
	async function getObservationCount(user, taxonId, placeId) {
		const key = `${taxonId}#${placeId || 'null'}`;
		let count = counts.get(key);
		if (count !== undefined) {
			logDebug(`Using L1 cached count ${count} for ${key}.`);
			return count;
		}

		const persistentKey = `inat-taxacount-${user}-${taxonId}-${placeId || 'null'}`;
		count = await window.iNatCache.read(persistentKey);
		if (count !== null && count !== undefined) {
			logDebug(`Using L2 cached count ${count} for ${key}.`);
			counts.set(key, count);
			return count;
		}

		let url = `https://api.inaturalist.org/v1/observations?user_id=${user}&taxon_id=${taxonId}`;
		if (placeId) {
			url += `&place_id=${placeId}`;
		}

		logDebug(`Requesting ${url}`);

		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const observations = await response.json();
			count = observations.total_results;
			logDebug(`Retrieved count ${count} for ${key}.`);

			counts.set(key, count);
			await window.iNatCache.write(persistentKey, count);
			return count;
		} catch (error) {
			console.error(`[iNat Enhancement] Failed to fetch observation count for ${key}:`, error.message || error);
			return null;
		}
	}
});