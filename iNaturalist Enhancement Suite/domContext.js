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

// On Identify, defer native modal photo downloads until the gallery marks a
// slide active. iNaturalist creates the gallery images before their classes are
// committed, so a later isolated-world MutationObserver is too late to prevent
// the browser from starting inactive large-image requests.
const IDENTIFY_EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const IDENTIFY_ORIGINAL_SRC_KEY = 'inatFastOriginalSrc';
const IDENTIFY_ORIGINAL_SRCSET_KEY = 'inatFastOriginalSrcset';
let identifyNavigationPending = false;
let identifyNavigationTimer = null;
const identifyPhotoSourcePattern = /(?:^|\/)photos\/\d+\/(?:square|small|medium|large|original)\.[^/?#]+(?:[?#].*)?$/i;

function isIdentifyPhotoSource(value) {
	return typeof value === 'string' && identifyPhotoSourcePattern.test(value);
}

function rememberIdentifyPhotoSource(image, attribute, value) {
	if (!isIdentifyPhotoSource(value)) return;
	if (attribute === 'src') image.dataset[IDENTIFY_ORIGINAL_SRC_KEY] = value;
	if (attribute === 'srcset') image.dataset[IDENTIFY_ORIGINAL_SRCSET_KEY] = value;
}

function shouldDeferIdentifyPhoto(image, value) {
	if (window.location.pathname !== '/observations/identify' || !isIdentifyPhotoSource(value)) return false;
	// These are UI thumbnails, not gallery slides. They must remain visible when
	// a reviewer selects a quick ID or when an identification is rendered.
	if (image.matches?.('.taxon-image, .inat-quick-add-thumb')
		|| image.closest?.('.inat-quick-add-thumb-wrap')) return false;
	// The native gallery's square thumbnails are the lightweight visual index for
	// the popup. Keep them available so reviewers can see the image count without
	// downloading the inactive large gallery sources.
	if (image.closest?.('.image-gallery-thumbnail')) return false;
	const modal = image.closest?.('.ObservationModal');
	// React assigns src while a new image is detached. Treat matching photo
	// sources as deferred candidates until the gallery can identify the active
	// slide after insertion.
	if (!modal) return !image.isConnected;
	const slide = image.closest('.image-gallery-slide');
	const isActive = slide?.classList.contains('center')
		|| slide?.getAttribute('aria-hidden') === 'false';
	return identifyNavigationPending || !isActive;
}

function markIdentifyNavigationPending() {
	if (window.location.pathname !== '/observations/identify') return;
	identifyNavigationPending = true;
	clearTimeout(identifyNavigationTimer);
	identifyNavigationTimer = setTimeout(() => {
		identifyNavigationPending = false;
		identifyNavigationTimer = null;
	}, 5000);
}

function settleIdentifyNavigation() {
	identifyNavigationPending = false;
	clearTimeout(identifyNavigationTimer);
	identifyNavigationTimer = null;
}

// override Image.src setter to parse and store the filename from the data URL
const srcDescriptor = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
Image.prototype.originalSrcSetter = srcDescriptor.set;

const newSetter = function(value) {
	if (shouldDeferIdentifyPhoto(this, value)) {
		rememberIdentifyPhotoSource(this, 'src', value);
		Image.prototype.originalSrcSetter.call(this, IDENTIFY_EMPTY_IMAGE_SRC);
		return;
	}
	const match = typeof value === 'string' ? value.match(/;name=([^;]+);/) : null;
	if (match) {
		this._filename = match[1];
	}

	Image.prototype.originalSrcSetter.apply(this, arguments);
}

srcDescriptor.set = newSetter;
Object.defineProperty(Image.prototype, 'src', srcDescriptor);

// React may use setAttribute instead of the src property depending on the
// renderer path. Keep the interception limited to photo-like modal candidates
// on the live Identify route; all other pages and image types are untouched.
const originalElementSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value) {
	const attribute = String(name).toLowerCase();
	if (this instanceof HTMLImageElement
		&& (attribute === 'src' || attribute === 'srcset')
		&& shouldDeferIdentifyPhoto(this, String(value))) {
		rememberIdentifyPhotoSource(this, attribute, String(value));
		originalElementSetAttribute.call(this, attribute, attribute === 'src' ? IDENTIFY_EMPTY_IMAGE_SRC : '');
		return;
	}
	return originalElementSetAttribute.apply(this, arguments);
};

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

let currentInterceptedObservationId = null;
let currentInterceptedSpeciesGuess = null;
let activeTaxonSelection = null;
let taxonSelectionGeneration = 0;
let currentGeneratedPlaceholder = null;
let pendingPlaceholderObserver = null;
let pendingPlaceholderTimer = null;

