(function() {
    'use strict';

    const STORAGE_KEY = 'iNatCropDatasetRecords';
    const COLLECTOR_TOKEN_KEY = 'iNatCropCollectorToken';
    const state = {
        records: [],
        jobs: [],
        selectedId: null,
        collectorChecking: false,
        statusFilter: 'pending',
        sortOrder: 'newest',
        searchQuery: ''
    };
    const $ = (id) => document.getElementById(id);
    const MODEL_COLORS = ['#67c5ff', '#ff91c8', '#b89cff', '#ffad66', '#73d6a2', '#ffe066'];
    const CHART_COLORS = ['#74ac00', '#357f65', '#d49a24', '#7b6ec8', '#d3655b', '#4c91c7', '#a7659e', '#7d8a67'];

    function chromeCall(area, method, arg) {
        return new Promise((resolve, reject) => {
            area[method](arg, (result) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result);
            });
        });
    }

    function runtimeMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, result => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result || {});
            });
        });
    }

    const fallbackStore = {
        async list() {
            const result = await chromeCall(chrome.storage.local, 'get', STORAGE_KEY);
            return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
        },
        async save(record) {
            const records = await this.list();
            const id = record.annotation_id || record.id;
            const index = records.findIndex((item) => (item.annotation_id || item.id) === id);
            if (index >= 0) records[index] = record; else records.push(record);
            await chromeCall(chrome.storage.local, 'set', { [STORAGE_KEY]: records });
            return record;
        },
        async import(records) {
            await chromeCall(chrome.storage.local, 'set', { [STORAGE_KEY]: records });
        }
    };

    function storage() {
        const api = window.iNatCropDataset;
        if (!api) return fallbackStore;
        return {
            async list() {
                if (api.list) return api.list();
                if (api.getAll) return api.getAll();
                return fallbackStore.list();
            },
            async save(record) {
                if (api.save) return api.save(record);
                if (api.put) return api.put(record);
                if (api.upsert) return api.upsert(record);
                if (api.update) return api.update(record.annotation_id || record.id, record);
                return fallbackStore.save(record);
            },
            async import(records) {
                if (api.import) return api.import(records);
                if (api.importJSON) return api.importJSON({ annotations: records });
                if (api.replaceAll) return api.replaceAll(records);
                if (api.upsert) { for (const record of records) await api.upsert(record); return; }
                return fallbackStore.import(records);
            }
        };
    }

    function idOf(record) { return String(record.annotation_id || record.id || record.photo_id || ''); }
    function statusOf(record) { return record.review_status || record.status || 'pending'; }
    function boxOf(record) {
        const box = record.final_box || record.box || {};
        if ('x_center' in box) return { x: +box.x_center, y: +box.y_center, width: +box.width, height: +box.height };
        if ('xmin' in box) return { x: (+box.xmin + +box.xmax) / 2, y: (+box.ymin + +box.ymax) / 2, width: +box.xmax - +box.xmin, height: +box.ymax - +box.ymin };
        if ('x' in box && 'y' in box) return { x: +box.x, y: +box.y, width: +box.width, height: +box.height };
        return { x: .5, y: .5, width: 1, height: 1 };
    }
    function flagsOf(record) {
        const value = record.priority_flags || record.priority || [];
        return Array.isArray(value) ? value : String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
    }
    function groupOf(record) { return record.iconic_taxon || record.taxonomic_group || record.taxon_group || 'Unknown'; }
    function modelRunsOf(record) {
        if (Array.isArray(record.model_runs)) return record.model_runs;
        const legacyModel = record.selected_model || record.model_id || record.model;
        if (!legacyModel) return [];
        return [{
            model_id: legacyModel,
            model_name: legacyModel,
            model_version: record.model_version || null,
            status: record.proposed_box ? 'detected' : 'no_detection',
            box: record.proposed_box || null,
            score: record.model_score ?? null,
            class_name: record.model_label || null,
            iou_to_human: record.correction_iou ?? null
        }];
    }
    function rankedModelRuns(record) {
        return modelRunsOf(record).map((run, originalIndex) => ({ run, originalIndex })).sort((a, b) => {
            const aOverlap = Number.isFinite(a.run.iou_to_human) ? a.run.iou_to_human : -1;
            const bOverlap = Number.isFinite(b.run.iou_to_human) ? b.run.iou_to_human : -1;
            return bOverlap - aOverlap || a.originalIndex - b.originalIndex;
        }).map(({ run }) => run);
    }
    function modelSummary(record) { const count = modelRunsOf(record).length; return `${count} detector run${count === 1 ? '' : 's'}`; }
    function imageOf(record) { return record.photo_url || record.image_url || record.url || ''; }
    function taxonLabel(record) { return record.taxon_common_name || record.taxon_name || `Photo ${record.photo_id || idOf(record)}`; }

    function countsBy(getValue, records) {
        const counts = {};
        records.forEach((record) => { const key = getValue(record) || 'Unknown'; counts[key] = (counts[key] || 0) + 1; });
        return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    }
    function displayName(value) {
        return String(value || 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    }
    function compactChartEntries(entries, maximum = 7) {
        if (entries.length <= maximum) return entries;
        const kept = entries.slice(0, maximum - 1);
        kept.push(['Other', entries.slice(maximum - 1).reduce((sum, entry) => sum + entry[1], 0)]);
        return kept;
    }
    function renderDonut(id, rawEntries, emptyText, centerLabel) {
        const container = $(id);
        const entries = compactChartEntries(rawEntries.filter(([, count]) => count > 0));
        if (!entries.length) {
            const empty = document.createElement('p'); empty.className = 'empty-chart'; empty.textContent = emptyText;
            container.replaceChildren(empty); return;
        }
        const total = entries.reduce((sum, entry) => sum + entry[1], 0);
        const radius = 36, circumference = 2 * Math.PI * radius;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', entries.map(([name, count]) => `${displayName(name)} ${count}`).join(', '));
        const background = document.createElementNS(svg.namespaceURI, 'circle');
        background.setAttribute('class', 'donut-bg'); background.setAttribute('cx', '50'); background.setAttribute('cy', '50'); background.setAttribute('r', radius);
        svg.append(background);
        let offset = 0;
        entries.forEach(([name, count], index) => {
            const segmentLength = count / total * circumference;
            const circle = document.createElementNS(svg.namespaceURI, 'circle');
            circle.setAttribute('class', 'donut-segment'); circle.setAttribute('cx', '50'); circle.setAttribute('cy', '50'); circle.setAttribute('r', radius);
            circle.setAttribute('stroke', CHART_COLORS[index % CHART_COLORS.length]); circle.setAttribute('stroke-dasharray', `${segmentLength} ${circumference - segmentLength}`);
            circle.setAttribute('stroke-dashoffset', String(-offset)); circle.setAttribute('transform', 'rotate(-90 50 50)');
            const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${displayName(name)}: ${count} (${Math.round(count / total * 100)}%)`; circle.append(title);
            svg.append(circle); offset += segmentLength;
        });
        const totalText = document.createElementNS(svg.namespaceURI, 'text'); totalText.setAttribute('x', '50'); totalText.setAttribute('y', '49'); totalText.setAttribute('class', 'donut-total'); totalText.textContent = total;
        const caption = document.createElementNS(svg.namespaceURI, 'text'); caption.setAttribute('x', '50'); caption.setAttribute('y', '60'); caption.setAttribute('class', 'donut-caption'); caption.textContent = centerLabel;
        svg.append(totalText, caption);
        const legend = document.createElement('div'); legend.className = 'chart-legend';
        entries.forEach(([name, count], index) => {
            const row = document.createElement('div'); row.className = 'legend-item';
            const swatch = document.createElement('i'); swatch.className = 'legend-swatch'; swatch.style.setProperty('--chart-color', CHART_COLORS[index % CHART_COLORS.length]);
            const label = document.createElement('span'); label.className = 'legend-label'; label.textContent = displayName(name); label.title = displayName(name);
            const value = document.createElement('span'); value.className = 'legend-value'; value.textContent = `${count} · ${Math.round(count / total * 100)}%`;
            row.append(swatch, label, value); legend.append(row);
        });
        container.replaceChildren(svg, legend);
    }
    function percentile(values, proportion) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * proportion) - 1))];
    }
    function formatMilliseconds(value) {
        if (!Number.isFinite(value)) return '—';
        return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s` : `${Math.round(value)} ms`;
    }
    function benchmarkRows(records) {
        const models = new Map();
        records.forEach(record => modelRunsOf(record).forEach(run => {
            const id = run.model_id || run.model_name || 'unknown';
            if (!models.has(id)) models.set(id, { id, name: run.model_name || run.model_id || 'Unknown detector' });
        }));
        return [...models.values()].map(model => {
            const runs = records.map(record => modelRunsOf(record).find(run => (run.model_id || run.model_name || 'unknown') === model.id) || null);
            const attempted = runs.filter(Boolean).length;
            const detected = runs.filter(run => run?.status === 'detected' && run.box).length;
            const overlaps = runs.map(run => Number.isFinite(run?.iou_to_human) ? run.iou_to_human : 0);
            const durations = runs.map(run => run?.duration_ms).filter(Number.isFinite);
            return {
                ...model,
                attempted,
                detected,
                meanOverlap: records.length ? overlaps.reduce((sum, value) => sum + value, 0) / records.length : 0,
                matches50: overlaps.filter(value => value >= .5).length,
                medianMs: percentile(durations, .5),
                p90Ms: percentile(durations, .9)
            };
        }).sort((a, b) => b.meanOverlap - a.meanOverlap || b.detected - a.detected);
    }
    function renderBenchmark(records) {
        $('benchmark-sample').textContent = `${records.length} approved crop${records.length === 1 ? '' : 's'}`;
        const rows = benchmarkRows(records);
        if (!rows.length || !records.length) {
            const empty = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 8; cell.className = 'empty-table'; cell.textContent = 'Verify crops to start the detector comparison.'; empty.append(cell);
            $('benchmark-body').replaceChildren(empty); return;
        }
        $('benchmark-body').replaceChildren(...rows.map((model, index) => {
            const row = document.createElement('tr');
            const values = [
                String(index + 1), model.name, `${Math.round(model.meanOverlap * 100)}%`,
                `${model.matches50}/${records.length}`, `${model.detected}/${records.length}`,
                `${model.attempted}/${records.length}`, formatMilliseconds(model.medianMs), formatMilliseconds(model.p90Ms)
            ];
            values.forEach((value, cellIndex) => {
                const cell = document.createElement('td'); cell.textContent = value;
                if (cellIndex === 2) cell.className = 'accuracy';
                if (cellIndex === 5 && model.attempted < records.length) { cell.className = 'incomplete'; cell.title = 'Some verified crops are missing a run for this detector.'; }
                row.append(cell);
            });
            return row;
        }));
    }

    function render() {
        const verified = state.records.filter((r) => statusOf(r) === 'verified').length;
        const pending = state.records.filter((r) => statusOf(r) === 'pending').length;
        const rejected = state.records.filter((r) => statusOf(r) === 'rejected').length;
        const percent = Math.min(100, Math.round(verified / 500 * 100));
        $('verified-count').textContent = `${verified} / 500 verified`; $('progress-percent').textContent = `${percent}%`;
        $('progress-bar').style.width = `${percent}%`; $('pending-count').textContent = pending;
        $('rejected-count').textContent = rejected; $('total-count').textContent = state.records.length;
        $('pending-tab-count').textContent = pending;
        $('all-tab-count').textContent = state.records.length;
        $('verified-tab-count').textContent = verified;
        $('rejected-tab-count').textContent = rejected;
        document.querySelectorAll('.status-tabs [data-status]').forEach(button => {
            const active = button.dataset.status === state.statusFilter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        renderBenchmark(state.records.filter(record => statusOf(record) === 'verified'));
        renderDonut('taxon-chart', countsBy(groupOf, state.records), 'No taxonomic groups yet.', 'crops');
        const priorityCounts = {};
        state.records.forEach((record) => flagsOf(record).forEach((flag) => { priorityCounts[flag] = (priorityCounts[flag] || 0) + 1; }));
        renderDonut('priority-chart', Object.entries(priorityCounts).sort((a, b) => b[1] - a[1]), 'No priority flags yet.', 'tags');
        renderList();
        const selected = state.records.find((record) => idOf(record) === state.selectedId);
        if (selected) populateEditor(selected); else clearEditor();
        renderCollectorCounts();
    }

    function renderCollectorCounts() {
        const synced = state.records.filter(record => record.sync_status === 'synced').length;
        const pending = state.records.length - synced;
        const activeJob = state.jobs.find(job => job.status === 'running' || job.status === 'queued');
        const failedJobs = state.jobs.filter(job => job.status === 'failed').length;
        if (activeJob) {
            const completed = Number(activeJob.completed_models) || 0;
            $('collector-detail').textContent = `${synced} synced · saving detectors ${Math.min(4, completed + 1)}/4`;
        } else if (failedJobs) {
            $('collector-detail').textContent = `${synced} synced · ${failedJobs} background job${failedJobs === 1 ? '' : 's'} failed`;
        } else {
            $('collector-detail').textContent = `${synced} synced · ${pending} waiting`;
        }
    }

    async function refreshJobStatus() {
        const result = await runtimeMessage({ action: 'cropDatasetJobStatus' });
        if (result.success && Array.isArray(result.jobs)) state.jobs = result.jobs;
    }

    function showCollectorState(mode, title) {
        const indicator = $('collector-status');
        indicator.classList.toggle('connected', mode === 'connected');
        indicator.classList.toggle('offline', mode === 'offline');
        indicator.classList.toggle('checking', !mode);
        $('collector-state').textContent = title;
        $('retry-collector').hidden = mode !== 'offline';
    }

    async function refreshCollector({ announce = false } = {}) {
        if (state.collectorChecking) return;
        state.collectorChecking = true;
        try {
            const health = await window.iNatCropDataset.collectorHealth();
            if (!health.success) {
                showCollectorState('offline', 'Collector offline');
                if (announce) notify(`Collector is offline: ${health.error}`, true);
                return false;
            }
            showCollectorState('connected', 'Collector online');
            const result = await window.iNatCropDataset.syncAll();
            await refreshJobStatus().catch(() => {});
            state.records = await storage().list();
            render();
            if (announce || result.pending) notify(`Synchronized ${result.synced} of ${result.total} annotations.`);
            return true;
        } finally {
            state.collectorChecking = false;
        }
    }

    async function configureCollector() {
        const token = $('collector-token').value.trim();
        if (!token) { notify('Paste the collector token first.', true); return; }
        await chromeCall(chrome.storage.local, 'set', { [COLLECTOR_TOKEN_KEY]: token });
        $('sync-collector').disabled = true;
		$('sync-collector').textContent = 'Connecting…';
        $('collector-setup').hidden = true;
        const connected = await refreshCollector({ announce: true });
        $('collector-setup').hidden = Boolean(connected);
        $('sync-collector').disabled = false;
		$('sync-collector').textContent = 'Connect once';
    }

    function filteredRecords() {
        return window.iNatDatasetReview.selectRecords(state.records, {
            status: state.statusFilter,
            query: state.searchQuery,
            sort: state.sortOrder
        });
    }
    function setSelectedId(id) {
        state.selectedId = id == null ? null : String(id);
        const url = new URL(window.location.href);
        if (state.selectedId) url.hash = `annotation=${encodeURIComponent(state.selectedId)}`;
        else url.hash = '';
        history.replaceState(null, '', url);
    }
    function keepSelectionInQueue() {
        const records = filteredRecords();
        if (!records.some(record => idOf(record) === state.selectedId)) {
            setSelectedId(records.length ? idOf(records[0]) : null);
        }
        return records;
    }
    function renderList() {
        const records = filteredRecords();
        $('queue-count').textContent = `${records.length} of ${state.records.length} annotation${state.records.length === 1 ? '' : 's'}`;
        $('record-list').replaceChildren(...records.map((record) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = `record${idOf(record) === state.selectedId ? ' selected' : ''}`;
            button.dataset.annotationId = idOf(record);
            const title = document.createElement('span'); title.className = 'record-title'; title.textContent = taxonLabel(record);
            const meta = document.createElement('span'); meta.className = 'record-meta';
            const status = document.createElement('span'); status.className = `pill ${statusOf(record)}`; status.textContent = statusOf(record);
            meta.append(status, document.createTextNode(`${groupOf(record)} · ${modelSummary(record)}${flagsOf(record).length ? ` · ${flagsOf(record).join(', ')}` : ''}`));
            const identity = document.createElement('code'); identity.className = 'record-id'; identity.textContent = idOf(record);
            button.append(title, meta, identity); button.addEventListener('click', () => { setSelectedId(idOf(record)); render(); }); return button;
        }));
        if (!records.length) { const empty = document.createElement('p'); empty.className = 'record-meta'; empty.style.padding = '14px'; empty.textContent = 'No annotations match this filter.'; $('record-list').append(empty); }
        const selectedBtn = $('record-list').querySelector('.record.selected');
        if (selectedBtn) selectedBtn.scrollIntoView({ block: 'nearest' });
    }

    function clearEditor() { $('editor').classList.add('empty'); $('empty-message').hidden = false; $('editor-content').hidden = true; }
    function populateEditor(record) {
        $('editor').classList.remove('empty'); $('empty-message').hidden = true; $('editor-content').hidden = false;
        $('selected-title').textContent = taxonLabel(record);
        $('annotation-id').textContent = idOf(record);
        $('taxon-name').value = record.taxon_name || ''; $('taxon-common-name').value = record.taxon_common_name || ''; $('taxon-group').value = groupOf(record) === 'Unknown' ? '' : groupOf(record);
        $('priority-flags').value = flagsOf(record).join(', ');
        renderModelRuns(record);
        const observationId = record.observation_id; $('observation-link').href = observationId ? `https://www.inaturalist.org/observations/${observationId}` : imageOf(record);
        const url = imageOf(record);
        const img = $('preview-image');
        img.alt = taxonLabel(record);
        if (url && img.src !== url) {
            $('preview').classList.add('loading');
            img.dataset.pendingSrc = url;
            const temp = new Image();
            temp.onload = () => { if (img.dataset.pendingSrc === url) { img.src = url; delete img.dataset.pendingSrc; $('preview').classList.remove('loading'); } };
            temp.onerror = () => { if (img.dataset.pendingSrc === url) { img.src = url; delete img.dataset.pendingSrc; $('preview').classList.remove('loading'); } };
            temp.src = url;
        } else {
            requestAnimationFrame(drawBox);
        }
    }
    function drawBox() {
        const image = $('preview-image'), preview = $('preview'), overlay = $('box-overlay');
        if (!image.complete || !image.naturalWidth) { overlay.hidden = true; return; }
        overlay.hidden = false;
        const imageRect = image.getBoundingClientRect(), previewRect = preview.getBoundingClientRect();
        const { x, y, width, height } = boxOf(currentRecord() || {});
        overlay.style.left = `${imageRect.left - previewRect.left + (x - width / 2) * imageRect.width}px`;
        overlay.style.top = `${imageRect.top - previewRect.top + (y - height / 2) * imageRect.height}px`;
        overlay.style.width = `${width * imageRect.width}px`; overlay.style.height = `${height * imageRect.height}px`;
        preview.querySelectorAll('.model-box').forEach(element => element.remove());
        rankedModelRuns(currentRecord() || {}).filter(run => run.box).forEach((run, index) => {
            const box = run.box;
            const modelOverlay = document.createElement('div');
            modelOverlay.className = 'model-box';
            modelOverlay.style.setProperty('--model-color', MODEL_COLORS[index % MODEL_COLORS.length]);
            modelOverlay.style.left = `${imageRect.left - previewRect.left + box.xmin * imageRect.width}px`;
            modelOverlay.style.top = `${imageRect.top - previewRect.top + box.ymin * imageRect.height}px`;
            modelOverlay.style.width = `${(box.xmax - box.xmin) * imageRect.width}px`;
            modelOverlay.style.height = `${(box.ymax - box.ymin) * imageRect.height}px`;
            modelOverlay.title = run.model_name || run.model_id || 'Detector proposal';
            preview.append(modelOverlay);
        });
    }

    function renderModelRuns(record) {
        const runs = rankedModelRuns(record);
        if (!runs.length) {
            const empty = document.createElement('p'); empty.className = 'record-meta'; empty.textContent = 'No detector was run. This is a human-only crop.';
            $('model-runs-list').replaceChildren(empty); return;
        }
        $('model-runs-list').replaceChildren(...runs.map((run, index) => {
            const row = document.createElement('div'); row.className = 'model-run';
            const identity = document.createElement('div');
            const name = document.createElement('strong');
            const swatch = document.createElement('i'); swatch.className = 'model-swatch'; swatch.style.setProperty('--model-color', MODEL_COLORS[index % MODEL_COLORS.length]);
            name.append(swatch, document.createTextNode(run.model_name || run.model_id || 'Unknown detector'));
            const version = document.createElement('small'); version.textContent = run.model_version ? `Version ${run.model_version}` : '';
            if (record.active_model_at_save === run.model_id) {
                const selectedAtSave = document.createElement('span');
                selectedAtSave.className = 'selected-model-badge';
                selectedAtSave.textContent = 'Selected at save';
                name.append(selectedAtSave);
            }
            identity.append(name, version);
            const result = document.createElement('span');
            const confidence = Number.isFinite(run.score) ? ` · ${Math.round(run.score * 100)}% confidence` : '';
            result.textContent = run.status === 'detected' ? `${run.class_name || 'Subject'}${confidence}` : String(run.status || 'unknown').replaceAll('_', ' ');
            const overlap = document.createElement('span'); overlap.className = 'overlap';
            overlap.textContent = run.iou_to_human == null ? 'No box' : `${Math.round(run.iou_to_human * 100)}% box IoU`;
            overlap.title = 'Intersection area divided by union area. This measures box geometry, not confidence.';
            const timing = document.createElement('span'); timing.className = 'timing';
            timing.textContent = Number.isFinite(run.duration_ms) ? `${formatMilliseconds(run.duration_ms)} total` : 'Timing unavailable';
            const parts = run.timing_breakdown || {};
            const breakdown = [
                ['model setup', parts.model_setup_ms], ['image fetch/decode', parts.image_fetch_decode_ms],
                ['preprocess', parts.preprocess_ms], ['inference', parts.inference_ms], ['postprocess', parts.postprocess_ms]
            ].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => `${label}: ${formatMilliseconds(value)}`);
            if (breakdown.length) timing.title = `${breakdown.join(' · ')}. Total includes extension messaging.`;
            else if (Number.isFinite(run.pipeline_duration_ms)) timing.title = `${formatMilliseconds(run.pipeline_duration_ms)} inside the detector pipeline; total includes messaging and model startup.`;
            row.append(identity, result, overlap, timing); return row;
        }));
    }

    function currentRecord() { return state.records.find((record) => idOf(record) === state.selectedId); }
    async function saveSelected(status, { advance = false } = {}) {
        const existing = currentRecord(); if (!existing) return;
        const beforeIds = filteredRecords().map(idOf);
        const priorityFlags = new Set($('priority-flags').value.split(',').map((v) => v.trim()).filter(Boolean));
        if ($('taxon-name').value.trim() || $('taxon-common-name').value.trim()) priorityFlags.delete('unfamiliar_or_unidentified_taxon');
        const updated = { ...existing, taxon_name: $('taxon-name').value.trim(), taxon_common_name: $('taxon-common-name').value.trim(), iconic_taxon: $('taxon-group').value.trim(), review_status: status || statusOf(existing), verification_mode: 'manual', priority_flags: [...priorityFlags], updated_at: new Date().toISOString() };
        const saved = await storage().save(updated);
        state.records[state.records.indexOf(existing)] = saved;
        if (advance) {
            const afterIds = filteredRecords().map(idOf);
            setSelectedId(window.iNatDatasetReview.nextAfterAction(beforeIds, idOf(existing), afterIds));
        }
        notify(status === 'verified' ? 'Annotation approved.' : status === 'rejected' ? 'Annotation rejected.' : status === 'pending' ? 'Annotation returned to needs review.' : 'Annotation metadata saved.');
        render();
    }

    async function refreshINaturalistMetadata({ automatic = false } = {}) {
        const candidates = state.records.filter((record) => record.observation_id && (!automatic || !record.taxon_id || !record.taxon_name));
        if (!candidates.length) {
            if (!automatic) notify('There are no observation records to refresh.');
            return;
        }
        let updatedCount = 0;
        for (const existing of candidates.slice(0, 25)) {
            try {
                const response = await fetch(`https://api.inaturalist.org/v1/observations/${encodeURIComponent(existing.observation_id)}`);
                if (!response.ok) continue;
                const observation = (await response.json()).results?.[0];
                const taxon = observation?.taxon;
                if (!taxon) continue;
                const updated = {
                    ...existing,
                    taxon_id: taxon.id == null ? null : String(taxon.id),
                    taxon_name: taxon.name || existing.taxon_name || null,
                    taxon_common_name: taxon.preferred_common_name || existing.taxon_common_name || null,
                    taxon_rank: taxon.rank || existing.taxon_rank || null,
                    iconic_taxon: taxon.iconic_taxon_name || existing.iconic_taxon || null,
                    priority_flags: flagsOf(existing).filter((flag) => flag !== 'unfamiliar_or_unidentified_taxon'),
                    updated_at: new Date().toISOString()
                };
                await storage().save(updated);
                state.records[state.records.indexOf(existing)] = updated;
                updatedCount++;
            } catch (_) {
                // Leave the saved snapshot intact when iNaturalist is unavailable.
            }
        }
        if (updatedCount) {
            render();
            notify(`Updated taxon metadata for ${updatedCount} annotation${updatedCount === 1 ? '' : 's'}.`);
        } else if (!automatic) {
            notify('No newer taxon metadata was available yet.', true);
        }
    }
    function notify(message, error) { $('notice').textContent = message; $('notice').style.color = error ? '#9a2525' : '#527d00'; }
    function download(name, type, content) { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    function downloadBlob(name, blob) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
    function crc32(bytes) { let crc = 0xffffffff; bytes.forEach((byte) => { crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); }); return (crc ^ 0xffffffff) >>> 0; }
    function zipHeader(signature, fields) { const buffer = new ArrayBuffer(4 + fields.reduce((sum, field) => sum + field[0], 0)); const view = new DataView(buffer); view.setUint32(0, signature, true); let offset = 4; fields.forEach(([size, value]) => { if (size === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true); offset += size; }); return new Uint8Array(buffer); }
    function makeZip(files) {
        const encoder = new TextEncoder(), localParts = [], centralParts = []; let offset = 0;
        Object.entries(files).forEach(([name, content]) => {
            const nameBytes = encoder.encode(name), bytes = typeof content === 'string' ? encoder.encode(content) : content, crc = crc32(bytes);
            const local = zipHeader(0x04034b50, [[2, 20], [2, 0], [2, 0], [2, 0], [2, 0], [4, crc], [4, bytes.length], [4, bytes.length], [2, nameBytes.length], [2, 0]]);
            localParts.push(local, nameBytes, bytes);
            const central = zipHeader(0x02014b50, [[2, 20], [2, 20], [2, 0], [2, 0], [2, 0], [2, 0], [4, crc], [4, bytes.length], [4, bytes.length], [2, nameBytes.length], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]);
            centralParts.push(central, nameBytes); offset += local.length + nameBytes.length + bytes.length;
        });
        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0), count = Object.keys(files).length;
        const end = zipHeader(0x06054b50, [[2, 0], [2, 0], [2, count], [2, count], [4, centralSize], [4, offset], [2, 0]]);
        return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    }
    function safeStem(record) { return String(record.photo_id || idOf(record)).replace(/[^a-zA-Z0-9_-]/g, '_'); }
    function exportCoco() {
        const records = state.records.filter((r) => statusOf(r) === 'verified');
        const images = records.map((r, i) => ({ id: i + 1, file_name: `${safeStem(r)}.jpg`, width: +r.original_width || 0, height: +r.original_height || 0, photo_id: r.photo_id, source_url: imageOf(r), license: r.license_code || r.license || null }));
        const annotations = records.map((r, i) => { const b = boxOf(r), w = +r.original_width || 1, h = +r.original_height || 1; return { id: i + 1, image_id: i + 1, category_id: 1, bbox: [(b.x - b.width / 2) * w, (b.y - b.height / 2) * h, b.width * w, b.height * h], area: b.width * w * b.height * h, iscrowd: 0 }; });
        download('inaturalist-crops-coco.json', 'application/json', JSON.stringify({ info: { description: 'Verified iNaturalist crop annotations' }, images, annotations, categories: [{ id: 1, name: 'subject' }] }, null, 2));
    }
    function exportYolo() {
        const records = state.records.filter((r) => statusOf(r) === 'verified');
        const files = { 'data.yaml': "path: .\ntrain: images\nval: images\nnames:\n  0: subject\n" };
        const metadata = [];
        records.forEach((r) => { const b = boxOf(r), stem = safeStem(r); files[`labels/${stem}.txt`] = `0 ${b.x} ${b.y} ${b.width} ${b.height}\n`; metadata.push({ file_name: `${stem}.jpg`, photo_id: r.photo_id, source_url: imageOf(r), license: r.license_code || r.license || null }); });
        files['metadata.json'] = JSON.stringify({ format: 'YOLO normalized xywh', images_not_included: true, records: metadata }, null, 2);
        downloadBlob('inaturalist-crops-yolo.zip', makeZip(files));
    }

    function moveSelection(direction) {
        const records = filteredRecords();
        if (!records.length) return;
        const currentIndex = records.findIndex(record => idOf(record) === state.selectedId);
        const fallbackIndex = direction > 0 ? 0 : records.length - 1;
        const nextIndex = currentIndex < 0
            ? fallbackIndex
            : Math.max(0, Math.min(records.length - 1, currentIndex + direction));
        if (nextIndex !== currentIndex) {
            setSelectedId(idOf(records[nextIndex]));
            render();
        }
    }

    document.querySelectorAll('.status-tabs [data-status]').forEach(button => {
        button.addEventListener('click', () => {
            state.statusFilter = button.dataset.status;
            keepSelectionInQueue();
            render();
        });
    });
    $('sort-order').addEventListener('change', event => {
        state.sortOrder = event.target.value;
        keepSelectionInQueue();
        render();
    });
    $('annotation-search').addEventListener('input', event => {
        state.searchQuery = event.target.value;
        keepSelectionInQueue();
        render();
    });
    $('preview-image').addEventListener('load', drawBox); window.addEventListener('resize', drawBox);
    $('record-list').addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    });
    $('edit-form').addEventListener('submit', (event) => { event.preventDefault(); saveSelected(); });
    $('verify-record').addEventListener('click', () => saveSelected('verified', { advance: true }));
    $('reject-record').addEventListener('click', () => saveSelected('rejected', { advance: true }));
    $('pending-record').addEventListener('click', () => saveSelected('pending'));
    $('previous-record').addEventListener('click', () => moveSelection(-1));
    $('next-record').addEventListener('click', () => moveSelection(1));
    $('copy-annotation-id').addEventListener('click', async () => {
        const record = currentRecord();
        if (!record) return;
        try {
            await navigator.clipboard.writeText(idOf(record));
            notify(`Copied annotation ID ${idOf(record)}.`);
        } catch (_) {
            notify(`Annotation ID: ${idOf(record)}`);
        }
    });
    $('backup-json').addEventListener('click', () => download(`inaturalist-crop-dataset-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), records: state.records }, null, 2)));
    $('refresh-metadata').addEventListener('click', () => refreshINaturalistMetadata());
    $('sync-collector').addEventListener('click', () => configureCollector().catch(error => {
        showCollectorState('offline', 'Collector offline');
        $('sync-collector').disabled = false; $('sync-collector').textContent = 'Connect once';
        notify(`Collector connection failed: ${error.message}`, true);
    }));
    $('retry-collector').addEventListener('click', () => refreshCollector({ announce: true }).catch(error => notify(`Collector connection failed: ${error.message}`, true)));
    $('collector-status').addEventListener('click', async () => {
        const token = (await chromeCall(chrome.storage.local, 'get', COLLECTOR_TOKEN_KEY))?.[COLLECTOR_TOKEN_KEY];
        if (token) {
            refreshCollector({ announce: true }).catch(error => notify(`Collector connection failed: ${error.message}`, true));
            return;
        }
        const tools = document.querySelector('.dataset-tools'); tools.open = true;
        $('collector-token').focus(); tools.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('export-coco').addEventListener('click', exportCoco); $('export-yolo').addEventListener('click', exportYolo);
    $('import-json').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', async (event) => {
        try { const parsed = JSON.parse(await event.target.files[0].text()); const records = Array.isArray(parsed) ? parsed : (parsed.records || parsed.annotations); if (!Array.isArray(records)) throw new Error('No records or annotations array found'); await storage().import(records); state.records = await storage().list(); keepSelectionInQueue(); render(); notify(`Imported ${records.length} annotations.`); } catch (error) { notify(`Import failed: ${error.message}`, true); } finally { event.target.value = ''; }
    });

    Promise.all([storage().list(), chromeCall(chrome.storage.local, 'get', COLLECTOR_TOKEN_KEY), refreshJobStatus()]).then(([records, tokenResult]) => {
        state.records = Array.isArray(records) ? records : (records && records.records) || [];
        const linkedId = new URLSearchParams(window.location.hash.slice(1)).get('annotation');
        if (linkedId && state.records.some(record => idOf(record) === linkedId)) {
            state.statusFilter = 'all';
            setSelectedId(linkedId);
        } else {
            keepSelectionInQueue();
        }
        $('collector-token').value = tokenResult?.[COLLECTOR_TOKEN_KEY] || '';
        $('collector-setup').hidden = Boolean($('collector-token').value);
        if ($('collector-token').value) showCollectorState('', 'Checking collector…');
        else showCollectorState('unconfigured', 'Collector not connected');
        render(); refreshINaturalistMetadata({ automatic: true });
        if ($('collector-token').value) refreshCollector().catch(() => showCollectorState('offline', 'Collector offline'));
    }).catch((error) => notify(`Could not load annotations: ${error.message}`, true));
    window.setInterval(async () => {
        await refreshJobStatus().catch(() => {});
        state.records = await storage().list().catch(() => state.records);
        render();
        if ($('collector-setup').hidden) refreshCollector().catch(() => showCollectorState('offline', 'Collector offline'));
    }, 30000);
}());
