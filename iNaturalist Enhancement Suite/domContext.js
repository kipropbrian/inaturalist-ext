// override FileReader.readAsDataURL to include the original filename in the data URL
FileReader.prototype.readAsDataURLOriginal = FileReader.prototype.readAsDataURL;
FileReader.prototype.readAsDataURL = function(file) {
	const originalReader = this;
	if (!originalReader.onload) {
		FileReader.prototype.readAsDataURLOriginal.apply(this, arguments);
		return;
	}

	const filename = file.name;
	const reader = new FileReader();
	reader.onload = function() {
		const dataUrl = reader.result.replace(';base64,', `;name=${filename};base64,`);

		// TODO properly clone event
		originalReader.onload({ target: { result: dataUrl }});
	}

	FileReader.prototype.readAsDataURLOriginal.apply(reader, arguments);
}

// override Image.src setter to parse and store the filename from the data URL
const srcDescriptor = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
Image.prototype.originalSrcSetter = srcDescriptor.set;

const newSetter = function(value) {
	const match = value.match(/;name=([^;]+);/);
	if (match) {
		this._filename = match[1];
	}

	Image.prototype.originalSrcSetter.apply(this, arguments);
}

srcDescriptor.set = newSetter;
Object.defineProperty(Image.prototype, 'src', srcDescriptor);

// override CanvasRenderingContext2D.drawImage to propagate image filename to canvas
CanvasRenderingContext2D.prototype.drawImageOriginal = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function() {
	const image = arguments[0];
	if (image) {
		this.canvas._filename = image._filename;
	}

	CanvasRenderingContext2D.prototype.drawImageOriginal.apply(this, arguments);
};


// override HTMLCanvasElement.toBlob to create file with filename
HTMLCanvasElement.prototype.toBlobOriginal = HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob = function() {
	const filename = this._filename;
	const originalCallback = arguments[0];
	arguments[0] = function(blob) {
		originalCallback(new File([blob], filename));
	}

	HTMLCanvasElement.prototype.toBlobOriginal.apply(this, arguments);
};

// Once iNat's I18n global has loaded with the page's translations, broadcast
// the locale-dependent values our isolated-world content scripts need (they
// can't see window.I18n from their own world). i18n-js v3 ships translations
// via inline <script> tags rendered by Rails, so they're synchronously
// available by DOMContentLoaded. The detail dict is the natural place to add
// more I18n keys if other features need them later.
function inatExtBroadcastI18n() {
	let timeHours = '';
	try {
		if (window.I18n && typeof window.I18n.t === 'function') {
			timeHours = window.I18n.t('momentjs.time_hours') || '';
		}
	} catch (e) {
		// I18n not loaded; leave timeHours empty
	}
	document.dispatchEvent(new CustomEvent('inatExtI18n', {
		detail: { timeHours }
	}));
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', inatExtBroadcastI18n, { once: true });
} else {
	inatExtBroadcastI18n();
}

// Get the iNaturalist API token from the page
function getApiToken() {
	const metaToken = document.querySelector('meta[name="inaturalist-api-token"]');
	if (metaToken && metaToken.content) {
		console.log('[iNat Enhancement Suite] Found API token in meta tag');
		return metaToken.content;
	}

	console.log('[iNat Enhancement Suite] No API token found - user may not be logged in');
	return null;
}

// Listen for score_image requests from content script
document.addEventListener('scoreImageRequest', async (event) => {
	const { imageDataUrl, metadata, requestId } = event.detail;

	try {
		const apiToken = getApiToken();
		if (!apiToken) {
			throw new Error('Not logged in - please log in to iNaturalist to use CV suggestions');
		}

		// Convert data URL to blob
		const response = await fetch(imageDataUrl);
		const blob = await response.blob();

		const formData = new FormData();
		formData.append('image', blob, 'cropped.jpg');
		formData.append('include_representative_photos', 'true');

		if (metadata.lat && metadata.lng) {
			formData.append('lat', metadata.lat);
			formData.append('lng', metadata.lng);
		}
		if (metadata.observed_on) {
			formData.append('observed_on', metadata.observed_on);
		}

		const apiResponse = await fetch('https://api.inaturalist.org/v1/computervision/score_image', {
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Authorization': apiToken,
				'X-Via': 'iNaturalist-Enhancement-Suite'
			},
			body: formData
		});

		if (!apiResponse.ok) {
			throw new Error(`API error: ${apiResponse.status}`);
		}

		const data = await apiResponse.json();

		document.dispatchEvent(new CustomEvent('scoreImageResponse', {
			detail: { requestId, success: true, data }
		}));
	} catch (error) {
		document.dispatchEvent(new CustomEvent('scoreImageResponse', {
			detail: { requestId, success: false, error: error.message }
		}));
	}
});