// Content-script fallbacks may publish an observation event when the page uses
// a cached response or a non-fetch request path. Keep the placeholder context
// synchronized with both native and fallback observation events.
document.addEventListener('observationFetch', event => {
	const observation = event.detail?.observation;
	if (!observation) return;
	const observationId = event.detail.observationId || observation.id || null;
	if (
		currentInterceptedObservationId
		&& observationId
		&& String(currentInterceptedObservationId) !== String(observationId)
	) {
		// Some cached Identify transitions skip the native nav-button click path.
		// Treat the new observation response as a lifecycle boundary so the old
		// generated placeholder cannot leak into the reused form.
		document.dispatchEvent(new CustomEvent('inatExtObservationChanging', {
			detail: { observationId }
		}));
	}
	currentInterceptedObservationId = observationId;
	currentInterceptedSpeciesGuess = observation.taxon
		? null
		: (observation.species_guess || null);
});

function getObservationIdForElement(element) {
	const modal = element?.closest?.('.ObservationModal')
		|| findVisibleElement('.ObservationModal.in, .ObservationModal');
	const href = modal?.querySelector(
		'.obs-modal-header a[href^="/observations/"], a.permalink[href^="/observations/"]'
	)?.getAttribute('href');
	const match = href?.match(/^\/observations\/([^/?#]+)/);
	return match ? match[1] : null;
}

function cancelActiveTaxonSelection() {
	if (activeTaxonSelection) activeTaxonSelection.cancelled = true;
	activeTaxonSelection = null;
	taxonSelectionGeneration += 1;
}

function markObservationChanging() {
	clearGeneratedPlaceholderComment();
	if (pendingPlaceholderObserver) pendingPlaceholderObserver.disconnect();
	clearTimeout(pendingPlaceholderTimer);
	pendingPlaceholderObserver = null;
	pendingPlaceholderTimer = null;
	cancelActiveTaxonSelection();
	markIdentifyNavigationPending();
	currentInterceptedObservationId = null;
	currentInterceptedSpeciesGuess = null;
	if (document.documentElement) delete document.documentElement.dataset.inatExtDraftTaxon;
	document.dispatchEvent(new CustomEvent('inatExtObservationChanging'));
}

function isCurrentTaxonSelection(selection) {
	if (!selection || selection.cancelled || activeTaxonSelection !== selection) return false;
	if (selection.generation !== taxonSelectionGeneration || !selection.input?.isConnected) return false;
	if (selection.input.closest('.ObservationModal') !== selection.modal) return false;
	return getObservationIdForElement(selection.input) === selection.observationId;
}

// Next/Previous and modal close can replace the form before taxon hydration
// finishes. Cancel page-world work at the start of that transition so a late
// selection cannot be assigned to the next observation's reused form.
document.addEventListener('click', event => {
	if (!event.target.closest?.('.ObservationModal .nav-buttons .nav-button')) return;
	markObservationChanging();
}, true);

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
	const selection = {
		requestId,
		generation: ++taxonSelectionGeneration,
		input: null,
		modal: null,
		observationId: null,
		cancelled: false
	};
	activeTaxonSelection = selection;

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
		selection.input = input;
		selection.modal = input.closest('.ObservationModal');
		selection.observationId = getObservationIdForElement(input);
		selection.speciesGuess = selection.observationId
			&& String(selection.observationId) === String(currentInterceptedObservationId)
			? currentInterceptedSpeciesGuess
			: null;
		const container = input.closest('.TaxonAutocomplete') || input.parentElement;
		const hydratedTaxon = await hydrateTaxonForAutocomplete(taxon);
		if (!isCurrentTaxonSelection(selection)) {
			document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
				detail: { requestId, success: false, cancelled: true, error: 'Observation changed before taxon selection completed' }
			}));
			return;
		}
		performAutocomplete(input, container, hydratedTaxon, requestId, selection);

	} catch (error) {
		if (!isCurrentTaxonSelection(selection)) {
			document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
				detail: { requestId, success: false, cancelled: true, error: 'Observation changed before taxon selection completed' }
			}));
			return;
		}
		console.error('[iNat Enhancement] selectTaxon error:', error);
		document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
			detail: { requestId, success: false, error: error.message }
		}));
	} finally {
		if (activeTaxonSelection === selection) activeTaxonSelection = null;
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

		const target = document.querySelector('.ObservationModal') || document.body;
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
		observer.observe(target, { childList: true, subtree: true });
	});
}

