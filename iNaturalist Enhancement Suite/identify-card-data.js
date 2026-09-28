// Reuse the observation and place responses the Identify page already requests.
// This runs in the page world so it can see the page's fetch responses.
if (window.location.pathname === '/observations/identify') {
	const originalFetch = window.fetch;
	window.fetch = function(...args) {
		const url = String(typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
		const responsePromise = originalFetch.apply(this, args);
		if (!/^https:\/\/api\.inaturalist\.org\/v\d+\/(observations(?:\?|$)|places\/)/i.test(url)) {
			return responsePromise;
		}
		responsePromise.then(response => {
			if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
			const copy = response.clone();
			// Parsing is a side effect; never delay the native Identify request.
			setTimeout(() => {
				copy.json().then(data => {
					if (!Array.isArray(data?.results)) return;
					if (/\/observations(?:\?|$)/i.test(url)) {
						const observations = data.results.filter(o => o?.id).map(o => ({
							id: o.id,
							place_ids: o.place_ids || []
						}));
						document.dispatchEvent(new CustomEvent('inatExtIdentifyCardObservations', { detail: observations }));
					} else {
						const countries = data.results.filter(p => p?.admin_level === 0 && p?.name)
							.map(p => ({ id: p.id, name: p.name }));
						document.dispatchEvent(new CustomEvent('inatExtIdentifyCardCountries', { detail: countries }));
					}
				}).catch(() => {});
			}, 0);
		}, () => {});
		return responsePromise;
	};
}