let currentInterceptedSpeciesGuess = null;

// Taxon suggestions arrive from several extension features with different API
// field sets. Normalize them once here before handing them to iNaturalist.
const autocompleteTaxonPromises = new Map();

async function hydrateTaxonForAutocomplete(taxon) {
	if (!taxon?.id) throw new Error('Taxon selection is missing an ID');

	const cacheKey = String(taxon.id);
	const cached = autocompleteTaxonPromises.get(cacheKey);
	if (cached) return cached;

	const promise = (async () => {
		// A complete photo object is enough for iNatModels.Taxon#photoTag. Score
		// and Similar Species usually already provide this, avoiding a request.
		if (taxon.default_photo?.square_url) return taxon;

		const response = await fetch(`https://api.inaturalist.org/v1/taxa/${encodeURIComponent(taxon.id)}`);
		if (!response.ok) {
			throw new Error(`Could not load taxon ${taxon.id} (HTTP ${response.status})`);
		}
		const data = await response.json();
		const fullTaxon = data?.results?.[0];
		if (!fullTaxon?.id) throw new Error(`Taxon ${taxon.id} was not found`);

		// Retain any feature-specific fields while allowing canonical API fields
		// such as default_photo, names, rank, and ancestors to win.
		return { ...taxon, ...fullTaxon };
	})().catch(error => {
		autocompleteTaxonPromises.delete(cacheKey);
		console.warn('[iNat Enhancement] Using incomplete taxon after hydration failed:', error);
		return taxon;
	});

	autocompleteTaxonPromises.set(cacheKey, promise);
	return promise;
}

// Listen for taxon selection requests from content script
document.addEventListener('selectTaxonRequest', async (event) => {
	const { taxon, requestId, isIdentifyPage } = event.detail;

	try {
		const focused = document.activeElement;
		if (focused && focused.closest('[aria-hidden="true"]')) {
			focused.blur();
		}

		let input = document.querySelector('[data-inat-target-input="true"]');
		if (input) {
			input.removeAttribute('data-inat-target-input');
		} else {
			input = findIdentificationInput(isIdentifyPage);
			if (!input) {
				if (isIdentifyPage) {
					await activateIdentifyInfoTab();
					const addIdButton = findVisibleAddIdButton() || await waitForAddIdButton(1500);
					if (!addIdButton) throw new Error('Could not find the active Add ID button');
					addIdButton.click();
					input = await waitForIdentificationInput(true, 4000);
				} else {
					input = await waitForIdentificationInput(false, 3000);
				}
			}
		}

		if (!input) throw new Error('Could not find the active identification input');
		const container = input.closest('.TaxonAutocomplete') || input.parentElement;
		const hydratedTaxon = await hydrateTaxonForAutocomplete(taxon);
		performAutocomplete(input, container, hydratedTaxon, requestId);

	} catch (error) {
		console.error('[iNat Enhancement] selectTaxon error:', error);
		document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
			detail: { requestId, success: false, error: error.message }
		}));
	}
});

async function activateIdentifyInfoTab() {
	const modal = findVisibleElement('.ObservationModal');
	if (!modal) throw new Error('Could not find the active observation dialog');
	if (modal.querySelector('.info-tab.active')) return;

	// Info is the first tab in iNaturalist's ObservationModal. Clicking its
	// native control keeps the React tab state synchronized.
	const infoTabButton = modal.querySelector('.inat-tabs > li:first-child > button');
	if (!infoTabButton || !isVisibleElement(infoTabButton)) {
		throw new Error('Could not find the Info tab');
	}

	infoTabButton.click();
	await waitForVisibleElement('.ObservationModal .info-tab.active', 3000, 'Info tab did not become active');
}

function findIdentificationInput(isIdentifyPage) {
	const selector = isIdentifyPage
		? '.ObservationModal .IdentificationForm:not(.collapse) input[name="taxon_name"]'
		: '.TaxonAutocomplete input[name="taxon_name"], .TaxonAutocomplete input[type="search"]';
	return findVisibleElement(selector);
}

function findVisibleAddIdButton() {
	return Array.from(document.querySelectorAll('.ObservationModal .info-tab.active .tools button'))
		.find(button => (
			button.querySelector('i.icon-identification')
			&& isVisibleElement(button)
		)) || null;
}