function waitForAddIdButton(timeoutMs) {
	return new Promise(resolve => {
		const existing = findVisibleAddIdButton();
		if (existing) return resolve(existing);

		const target = document.querySelector('.ObservationModal') || document.body;
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
		observer.observe(target, { childList: true, subtree: true });
	});
}

function waitForVisibleElement(selector, timeoutMs, errorMessage) {
	return new Promise((resolve, reject) => {
		const existing = findVisibleElement(selector);
		if (existing) return resolve(existing);

		const target = document.querySelector('.ObservationModal') || document.body;
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
		observer.observe(target, { childList: true, subtree: true });
	});
}

function findVisibleElement(selector) {
	return Array.from(document.querySelectorAll(selector)).find(isVisibleElement) || null;
}

function isVisibleElement(element) {
	if (!element) return false;
	if (element.closest('[aria-hidden="true"]') && !element.closest('.ObservationModal.in')) return false;
	if (element.offsetParent === null && element.tagName !== 'BODY') {
		if (window.getComputedStyle(element).position !== 'fixed') return false;
	}
	const style = window.getComputedStyle(element);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	return element.getClientRects().length > 0;
}

function findCommentTextarea(input) {
	const form = input?.closest?.('.IdentificationForm') || input?.closest?.('form');
	return form?.querySelector('textarea[placeholder="Tell us why..."], textarea') || null;
}

function findCurrentIdentificationInput(observationId, fallbackInput) {
	const candidates = [];
	if (fallbackInput?.isConnected) candidates.push(fallbackInput);
	const activeInput = findIdentificationInput(true);
	if (activeInput && !candidates.includes(activeInput)) candidates.push(activeInput);
	return candidates.find(input => {
		const currentObservationId = getObservationIdForElement(input);
		return currentObservationId && String(currentObservationId) === String(observationId);
	}) || null;
}

function setPlaceholderComment(input, observationId, speciesGuess) {
	if (!observationId || !speciesGuess) return false;
	const currentInput = findCurrentIdentificationInput(observationId, input);
	if (!currentInput) return false;

	const textarea = findCommentTextarea(currentInput);
	if (!textarea) return false;

	const value = `Placeholder: ${speciesGuess}`;
	const currentValue = textarea.value.trim();
	const previousGeneratedValue = currentGeneratedPlaceholder?.value;
	// Preserve a real comment, but replace an empty or extension-generated value
	// left in iNaturalist's shared editor when the modal changes observations.
	if (currentValue && currentValue !== previousGeneratedValue && !currentValue.startsWith('Placeholder: ')) {
		return true;
	}

	if (currentValue !== value) setReactTextareaValue(textarea, value);
	currentGeneratedPlaceholder = { observationId: String(observationId), value };
	return true;
}

function queuePlaceholderComment(input, observationId, speciesGuess) {
	if (!observationId || !speciesGuess) return;
	if (setPlaceholderComment(input, observationId, speciesGuess)) return;

	if (pendingPlaceholderObserver) pendingPlaceholderObserver.disconnect();
	clearTimeout(pendingPlaceholderTimer);
	const modal = input?.closest?.('.ObservationModal') || findVisibleElement('.ObservationModal');
	const target = modal || document.body;
	if (!target) return;

	const attempt = () => {
		if (setPlaceholderComment(input, observationId, speciesGuess)) {
			pendingPlaceholderObserver?.disconnect();
			clearTimeout(pendingPlaceholderTimer);
			pendingPlaceholderObserver = null;
			pendingPlaceholderTimer = null;
		}
	};
	pendingPlaceholderObserver = new MutationObserver(attempt);
	pendingPlaceholderObserver.observe(target, { childList: true, subtree: true });
	pendingPlaceholderTimer = setTimeout(() => {
		pendingPlaceholderObserver?.disconnect();
		pendingPlaceholderObserver = null;
		pendingPlaceholderTimer = null;
	}, 2500);
}

function clearGeneratedPlaceholderComment() {
	const activeInput = findVisibleElement('.ObservationModal .IdentificationForm input[name="taxon_name"]');
	const textarea = findCommentTextarea(activeInput)
		|| document.querySelector('.ObservationModal .IdentificationForm textarea[placeholder="Tell us why..."], .ObservationModal .IdentificationForm textarea');
	if (!textarea) {
		currentGeneratedPlaceholder = null;
		return;
	}
	const currentValue = textarea.value.trim();
	if (currentValue && (currentValue === currentGeneratedPlaceholder?.value || currentValue.startsWith('Placeholder: '))) {
		setReactTextareaValue(textarea, '');
	}
	currentGeneratedPlaceholder = null;
}

