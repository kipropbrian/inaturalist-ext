// Shared caching utilities for iNaturalist Enhancement Suite
// This file must be loaded after logging.js and before other content scripts

(function() {
	'use strict';

	const log = window.iNatLog || console.log;
	const logError = window.iNatLogError || console.error;
	const logDebug = window.iNatLogDebug || console.debug;

	const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100 MB
	const TARGET_CACHE_SIZE = 80 * 1024 * 1024; // 80 MB

	const TTL_MAP = {
		'inat-cv-score-': 1 * 24 * 60 * 60 * 1000,    // 1 day
		'inat-cv-crop-': 1 * 24 * 60 * 60 * 1000,     // 1 day
		'inat-taxon-': 30 * 24 * 60 * 60 * 1000,      // 30 days
		'inat-userstats-': 1 * 24 * 60 * 60 * 1000,   // 1 day
		'inat-taxacount-': 1 * 24 * 60 * 60 * 1000,   // 1 day
		'inat-similar-': 7 * 24 * 60 * 60 * 1000,     // 7 days
		'inat-updates-': 1 * 60 * 60 * 1000           // 1 hour
	};

	function getTtlForKey(key) {
		for (const [prefix, ttl] of Object.entries(TTL_MAP)) {
			if (key.startsWith(prefix)) {
				return ttl;
			}
		}
		return 7 * 24 * 60 * 60 * 1000; // Default 7 days fallback
	}

	function isInvalidatedContext(error) {
		return String(error?.message || error || '').includes('Extension context invalidated');
	}

	function logStorageError(message, error) {
		if (!isInvalidatedContext(error)) {
			logError(message, error?.message || error);
		}
	}

	function hasExtensionContext() {
		try {
			return Boolean(chrome.runtime?.id);
		} catch (_) {
			return false;
		}
	}

	async function storageCall(operation, ...args) {
		if (!hasExtensionContext()) return { ok: false, value: null };
		try {
			const value = await chrome.storage.local[operation](...args);
			return { ok: true, value };
		} catch (error) {
			logStorageError(`Persistent cache ${operation} failed:`, error);
			return { ok: false, value: null };
		}
	}

	async function evictOldCacheIfNeeded() {
		const usage = await storageCall('getBytesInUse', null);
		if (!usage.ok || usage.value < MAX_CACHE_SIZE) return;

		log('Cache size limit approached. Current size:', usage.value, 'bytes. Starting eviction...');
		const stored = await storageCall('get', null);
		if (!stored.ok || !stored.value) return;

		const cacheEntries = Object.entries(stored.value)
			.filter(([key, item]) => key.startsWith('inat-') && item && typeof item.savedAt === 'number')
			.map(([key, item]) => ({ key, savedAt: item.savedAt, size: JSON.stringify(item).length }))
			.sort((a, b) => a.savedAt - b.savedAt);
		let currentBytes = usage.value;
		const keysToRemove = [];
		for (const entry of cacheEntries) {
			if (currentBytes < TARGET_CACHE_SIZE) break;
			keysToRemove.push(entry.key);
			currentBytes -= entry.size;
		}

		if (keysToRemove.length) {
			log('Evicting', keysToRemove.length, 'old cache entries...');
			await storageCall('remove', keysToRemove);
		}
	}

	window.iNatCache = {
		read: async function(key) {
			const stored = await storageCall('get', key);
			if (!stored.ok) return null;

			const entry = stored.value ? stored.value[key] : null;
			if (!entry) return null;

			const ttl = getTtlForKey(key);
			if (Date.now() - entry.savedAt > ttl) {
				logDebug(`Cache expired for key: ${key}. Evicting...`);
				await storageCall('remove', key);
				return null;
			}
			return entry.value;
		},

		write: async function(key, value) {
			await evictOldCacheIfNeeded();
			await storageCall('set', { [key]: { savedAt: Date.now(), value } });
		}
	};
})();