function waitForIdentificationInput(isIdentifyPage, timeoutMs) {
	return new Promise((resolve, reject) => {
		const existing = findIdentificationInput(isIdentifyPage);
		if (existing) return resolve(existing);

		const observer = new MutationObserver(() => {
			const input = findIdentificationInput(isIdentifyPage);
			if (!input) return;
			observer.disconnect();
			clearTimeout(timeout);
			resolve(input);
		});
		const timeout = setTimeout(() => {
			observer.disconnect();
			reject(new Error('Could not find autocomplete input after opening identification form'));
		}, timeoutMs);
		observer.observe(document.body, { childList: true, subtree: true, attributes: true });
	});
}

function waitForAddIdButton(timeoutMs) {
	return new Promise(resolve => {
		const existing = findVisibleAddIdButton();
		if (existing) return resolve(existing);

		const observer = new MutationObserver(() => {
			const button = findVisibleAddIdButton();
			if (!button) return;
			observer.disconnect();
			clearTimeout(timeout);
			resolve(button);
		});
		const timeout = setTimeout(() => {
			observer.disconnect();
			resolve(null);
		}, timeoutMs);
		observer.observe(document.body, { childList: true, subtree: true, attributes: true });
	});
}

function waitForVisibleElement(selector, timeoutMs, errorMessage) {
	return new Promise((resolve, reject) => {
		const existing = findVisibleElement(selector);
		if (existing) return resolve(existing);

		const observer = new MutationObserver(() => {
			const element = findVisibleElement(selector);
			if (!element) return;
			observer.disconnect();
			clearTimeout(timeout);
			resolve(element);
		});
		const timeout = setTimeout(() => {
			observer.disconnect();
			reject(new Error(errorMessage));
		}, timeoutMs);
		observer.observe(document.body, { childList: true, subtree: true, attributes: true });
	});
}

function findVisibleElement(selector) {
	return Array.from(document.querySelectorAll(selector)).find(isVisibleElement) || null;
}

function isVisibleElement(element) {
	if (element.closest('[aria-hidden="true"]') && !element.closest('.ObservationModal.in')) return false;
	const style = window.getComputedStyle(element);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	return element.getClientRects().length > 0;
}

// Extracted autocomplete logic for reuse
function performAutocomplete(input, container, taxon, requestId) {
	try {
		if (typeof window.$ !== 'function') {
			throw new Error('iNaturalist autocomplete is not ready yet');
		}
		if (typeof window.iNatModels?.Taxon !== 'function') {
			throw new Error('iNaturalist taxon model is not ready yet');
		}
		const $input = $(input);
		const selectedTaxon = taxon instanceof window.iNatModels.Taxon
			? taxon
			: new window.iNatModels.Taxon(taxon);

		// Native autocomplete converts API results to iNatModels.Taxon before
		// assignment. Besides storing the selection, that model supplies
		// photoTag(), which renders the selected taxon's thumbnail.
		$input.trigger('assignSelection', [selectedTaxon]);

		const selected = $input.data('autocomplete-item');
		if (!selected || Number(selected.id) !== Number(selectedTaxon.id)) {
			throw new Error(`Taxon selection could not be verified for ID ${selectedTaxon.id}`);
		}

		closeAutocompleteMenu($input, container);
		input.blur();
		container.scrollIntoView({ behavior: 'smooth', block: 'center' });
		document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
			detail: { requestId, success: true, taxonId: selected.id }
		}));

	} catch (error) {
		console.error('[iNat Enhancement] selectTaxon error:', error);
		document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
			detail: { requestId, success: false, error: error.message }
		}));
	}
}

function closeAutocompleteMenu($input, container) {
	try {
		const autocomplete = $input.data('uiAutocomplete') || $input.data('autocomplete');
		if (autocomplete) {
			if (typeof $input.autocomplete === 'function') {
				$input.autocomplete('close');
			}
			if (autocomplete.menu?.element) {
				autocomplete.menu.element.empty().hide();
			}
			autocomplete.term = $input.val();
			autocomplete.pending = 0;
		}
		$(container)
			.find('.ui-autocomplete, .taxon-autocomplete, .ac-menu')
			.empty()
			.hide();
		$('.ui-autocomplete:visible, .taxon-autocomplete:visible, .ac-menu:visible')
			.filter((_, el) => !$(el).closest('.modal.in, .ObservationModal.in').length)
			.hide();
	} catch (error) {
		console.warn('[iNat Enhancement] Could not close autocomplete menu:', error);
	}
}

function closeAllTaxonAutocompleteMenus() {
	document.querySelectorAll('.ui-autocomplete.taxon-autocomplete, .taxon-autocomplete, .ac-menu')
		.forEach(menu => {
			menu.classList.remove('open');
			menu.style.display = 'none';
		});
}