// Extracted autocomplete logic for reuse
function performAutocomplete(input, container, taxon, requestId, selection) {
	try {
		if (selection && !isCurrentTaxonSelection(selection)) {
			document.dispatchEvent(new CustomEvent('selectTaxonResponse', {
				detail: { requestId, success: false, cancelled: true, error: 'Observation changed before taxon selection completed' }
			}));
			return;
		}
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
		// Programmatic Quick ID/Similar Species selections must preserve the
		// unknown observation's species guess in the comment field too.
		queuePlaceholderComment(input, selection?.observationId, selection?.speciesGuess);

		const selected = $input.data('autocomplete-item');
		if (!selected || Number(selected.id) !== Number(selectedTaxon.id)) {
			throw new Error(`Taxon selection could not be verified for ID ${selectedTaxon.id}`);
		}

		closeAutocompleteMenu($input, container);
		input.blur();
		container.scrollIntoView({ block: 'center' });
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
	if (typeof window.$ === 'function') {
		$('.ObservationModal .TaxonAutocomplete input[name="taxon_name"], .ObservationModal .TaxonAutocomplete input[type="search"]').each((_, input) => {
			const $input = $(input);
			const autocomplete = $input.data('uiAutocomplete') || $input.data('autocomplete');
			if (autocomplete && typeof $input.autocomplete === 'function') {
				$input.autocomplete('close');
			}
			if (autocomplete?.menu?.element) {
				autocomplete.menu.element.empty().hide();
			}
		});
	}
	document.querySelectorAll('.ObservationModal .TaxonAutocomplete > ul, .ObservationModal .ui-autocomplete, .ObservationModal .taxon-autocomplete, .ObservationModal .ac-menu')
		.forEach(menu => {
			menu.classList.remove('open');
			menu.replaceChildren();
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

// Blur focus when switching modal tabs to prevent aria-hidden focus blocking reflow warnings
document.addEventListener('click', event => {
	const tabBtn = event.target.closest('.ObservationModal .inat-tabs button, .ObservationModal .inat-tabs a, .ObservationModal .nav-tabs button, .ObservationModal .nav-tabs a');
	if (!tabBtn) return;
	const focused = document.activeElement;
	if (focused && focused !== document.body && typeof focused.blur === 'function') {
		focused.blur();
	}
}, true);

document.addEventListener('hidden.bs.modal', scheduleTaxonAutocompleteCleanup, true);
document.addEventListener('hidden.bs.modal', event => {
	if (event.target.closest?.('.ObservationModal')) markObservationChanging();
}, true);

// The Photos tab lives in an isolated extension world. Let it close an open
// native autocomplete menu before hiding the identification form, and let it
// re-read the selected taxon when it opens in case a selection event was missed.
document.addEventListener('inatExtCloseTaxonAutocomplete', () => {
	closeAllTaxonAutocompleteMenus();
	scheduleTaxonAutocompleteCleanup();
});

function broadcastDraftTaxon(taxon) {
	if (!taxon?.id) return;

	const draftTaxon = typeof taxon.toJSON === 'function'
		? taxon.toJSON()
		: taxon;
	try {
		if (document.documentElement) {
			document.documentElement.dataset.inatExtDraftTaxon = JSON.stringify(draftTaxon);
		}
	} catch (error) {
		console.debug('[iNat Enhancement] Could not persist draft taxon:', error);
	}
	document.dispatchEvent(new CustomEvent('inatExtDraftTaxonSelected', {
		detail: { taxon: draftTaxon }
	}));
}

document.addEventListener('inatExtRequestDraftTaxon', () => {
	if (typeof window.$ !== 'function') return;
	const input = document.querySelector('.ObservationModal .IdentificationForm input[name="taxon_name"], .ObservationModal .IdentificationForm input[type="search"]');
	if (!input) return;
	const selectedTaxon = $(input).data('autocomplete-item') || input.selection;
	broadcastDraftTaxon(selectedTaxon);
});

const oldFetch = window.fetch;
window.fetch = (url, options) => {
	const requestUrl = typeof url === 'string' ? url : url && url.url;
	const inspectableRequest = requestUrl && /^https:\/\/api\.inaturalist\.org\/v\d+\/(?:observations\/|computervision)/i.test(requestUrl);
	const fetchPromise = oldFetch.call(window, url, options);
	if (inspectableRequest) {
		// Return the page's original promise immediately. Extension inspection is
		// deliberately a side effect so React does not wait for clone/text/JSON work.
		const inspect = response => {
			if (!response.ok) return;
			inspectFetchResponse(response, requestUrl, options).catch(err => {
				console.debug('[iNat Enhancement] Skipped fetch response interception:', err);
			});
		};
		fetchPromise.then(response => {
			// Clone before the page's own continuation consumes the native response.
			// Waiting until the setTimeout below to clone races React's JSON reader and
			// silently prevents observationFetch, including placeholder propagation.
			let inspectionResponse;
			try {
				inspectionResponse = response.clone();
			} catch (error) {
				console.debug('[iNat Enhancement] Could not clone fetch response for inspection:', error);
				return;
			}
			if (window.location.pathname === '/observations/identify') {
				// Let the native fetch continuation update the modal before extension
				// clone/text/JSON work competes for the main thread.
				setTimeout(() => inspect(inspectionResponse), 0);
			} else {
				inspect(inspectionResponse);
			}
		}, () => {
			// Preserve the page's native rejection; there is nothing to inspect.
		});
	}
	return fetchPromise;
};

async function inspectFetchResponse(response, requestUrl, options) {
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
				const requestedObservationId = observationMatch[0].split('/').pop();
				const currentObservationId = getObservationIdForElement(null);
				// Avoid cloning/parsing a response that is already stale before doing
				// any extension work. Retain the post-parse check for races during IO.
				if (currentObservationId && String(currentObservationId) !== String(requestedObservationId)) return;
				const data = await readJsonResponse(response);
				if (data && data.results && data.results.length && data.results[0]) {
					const obs = data.results[0];
					const observationId = obs.id || requestedObservationId;
					const latestObservationId = getObservationIdForElement(null);
					if (latestObservationId && String(latestObservationId) !== String(observationId)) return;
					settleIdentifyNavigation();
					currentInterceptedObservationId = observationId;
					currentInterceptedSpeciesGuess = (!obs.taxon) ? (obs.species_guess || null) : null;
					const payload = {
						detail: {
							location: obs.location,
							observation: obs,
							observationId
						}
					};

					document.dispatchEvent(
						new CustomEvent('observationFetch', payload)
					);
				}
			}
		}
	}

async function readJsonResponse(response) {
	const contentType = response.headers.get('content-type') || '';
	if (!contentType.includes('application/json')) return null;

	const text = await response.text();
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

	// Step 2: Fire React-compatible input/change events.
	//         The input event updates the controlled editor state; change keeps
	//         older iNat editor paths covered.
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	textarea.dispatchEvent(new Event('change', { bubbles: true }));

	// Step 3: Fire blur immediately while this observation's form is still
	// mounted. IdentificationForm's onBlur handler calls
	//         updateEditorContent("obsIdentifyIdComment", e.target.value)
	//         which persists the value into the Redux store that the form
	//         reads when the user clicks Save. Delaying this across Next lets
	//         the old form write into the next observation's shared editor.
	textarea.dispatchEvent(new Event('blur', { bubbles: true }));
}

function setupAssignSelectionListener() {
	if (typeof window.$ === 'function') {
		$(document).on('assignSelection autocompleteselect', 'input[name="taxon_name"], input[type="search"]', function(e, selectedTaxon, ui) {
			const input = this;
			const identificationForm = input.closest('.IdentificationForm');
			// assignSelection supplies the Taxon model directly, while the native
			// jQuery UI picker supplies it as ui.item. Support both paths.
			const selectedCandidate = selectedTaxon?.item || ui?.item || selectedTaxon;
			let draftTaxon = selectedCandidate && typeof selectedCandidate.toJSON === 'function'
				? selectedCandidate.toJSON()
				: selectedCandidate;
			if (!draftTaxon?.id) {
				const storedSelection = $(input).data('autocomplete-item') || input.selection;
				draftTaxon = storedSelection && typeof storedSelection.toJSON === 'function'
					? storedSelection.toJSON()
					: storedSelection;
			}
			if (identificationForm) {
				// The observation itself is unchanged until Save is clicked. Broadcast
				// the draft selection so isolated-world features can react immediately.
				broadcastDraftTaxon(draftTaxon);
			}
			const observationId = getObservationIdForElement(input);
			const speciesGuess = observationId
				&& String(observationId) === String(currentInterceptedObservationId)
				? currentInterceptedSpeciesGuess
				: null;
			queuePlaceholderComment(input, observationId, speciesGuess);
		});
	} else {
		setTimeout(setupAssignSelectionListener, 100);
	}
}
setupAssignSelectionListener();
