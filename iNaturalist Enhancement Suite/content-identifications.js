(function () {
	'use strict';

	chrome.storage.sync.get({ enableIdentificationExplorer: true }, function (settings) {
		if (!settings.enableIdentificationExplorer) return;

		const match = window.location.pathname.match(/^\/identifications\/([^/?#]+)/);
		if (!match) return;

		const username    = decodeURIComponent(match[1]);
		const API_BASE    = 'https://api.inaturalist.org/v1';

		let searchCtrl    = null;
		let acCtrl        = null;
		let selectedTaxon = null; // { id, name, commonName } — set by autocomplete selection
		let debounce      = null;

		waitForMount()
			.then(inject)
			.catch(err => (window.iNatLogError || console.error)('ID toolbar:', err));

		// ── Mount ────────────────────────────────────────────────────────────

		function waitForMount() {
			return new Promise(resolve => {
				const el = findMount();
				if (el) return resolve(el);
				const obs = new MutationObserver(() => {
					const el = findMount();
					if (el) { obs.disconnect(); resolve(el); }
				});
				obs.observe(document.documentElement, { childList: true, subtree: true });
				setTimeout(() => { obs.disconnect(); resolve(document.body); }, 5000);
			});
		}

		function findMount() {
			return document.querySelector('.identifications-tab')
				|| document.querySelector('.identifications')
				|| document.querySelector('#identifications')
				|| document.querySelector('.container .row')
				|| document.querySelector('.main-wrapper');
		}

		// ── Inject toolbar ───────────────────────────────────────────────────

		function inject(mount) {
			if (document.getElementById('inat-id-toolbar')) return;

			const bar = document.createElement('div');
			bar.id = 'inat-id-toolbar';
			bar.innerHTML = `
				<div class="inat-id-panel">
					<form id="inat-id-form" novalidate>
						<div class="inat-id-fields">
							<div class="inat-id-field inat-id-field--taxon">
								<label for="inat-id-query">Taxon</label>
								<div class="inat-id-ac-wrap">
									<input id="inat-id-query" type="text" placeholder="e.g. Woodlice, Fungi, Hawk…" autocomplete="off" spellcheck="false">
									<ul id="inat-id-ac" role="listbox" hidden></ul>
								</div>
							</div>
							<div class="inat-id-field inat-id-field--category">
								<label for="inat-id-category">Category</label>
								<select id="inat-id-category">
									<option value="">Any</option>
									<option value="leading">Leading</option>
									<option value="improving">Improving</option>
									<option value="supporting">Supporting</option>
									<option value="maverick">Maverick</option>
								</select>
							</div>
							<div class="inat-id-field inat-id-field--check">
								<span class="inat-id-label-spacer"></span>
								<label class="inat-id-check-label" for="inat-id-current">
									<input id="inat-id-current" type="checkbox" checked>
									<span>Current IDs only</span>
								</label>
							</div>
							<div class="inat-id-field inat-id-field--btns">
								<span class="inat-id-label-spacer"></span>
								<div class="inat-id-btn-group">
									<button type="submit" id="inat-id-btn-search">Search</button>
									<button type="button" id="inat-id-btn-clear" hidden>Clear</button>
								</div>
							</div>
						</div>
					</form>
					<div id="inat-id-status" hidden></div>
					<div id="inat-id-results"></div>
				</div>
			`;

			mount.insertBefore(bar, mount.firstChild);
			bindEvents(bar);
		}

		// ── Events ───────────────────────────────────────────────────────────

		function bindEvents(bar) {
			const input = bar.querySelector('#inat-id-query');
			const acList = bar.querySelector('#inat-id-ac');

			// Autocomplete typing
			input.addEventListener('input', () => {
				selectedTaxon = null;
				clearTimeout(debounce);
				const q = input.value.trim();
				if (q.length < 2) { acList.hidden = true; return; }
				debounce = setTimeout(() => fetchAC(q), 280);
			});

			// Keyboard nav: focus into dropdown
			input.addEventListener('keydown', e => {
				if (e.key === 'ArrowDown' && !acList.hidden) {
					e.preventDefault();
					const first = acList.querySelector('li');
					if (first) first.focus();
				} else if (e.key === 'Escape') {
					acList.hidden = true;
				}
			});

			// Keyboard nav: within dropdown
			acList.addEventListener('keydown', e => {
				const active = document.activeElement;
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					const next = active.nextElementSibling;
					if (next) next.focus();
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					const prev = active.previousElementSibling;
					if (prev) prev.focus(); else input.focus();
				} else if (e.key === 'Enter') {
					e.preventDefault();
					active.click();
				} else if (e.key === 'Escape') {
					acList.hidden = true;
					input.focus();
				}
			});

			// Close on outside click
			document.addEventListener('click', e => {
				if (!bar.contains(e.target)) acList.hidden = true;
			});

			// Submit
			bar.querySelector('#inat-id-form').addEventListener('submit', e => {
				e.preventDefault();
				acList.hidden = true;
				runSearch();
			});

			// Clear
			bar.querySelector('#inat-id-btn-clear').addEventListener('click', clearAll);
		}

		// ── Autocomplete ─────────────────────────────────────────────────────

		async function fetchAC(q) {
			if (acCtrl) acCtrl.abort();
			acCtrl = new AbortController();
			try {
				const params = new URLSearchParams({ q, per_page: 7, is_active: true });
				const res = await fetch(`${API_BASE}/taxa?${params}`, { signal: acCtrl.signal });
				if (!res.ok) return;
				renderAC((await res.json()).results || []);
			} catch (e) {
				if (e.name !== 'AbortError') console.error(e);
			}
		}

		function renderAC(taxa) {
			const acList = document.getElementById('inat-id-ac');
			const input  = document.getElementById('inat-id-query');

			if (!taxa.length) { acList.hidden = true; return; }

			acList.innerHTML = taxa.map(t => {
				const primary   = t.preferred_common_name || t.name;
				const secondary = t.preferred_common_name ? t.name : '';
				return `
					<li role="option" tabindex="-1"
						data-id="${t.id}"
						data-name="${escapeAttr(t.name)}"
						data-common="${escapeAttr(t.preferred_common_name || '')}">
						<span class="inat-ac-text">
							<span class="inat-ac-primary">${escapeHtml(primary)}</span>
							${secondary ? `<em class="inat-ac-secondary">${escapeHtml(secondary)}</em>` : ''}
						</span>
						<span class="inat-ac-rank">${escapeHtml(t.rank || '')}</span>
					</li>
				`;
			}).join('');

			acList.hidden = false;

			acList.querySelectorAll('li').forEach(li => {
				li.addEventListener('mousedown', e => e.preventDefault()); // keep focus on input
				li.addEventListener('click', () => {
					selectedTaxon = { id: li.dataset.id, name: li.dataset.name, commonName: li.dataset.common };
					input.value = li.dataset.common || li.dataset.name;
					acList.hidden = true;
				});
			});
		}

		// ── Search ───────────────────────────────────────────────────────────

		async function runSearch() {
			const query       = document.getElementById('inat-id-query').value.trim();
			const category    = document.getElementById('inat-id-category').value;
			const currentOnly = document.getElementById('inat-id-current').checked;

			if (!query && !category) {
				setStatus('Enter a taxon or choose a category, then search.', 'info');
				return;
			}

			// Warn if user typed but didn't pick from autocomplete — taxon_name doesn't work on this API
			if (query && !selectedTaxon) {
				setStatus('⚠ Please select a taxon from the suggestions for accurate results.', 'warn');
				return;
			}

			if (searchCtrl) searchCtrl.abort();
			searchCtrl = new AbortController();

			setStatus('Searching…', 'loading');
			document.getElementById('inat-id-results').innerHTML = '';
			document.getElementById('inat-id-btn-clear').hidden = false;

			try {
				const params = new URLSearchParams({
					user_id: username,
					per_page: '10',
					order: 'desc',
					order_by: 'created_at'
				});

				if (selectedTaxon) params.set('taxon_id', selectedTaxon.id);
				if (category) params.set('category', category);
				if (currentOnly) params.set('current', 'true');

				const res = await fetch(`${API_BASE}/identifications?${params}`, { signal: searchCtrl.signal });
				if (!res.ok) throw new Error(`API error ${res.status}`);

				const data     = await res.json();
				const total    = data.total_results || 0;
				const rawItems = data.results || [];
				const taxa     = await fetchMissingTaxa(rawItems, searchCtrl.signal);
				const items    = rawItems.map(id => normalizeId(id, taxa)).filter(i => i.observationId);

				renderResults(items, total);
			} catch (err) {
				if (err.name === 'AbortError') return;
				setStatus(`Search failed: ${err.message}`, 'error');
			}
		}

		// ── Normalise ────────────────────────────────────────────────────────

		async function fetchMissingTaxa(ids, signal) {
			const missingIds = [...new Set(ids
				.filter(id => !id.taxon || !id.taxon.name || !id.taxon.default_photo)
				.map(id => id.taxon_id || (id.taxon && id.taxon.id))
				.filter(Boolean))];

			if (!missingIds.length) return new Map();

			const res = await fetch(`${API_BASE}/taxa/${missingIds.join(',')}`, { signal });
			if (!res.ok) return new Map();

			const data = await res.json();
			return new Map((data.results || []).map(taxon => [String(taxon.id), taxon]));
		}

		function normalizeId(id, taxa) {
			const obs      = id.observation || {};
			const taxonId  = id.taxon_id || (id.taxon && id.taxon.id);
			const hydrated = taxa.get(String(taxonId)) || {};
			const taxon    = { ...(obs.taxon || {}), ...(id.taxon || {}), ...hydrated };
			const observer = obs.user || {};
			const photo    = obs.photos && obs.photos[0];

			return {
				id:             id.id,
				observationId:  obs.id,
				observationUrl: obs.uri || (obs.id ? `https://www.inaturalist.org/observations/${obs.id}` : ''),
				createdAt:      id.created_at || '',
				category:       id.category || 'unknown',
				current:        id.current !== false,
				scientificName: taxon.name || '',
				commonName:     taxon.preferred_common_name || '',
				rank:           taxon.rank || '',
				iconicTaxon:    taxon.iconic_taxon_name || '',
				taxonId:        taxon.id || '',
				taxonPhoto:     taxon.default_photo ? (taxon.default_photo.square_url || taxon.default_photo.url) : '',
				observerLogin:  observer.login || '',
				observerName:   observer.name || observer.login || '',
				observedOn:     obs.observed_on || '',
				place:          obs.place_guess || '',
				photoUrl:       photo ? photoSizeUrl(photo.url, 'medium') : '',
				photoCount:     obs.photos ? obs.photos.length : 0,
				qualityGrade:   obs.quality_grade || ''
			};
		}

		function photoSizeUrl(url, size) {
			return url ? url.replace(/\/(square|small|medium|large|original)\./, `/${size}.`) : '';
		}

		// ── Render results ───────────────────────────────────────────────────

		function renderResults(items, total) {
			const label = total > items.length
				? `Showing ${items.length} of ${total.toLocaleString()} results`
				: `${items.length.toLocaleString()} result${items.length !== 1 ? 's' : ''}`;
			setStatus(label, '');

			const container = document.getElementById('inat-id-results');
			if (!items.length) {
				container.innerHTML = '<p class="inat-id-empty">No matching identifications found.</p>';
				return;
			}
			container.innerHTML = `<ul class="inat-id-list">${items.map(renderRow).join('')}</ul>`;
		}

		function renderRow(item) {
			const obsPhoto   = item.photoUrl;
			const taxonPhoto = item.taxonPhoto;
			const title      = item.commonName || item.scientificName || 'Unknown taxon';
			const sci        = item.scientificName || '';
			const obsDate    = item.observedOn || '';
			const addedDate  = item.createdAt ? formatDate(item.createdAt) : '';
			const taxonUrl   = item.taxonId
				? `https://www.inaturalist.org/taxa/${item.taxonId}`
				: '';
			const iconicName = (item.iconicTaxon || 'unknown').toLowerCase();
			const iconicUrl  = `https://www.inaturalist.org/assets/iconic_taxa/${iconicName}-15px.png`;

			// quality grade label + class
			const qgMap = { research: 'Research Grade', needs_id: 'Needs ID', casual: 'Casual' };
			const qgLabel = qgMap[item.qualityGrade] || '';

			// category colour key
			const catClass = `inat-cat--${escapeAttr(item.category || 'unknown')}`;

			return `
				<li class="inat-id-card${item.current ? '' : ' inat-id-card--withdrawn'}">

					<div class="inat-obs-col">
						<div class="inat-obs-body">
							<div class="inat-obs-taxon">
								<img class="inat-iconic" src="${escapeAttr(iconicUrl)}" alt="">
								<a href="${escapeAttr(item.observationUrl)}" target="_blank" rel="noopener">
									${item.commonName ? `<span class="inat-comname">${escapeHtml(item.commonName)}</span>` : ''}
									${sci && item.commonName ? `<span class="inat-othernames">(<em class="inat-sciname">${escapeHtml(sci)}</em>)</span>` : ''}
									${!item.commonName && sci ? `<em class="inat-sciname">${escapeHtml(sci)}</em>` : ''}
								</a>
							</div>
							<div class="inat-obs-attr">
								${item.observerLogin ? `<div><span class="inat-attr-label">Observer</span> <a href="https://www.inaturalist.org/observations?user_id=${escapeAttr(item.observerLogin)}" target="_blank" rel="noopener">${escapeHtml(item.observerName || item.observerLogin)}</a></div>` : ''}
								${obsDate ? `<div><span class="inat-attr-label">Date</span> ${escapeHtml(obsDate)}</div>` : ''}
								${item.place ? `<div><span class="inat-attr-label">Place</span> ${escapeHtml(item.place)}</div>` : ''}
							</div>
							<div class="inat-obs-actions">
								${qgLabel ? `<span class="inat-qg inat-qg--${escapeAttr(item.qualityGrade)}">${escapeHtml(qgLabel)}</span>` : ''}
								<a class="inat-view-link" href="${escapeAttr(item.observationUrl)}" target="_blank" rel="noopener">View &raquo;</a>
							</div>
						</div>
					</div>

					<a class="inat-obs-photo" href="${escapeAttr(item.observationUrl)}" target="_blank" rel="noopener">
						${obsPhoto
							? `<img src="${escapeAttr(obsPhoto)}" alt="" loading="lazy">`
							: `<div class="inat-obs-photo--empty"></div>`}
						${item.photoCount > 1 ? `<span class="inat-photo-count">${item.photoCount} photos &raquo;</span>` : ''}
					</a>

					<div class="inat-ident-col">
						${taxonPhoto
							? `<a class="inat-ident-photo" href="${escapeAttr(taxonUrl)}" target="_blank" rel="noopener"><img src="${escapeAttr(taxonPhoto)}" alt="" loading="lazy"></a>`
							: `<div class="inat-ident-photo inat-ident-photo--empty"></div>`}
						<div class="inat-ident-body">
							<div class="inat-ident-user-taxon">
								<span class="inat-ident-you">Your ID:</span>
								<span class="inat-ident-taxon">
									${taxonUrl ? `<a href="${escapeAttr(taxonUrl)}" target="_blank" rel="noopener">` : ''}
									${item.commonName ? `<span class="inat-comname inat-comname--display">${escapeHtml(item.commonName)}</span>` : ''}
									${sci && item.commonName ? `<span class="inat-othernames">(<em class="inat-sciname">${escapeHtml(sci)}</em>)</span>` : ''}
									${!item.commonName && sci ? `<em class="inat-sciname">${escapeHtml(sci)}</em>` : ''}
									${taxonUrl ? `</a>` : ''}
								</span>
							</div>
							<div class="inat-ident-meta">
								${addedDate ? `Added on ${escapeHtml(addedDate)}` : ''}
								<div class="inat-ident-category ${catClass}">${escapeHtml(cap(item.category))}</div>
								${!item.current ? `<div class="inat-withdrawn">Withdrawn</div>` : ''}
							</div>
						</div>
					</div>

				</li>
			`;
		}

		function formatDate(iso) {
			try {
				return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
			} catch (_) { return iso.slice(0, 10); }
		}

		function cap(str) {
			return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
		}

		// ── UI helpers ───────────────────────────────────────────────────────

		function clearAll() {
			if (searchCtrl) searchCtrl.abort();
			document.getElementById('inat-id-query').value = '';
			document.getElementById('inat-id-results').innerHTML = '';
			document.getElementById('inat-id-status').hidden = true;
			document.getElementById('inat-id-btn-clear').hidden = true;
			document.getElementById('inat-id-ac').hidden = true;
			selectedTaxon = null;
		}

		function setStatus(msg, type) {
			const el = document.getElementById('inat-id-status');
			if (!el) return;
			el.textContent = msg;
			el.className   = `inat-id-status--${type || 'info'}`;
			el.hidden      = !msg;
		}

		function escapeHtml(v) {
			const d = document.createElement('div');
			d.textContent = String(v == null ? '' : v);
			return d.innerHTML;
		}

		function escapeAttr(v) {
			return escapeHtml(v).replace(/"/g, '&quot;');
		}
	});
})();