function scheduleTaxonAutocompleteCleanup() {
	[25, 125, 275].forEach(delay => setTimeout(closeAllTaxonAutocompleteMenus, delay));
}

document.addEventListener('click', event => {
	if (!event.target.closest('.ui-autocomplete .ui-menu-item, .ui-autocomplete .ac-result, .taxon-autocomplete .ui-menu-item, .taxon-autocomplete .ac-result')) return;
	scheduleTaxonAutocompleteCleanup();
}, true);

document.addEventListener('click', event => {
	if (!event.target.closest('.ObservationModal .close-button, .ObservationModal button.close, .modal-backdrop')) return;
	scheduleTaxonAutocompleteCleanup();
}, true);

document.addEventListener('hidden.bs.modal', scheduleTaxonAutocompleteCleanup, true);

const oldFetch = window.fetch;
window.fetch = async (url, options) => {
	const response = await oldFetch(url, options);
	const requestUrl = typeof url === 'string' ? url : url && url.url;
	try {
		if (!requestUrl || !response.ok) return response;

		if (requestUrl.match(/^https:\/\/api\.inaturalist\.org\/v\d+\/computervision/i)) {
			const data = await readJsonResponse(response);
			if (data) {
				let filename = null;
				if (options) {
					const formData = options.body;
					if (formData) {
						const file = formData.get('image');
						if (file) {
							filename = file.name;
						}
					}
				}

				const payload = {
					detail: {
						data,
						filename
					}
				};

				document.dispatchEvent(
					new CustomEvent('computerVisionResponse', payload)
				);
			}
		} else {
			// Match both v1 numeric ids (e.g. /v1/observations/12345) and v2
			// UUIDs (e.g. /v2/observations/de2a3f5c-2f45-46a5-925f-241ed6b945d3).
			const observationMatch = requestUrl.match(/^https:\/\/api\.inaturalist\.org\/v\d+\/observations\/[\w-]+/i);
			if (observationMatch) {
				const data = await readJsonResponse(response);
				if (data && data.results && data.results.length && data.results[0]) {
					const obs = data.results[0];
					currentInterceptedSpeciesGuess = (!obs.taxon) ? (obs.species_guess || null) : null;
					const payload = {
						detail: {
							location: obs.location,
							observation: obs
						}
					};

					document.dispatchEvent(
						new CustomEvent('observationFetch', payload)
					);
				}
			}
		}
	} catch (err) {
		console.debug('[iNat Enhancement] Skipped fetch response interception:', err);
	}

	return response;
};

async function readJsonResponse(response) {
	const contentType = response.headers.get('content-type') || '';
	if (!contentType.includes('application/json')) return null;

	const text = await response.clone().text();
	if (!text.trim()) return null;

	return JSON.parse(text);
}

function setReactTextareaValue(textarea, value) {
	// React controls the textarea via a synthetic `value` prop that overwrites
	// whatever we write to textarea.value. We must go through React's own
	// event pipeline to update its internal state.
	//
	// Step 1: Use the native HTMLTextAreaElement value setter (bypasses React's
	//         override) to set the raw DOM value.
	const nativeSetter = Object.getOwnPropertyDescriptor(
		window.HTMLTextAreaElement.prototype, 'value'
	).set;
	nativeSetter.call(textarea, value);

	// Step 2: Fire a React-compatible 'change' event.
	//         This triggers TextEditor.textareaOnChange → setState({ content })
	//         which keeps React's internal state in sync.
	textarea.dispatchEvent(new Event('change', { bubbles: true }));

	// Step 3: Fire a blur event after a short delay.
	//         IdentificationForm's onBlur handler calls
	//         updateEditorContent("obsIdentifyIdComment", e.target.value)
	//         which persists the value into the Redux store that the form
	//         reads when the user clicks Save.
	setTimeout(() => {
		textarea.dispatchEvent(new Event('blur', { bubbles: true }));
	}, 80);
}

function setupAssignSelectionListener() {
	if (typeof window.$ === 'function') {
		$(document).on('assignSelection', 'input[name="taxon_name"], input[type="search"]', function(e, selectedTaxon) {
			if (!selectedTaxon) return;
			const input = this;
			const form = input.closest('form');
			if (form && currentInterceptedSpeciesGuess) {
				const textarea = form.querySelector('textarea');
				if (textarea && !textarea.value.trim()) {
					setReactTextareaValue(textarea, `Placeholder: ${currentInterceptedSpeciesGuess}`);
				}
			}
		});
	} else {
		setTimeout(setupAssignSelectionListener, 100);
	}
}
setupAssignSelectionListener();
