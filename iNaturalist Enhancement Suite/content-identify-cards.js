if (window.location.pathname === '/observations/identify') {
	const observations = new Map();
	const countries = new Map();
	const names = new Intl.DisplayNames(['en'], { type: 'region' });
	const countryCodes = new Map();
	const normalize = name => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
		.toLowerCase().replace(/[^a-z0-9]/g, '');
	for (let a = 65; a <= 90; a++) {
		for (let b = 65; b <= 90; b++) {
			const code = String.fromCharCode(a, b);
			const name = names.of(code);
			if (name && name !== code) countryCodes.set(normalize(name), code);
		}
	}
	// iNaturalist place names that differ from Intl's English region names.
	for (const [name, code] of Object.entries({
		'Ivory Coast': 'CI', 'Democratic Republic of the Congo': 'CD',
		'Republic of the Congo': 'CG', 'South Korea': 'KR', 'North Korea': 'KP',
		'Taiwan': 'TW', 'Russia': 'RU', 'Vatican City': 'VA', 'Cape Verde': 'CV',
		'Swaziland': 'SZ', 'East Timor': 'TL', 'The Gambia': 'GM'
	})) countryCodes.set(normalize(name), code);
	const flagFor = name => {
		const code = countryCodes.get(normalize(name));
		return code ? [...code].map(letter => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65)).join('') : '';
	};
	let frame = null;
	function render() {
		frame = null;
		for (const card of document.querySelectorAll('#Identify .ObservationsGridItem')) {
			const id = card.querySelector('a.media[href^="/observations/"]')?.getAttribute('href')?.match(/^\/observations\/(\d+)/)?.[1];
			const placeIds = observations.get(id);
			const country = placeIds?.map(placeId => countries.get(placeId)).find(Boolean);
			const flag = country && flagFor(country);
			let badge = card.querySelector('.inat-identify-country');
			if (!flag) { badge?.remove(); continue; }
			if (!badge) {
				badge = document.createElement('span');
				badge.className = 'inat-identify-country';
				badge.setAttribute('role', 'img');
				card.querySelector('.caption')?.prepend(badge);
			}
			if (badge.textContent !== flag) badge.textContent = flag;
			if (badge.title !== country) badge.title = country;
			if (badge.getAttribute('aria-label') !== country) badge.setAttribute('aria-label', country);
		}
	}
	function scheduleRender() {
		if (frame === null) frame = requestAnimationFrame(render);
	}
	document.addEventListener('inatExtIdentifyCardObservations', event => {
		for (const observation of event.detail || []) {
			observations.set(String(observation.id), observation.place_ids || []);
		}
		scheduleRender();
	});
	document.addEventListener('inatExtIdentifyCardCountries', event => {
		for (const country of event.detail || []) countries.set(country.id, country.name);
		scheduleRender();
	});
	const style = document.createElement('style');
	style.textContent = '#Identify .inat-identify-country { float: right; margin-left: 4px; font-size: 18px; line-height: 1; }';
	(document.head || document.documentElement).appendChild(style);
	const observer = new MutationObserver(scheduleRender);
	observer.observe(document.documentElement, { childList: true, subtree: true });
}
