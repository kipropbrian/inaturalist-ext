// Model-specific postprocessing helpers shared by the MV3 worker and Node tests.
(function initDetectorPostprocess(global) {
	'use strict';

	function saliencyMaskToBox(values, width, height, options = {}) {
		if (!values || values.length !== width * height || width < 1 || height < 1) return null;
		let minimum = Infinity;
		let maximum = -Infinity;
		for (const value of values) {
			if (value < minimum) minimum = value;
			if (value > maximum) maximum = value;
		}
		const range = maximum - minimum;
		if (!Number.isFinite(range) || range <= 1e-8) return null;
		const threshold = minimum + range * (options.threshold ?? 0.5);
		const visited = new Uint8Array(values.length);
		const queue = new Int32Array(values.length);
		let best = null;

		for (let start = 0; start < values.length; start++) {
			if (visited[start] || values[start] < threshold) continue;
			let head = 0;
			let tail = 0;
			let area = 0;
			let scoreSum = 0;
			let xmin = width;
			let ymin = height;
			let xmax = -1;
			let ymax = -1;
			visited[start] = 1;
			queue[tail++] = start;
			while (head < tail) {
				const index = queue[head++];
				const x = index % width;
				const y = Math.floor(index / width);
				area++;
				scoreSum += (values[index] - minimum) / range;
				xmin = Math.min(xmin, x);
				ymin = Math.min(ymin, y);
				xmax = Math.max(xmax, x);
				ymax = Math.max(ymax, y);
				let neighbor;
				if (x > 0) {
					neighbor = index - 1;
					if (!visited[neighbor] && values[neighbor] >= threshold) { visited[neighbor] = 1; queue[tail++] = neighbor; }
				}
				if (x + 1 < width) {
					neighbor = index + 1;
					if (!visited[neighbor] && values[neighbor] >= threshold) { visited[neighbor] = 1; queue[tail++] = neighbor; }
				}
				if (y > 0) {
					neighbor = index - width;
					if (!visited[neighbor] && values[neighbor] >= threshold) { visited[neighbor] = 1; queue[tail++] = neighbor; }
				}
				if (y + 1 < height) {
					neighbor = index + width;
					if (!visited[neighbor] && values[neighbor] >= threshold) { visited[neighbor] = 1; queue[tail++] = neighbor; }
				}
			}
			if (!best || area > best.area) best = { area, score: scoreSum / area, xmin, ymin, xmax, ymax };
		}

		const minimumArea = options.minimumArea ?? Math.max(16, Math.round(width * height * 0.001));
		if (!best || best.area < minimumArea) return null;
		const componentWidth = best.xmax - best.xmin + 1;
		const componentHeight = best.ymax - best.ymin + 1;
		const padding = options.padding ?? 0.05;
		const padX = componentWidth * padding;
		const padY = componentHeight * padding;
		return {
			xmin: Math.max(0, (best.xmin - padX) / width),
			ymin: Math.max(0, (best.ymin - padY) / height),
			xmax: Math.min(1, (best.xmax + 1 + padX) / width),
			ymax: Math.min(1, (best.ymax + 1 + padY) / height),
			score: best.score,
			classId: 0,
			className: 'salient subject',
			componentArea: best.area
		};
	}

	global.iNatDetectorPostprocess = Object.freeze({ saliencyMaskToBox });
})(typeof self !== 'undefined' ? self : globalThis);
