/*
 * Usage page layout and chart behavior adapted from T3 Code, MIT License,
 * Copyright (c) 2026 T3 Tools Inc. See T3_CODE_LICENSE.txt.
 *
 * This is intentionally a plain-DOM view over Qorpera's /api/usage adapter.
 * It does not import T3's React, router, Effect RPC, environment merge, or
 * provider-transcript scanners.
 */
(function installUsagePage() {
	const USD = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	const INTEGER = new Intl.NumberFormat("en-US");
	const VIEW_WIDTH = 960;
	const VIEW_HEIGHT = 260;
	const PLOT_TOP = 8;
	const TICK_COUNT = 4;
	const WINDOW_OPTIONS = [
		{ days: 7, label: "7 days" },
		{ days: 30, label: "30 days" },
		{ days: 90, label: "90 days" },
	];
	const PROVIDER_COLORS = {
		codex: "#e6e6e6",
		anthropic: "#d97757",
		claude: "#d97757",
		openai: "#a7f3d0",
		"openai-codex": "#e6e6e6",
		google: "#8ab4f8",
		openrouter: "#c4b5fd",
		tools: "#cc7d5e",
		qorpera: "#8099ff",
	};
	const COLOR_PALETTE = ["#67e8f9", "#f9a8d4", "#fde68a", "#86efac", "#c4b5fd", "#fca5a5"];
	const PROVIDER_LABELS = {
		codex: "Codex",
		anthropic: "Anthropic",
		claude: "Claude Code",
		openai: "OpenAI",
		"openai-codex": "OpenAI Codex",
		google: "Google",
		openrouter: "OpenRouter",
		tools: "Tools",
		qorpera: "Qorpera summaries",
	};
	const SKELETON_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67];
	const page = {
		backendUrl: "",
		onBack: () => {},
		windowDays: 30,
		metric: "cost",
		breakdown: "model",
		summary: null,
		requestId: 0,
	};

	function root() {
		return document.getElementById("view-usage");
	}

	function byId(id) {
		return document.getElementById(id);
	}

	function formatUsd(value) {
		return USD.format(value);
	}

	function formatCount(value) {
		return INTEGER.format(Math.round(value));
	}

	function trimNumber(value) {
		const absolute = Math.abs(value);
		const digits = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
		return value.toFixed(digits).replace(/\.0+$/, "");
	}

	function formatTokens(value) {
		const absolute = Math.abs(value);
		if (absolute >= 1e12) return `${trimNumber(value / 1e12)}T`;
		if (absolute >= 1e9) return `${trimNumber(value / 1e9)}B`;
		if (absolute >= 1e6) return `${trimNumber(value / 1e6)}M`;
		if (absolute >= 1e3) return `${trimNumber(value / 1e3)}K`;
		return INTEGER.format(Math.round(value));
	}

	function formatPercent(share) {
		return `${(share * 100).toFixed(1)}%`;
	}

	function formatDayShort(day) {
		const [year, month, dayOfMonth] = day.split("-").map(Number);
		if (!year || !month || !dayOfMonth) return day;
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		return `${months[month - 1] ?? ""} ${dayOfMonth}`;
	}

	function localDay(now, timeZone) {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);
		const values = new Map(parts.map((part) => [part.type, part.value]));
		return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
	}

	function makeWindow(days, now = new Date()) {
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		const untilDay = localDay(now, timeZone);
		const [year, month, dayOfMonth] = untilDay.split("-").map(Number);
		const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
		return { sinceDay: start.toISOString().slice(0, 10), untilDay, timeZone };
	}

	function enumerateDays(sinceDay, untilDay) {
		const days = [];
		const start = Date.parse(`${sinceDay}T00:00:00Z`);
		const end = Date.parse(`${untilDay}T00:00:00Z`);
		for (let cursor = start; cursor <= end; cursor += 86_400_000) {
			days.push(new Date(cursor).toISOString().slice(0, 10));
		}
		return days;
	}

	function providerLabel(provider) {
		if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
		return String(provider)
			.split(/[-_/]/g)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	function providerColor(provider) {
		if (PROVIDER_COLORS[provider]) return PROVIDER_COLORS[provider];
		let hash = 0;
		for (const character of String(provider)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
		return COLOR_PALETTE[hash % COLOR_PALETTE.length];
	}

	function providerMark(provider) {
		const mark = document.createElement("span");
		mark.className = "usage-provider-mark";
		mark.style.setProperty("--provider-color", providerColor(provider));
		mark.setAttribute("aria-hidden", "true");
		return mark;
	}

	function pageShell() {
		const el = root();
		el.innerHTML = `
			<div class="usage-page">
				<header class="usage-header">
					<div class="usage-heading">
						<button id="usageBack" class="usage-icon-button" type="button" aria-label="Back">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
						</button>
						<div><h1>Usage</h1><p id="usageRange"></p></div>
					</div>
					<div class="usage-actions">
						<div id="usageWindows" class="usage-segmented"></div>
						<button id="usageRefresh" class="usage-icon-button" type="button" aria-label="Refresh usage" title="Refresh usage">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
						</button>
					</div>
				</header>
				<div id="usageContent"></div>
			</div>`;
		byId("usageBack").onclick = () => page.onBack();
		byId("usageRefresh").onclick = () => loadUsage(true);
		renderWindowControls();
	}

	function renderWindowControls() {
		const controls = byId("usageWindows");
		controls.innerHTML = "";
		for (const option of WINDOW_OPTIONS) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = option.label;
			button.className = option.days === page.windowDays ? "active" : "";
			button.onclick = () => {
				if (page.windowDays === option.days) return;
				page.windowDays = option.days;
				page.summary = null;
				renderWindowControls();
				loadUsage(false);
			};
			controls.appendChild(button);
		}
		const window = makeWindow(page.windowDays);
		byId("usageRange").textContent = `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
	}

	function renderSkeleton() {
		const content = byId("usageContent");
		content.className = "usage-skeleton";
		content.innerHTML = `
			<section class="usage-main-grid">
				<div class="usage-summary">
					<div class="usage-headline"><span class="usage-kicker">Raw token cost</span><span class="usage-skeleton-block" style="width:144px;height:34px;margin:5px 0"></span><span class="usage-skeleton-block" style="width:124px;height:12px"></span></div>
					<div class="usage-provider"><div class="usage-provider-head"><span class="usage-skeleton-block" style="width:100px;height:14px"></span><span class="usage-skeleton-block" style="width:56px;height:14px"></span></div><div class="usage-provider-bar"></div><span class="usage-skeleton-block" style="width:152px;height:12px"></span></div>
					<div class="usage-provider"><div class="usage-provider-head"><span class="usage-skeleton-block" style="width:86px;height:14px"></span><span class="usage-skeleton-block" style="width:56px;height:14px"></span></div><div class="usage-provider-bar"></div><span class="usage-skeleton-block" style="width:136px;height:12px"></span></div>
				</div>
				<div class="usage-chart-section"><div class="usage-section-head"><h2>Daily cost</h2></div><div class="usage-skeleton-bars">${SKELETON_HEIGHTS.map((height) => `<span style="height:${height}%"></span>`).join("")}</div></div>
			</section>
			<section class="usage-metrics">${["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map((label) => `<div class="usage-metric"><span class="usage-metric-label">${label}</span><span class="usage-skeleton-block" style="width:64px;height:21px;margin:4px 0"></span><span class="usage-skeleton-block" style="width:96px;height:12px"></span></div>`).join("")}</section>`;
	}

	async function loadUsage(force) {
		const window = makeWindow(page.windowDays);
		byId("usageRange").textContent = `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
		if (!force && page.summary && page.summary.sinceDay === window.sinceDay && page.summary.untilDay === window.untilDay) {
			renderLoaded();
			return;
		}
		renderSkeleton();
		const requestId = ++page.requestId;
		const params = new URLSearchParams(window);
		try {
			const response = await fetch(`${page.backendUrl}/api/usage?${params}`, { cache: "no-store" });
			if (!response.ok) {
				const failure = await response.json().catch(() => ({}));
				throw new Error(failure.error ?? `usage request failed (${response.status})`);
			}
			const summary = await response.json();
			if (requestId !== page.requestId) return;
			page.summary = summary;
			renderLoaded();
		} catch (error) {
			if (requestId !== page.requestId) return;
			const content = byId("usageContent");
			content.className = "";
			content.innerHTML = "";
			const notice = document.createElement("div");
			notice.className = "usage-notice error";
			notice.textContent = `Usage could not be read: ${error instanceof Error ? error.message : String(error)}`;
			content.appendChild(notice);
		}
	}

	function makeNotice(summary) {
		const notice = document.createElement("div");
		notice.className = "usage-notice";
		const lines = ["This view covers the active company’s trail only; provider CLI sessions outside this company are not included."];
		if (summary.pricing.status === "unavailable") {
			lines.push("The LiteLLM rate catalog is unavailable; token totals remain complete but raw cost may be unpriced.");
		}
		if (summary.unpricedRecords > 0) {
			lines.push(`${formatCount(summary.unpricedRecords)} usage record${summary.unpricedRecords === 1 ? " has" : "s have"} tokens but no matching model rate; cost totals exclude them.`);
		}
		const coverage = summary.coverage;
		if (coverage.unreadableSessions || coverage.malformedLines || coverage.untimedRecords) {
			lines.push(`Coverage diagnostics: ${formatCount(coverage.unreadableSessions)} unreadable session(s), ${formatCount(coverage.malformedLines)} malformed line(s), ${formatCount(coverage.untimedRecords)} untimed usage record(s).`);
		}
		for (const line of lines) {
			const row = document.createElement("span");
			row.textContent = line;
			notice.appendChild(row);
		}
		return notice;
	}

	function renderProviderSummary(summary, container) {
		const ordered = [...summary.providers].sort((left, right) =>
			page.metric === "cost" ? right.costUsd - left.costUsd : right.totalTokens - left.totalTokens,
		);
		for (const provider of ordered) {
			const share = page.metric === "cost" ? provider.costShare : provider.tokenShare;
			const row = document.createElement("div");
			row.className = "usage-provider";
			row.style.setProperty("--provider-color", providerColor(provider.provider));
			const head = document.createElement("div");
			head.className = "usage-provider-head";
			const name = document.createElement("span");
			name.className = "usage-provider-name";
			name.appendChild(providerMark(provider.provider));
			const label = document.createElement("span");
			label.textContent = providerLabel(provider.provider);
			name.appendChild(label);
			const value = document.createElement("span");
			value.className = "usage-provider-value";
			value.textContent = page.metric === "cost" ? formatUsd(provider.costUsd) : formatTokens(provider.totalTokens);
			head.appendChild(name);
			head.appendChild(value);
			const bar = document.createElement("div");
			bar.className = "usage-provider-bar";
			const fill = document.createElement("span");
			fill.style.width = `${Math.max(0, Math.min(100, share * 100)).toFixed(1)}%`;
			bar.appendChild(fill);
			const detail = document.createElement("span");
			detail.className = "usage-detail";
			detail.textContent = page.metric === "cost"
				? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
				: `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`;
			row.appendChild(head);
			row.appendChild(bar);
			row.appendChild(detail);
			container.appendChild(row);
		}
	}

	function metricCard(label, value, detail) {
		const card = document.createElement("div");
		card.className = "usage-metric";
		for (const [className, text] of [
			["usage-metric-label", label],
			["usage-metric-value", value],
			["usage-metric-detail", detail],
		]) {
			const line = document.createElement("span");
			line.className = className;
			line.textContent = text;
			card.appendChild(line);
		}
		return card;
	}

	function renderMetricControls(container) {
		container.innerHTML = "";
		for (const option of ["cost", "tokens"]) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = option;
			button.className = page.metric === option ? "active" : "";
			button.onclick = () => {
				page.metric = option;
				renderLoaded();
			};
			container.appendChild(button);
		}
	}

	function renderBreakdownControls(container) {
		container.innerHTML = "";
		for (const option of ["model", "day"]) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = option;
			button.className = page.breakdown === option ? "active" : "";
			button.onclick = () => {
				page.breakdown = option;
				renderBreakdown(page.summary);
			};
			container.appendChild(button);
		}
	}

	function renderLegend(summary, container) {
		container.innerHTML = "";
		for (const provider of summary.providers) {
			const item = document.createElement("span");
			item.className = "usage-legend-item";
			item.appendChild(providerMark(provider.provider));
			const label = document.createElement("span");
			label.textContent = providerLabel(provider.provider);
			item.appendChild(label);
			container.appendChild(item);
		}
	}

	function niceScale(peak, count) {
		if (peak <= 0) return { max: 0, ticks: [0] };
		const rawStep = peak / count;
		const magnitude = 10 ** Math.floor(Math.log10(rawStep));
		const normalized = rawStep / magnitude;
		const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
		const max = Math.ceil(peak / step) * step;
		const ticks = [];
		for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
		return { max, ticks };
	}

	function monotoneTangents(points) {
		if (points.length < 2) return [0];
		const slopes = [];
		for (let index = 0; index < points.length - 1; index += 1) {
			const dx = points[index + 1].x - points[index].x;
			slopes.push(dx === 0 ? 0 : (points[index + 1].y - points[index].y) / dx);
		}
		const tangents = Array.from({ length: points.length }, () => 0);
		tangents[0] = slopes[0] ?? 0;
		tangents[points.length - 1] = slopes[slopes.length - 1] ?? 0;
		for (let index = 1; index < points.length - 1; index += 1) {
			const previous = slopes[index - 1] ?? 0;
			const next = slopes[index] ?? 0;
			tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
		}
		for (let index = 0; index < points.length - 1; index += 1) {
			const slope = slopes[index] ?? 0;
			if (slope === 0) {
				tangents[index] = 0;
				tangents[index + 1] = 0;
				continue;
			}
			const a = tangents[index] / slope;
			const b = tangents[index + 1] / slope;
			const magnitude = a * a + b * b;
			if (magnitude > 9) {
				const scale = 3 / Math.sqrt(magnitude);
				tangents[index] = scale * a * slope;
				tangents[index + 1] = scale * b * slope;
			}
		}
		return tangents;
	}

	function smoothPath(points) {
		if (points.length < 2) return "";
		const tangents = monotoneTangents(points);
		let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
		for (let index = 0; index < points.length - 1; index += 1) {
			const from = points[index];
			const to = points[index + 1];
			const dx = to.x - from.x;
			path += ` C${(from.x + dx / 3).toFixed(2)},${(from.y + (tangents[index] * dx) / 3).toFixed(2)} ${(to.x - dx / 3).toFixed(2)},${(to.y - (tangents[index + 1] * dx) / 3).toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
		}
		return path;
	}

	function svgElement(name, attributes) {
		const element = document.createElementNS("http://www.w3.org/2000/svg", name);
		for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
		return element;
	}

	function renderChart(summary, container) {
		container.innerHTML = "";
		const days = enumerateDays(summary.sinceDay, summary.untilDay);
		const providers = summary.providers.map((provider) => provider.provider);
		const daily = new Map(summary.daily.map((entry) => [entry.day, entry]));
		const columns = days.map((day) => {
			const byProvider = new Map((daily.get(day)?.byProvider ?? []).map((entry) => [entry.provider, entry]));
			const bands = providers.map((provider) => ({
				provider,
				value: page.metric === "cost" ? (byProvider.get(provider)?.costUsd ?? 0) : (byProvider.get(provider)?.totalTokens ?? 0),
			}));
			return { bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
		});
		const peak = columns.reduce((outer, column) => column.bands.reduce((inner, band) => Math.max(inner, band.value), outer), 0);
		const scale = niceScale(peak, TICK_COUNT);
		const stepX = days.length <= 1 ? 0 : VIEW_WIDTH / (days.length - 1);
		const toY = (value) => scale.max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
		const format = page.metric === "cost" ? formatUsd : formatTokens;

		const chart = document.createElement("div");
		chart.className = "usage-chart";
		const body = document.createElement("div");
		body.className = "usage-chart-body";
		const axis = document.createElement("div");
		axis.className = "usage-axis";
		for (const tick of scale.ticks) {
			const label = document.createElement("span");
			label.style.top = `${(toY(tick) / VIEW_HEIGHT) * 100}%`;
			label.textContent = tick === 0 ? "0" : format(tick);
			axis.appendChild(label);
		}
		const plot = document.createElement("div");
		plot.className = "usage-plot";
		const svg = svgElement("svg", {
			viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
			preserveAspectRatio: "none",
			role: "img",
			"aria-label": `Daily ${page.metric === "cost" ? "cost" : "processed tokens"} by provider`,
		});
		for (const tick of scale.ticks) {
			svg.appendChild(svgElement("line", {
				x1: 0,
				x2: VIEW_WIDTH,
				y1: toY(tick),
				y2: toY(tick),
				stroke: "rgba(255,255,255,0.07)",
				"stroke-width": 1,
				"vector-effect": "non-scaling-stroke",
			}));
		}
		const paths = providers.map((provider, providerIndex) => {
			const points = columns.map((column, dayIndex) => ({ x: dayIndex * stepX, y: toY(column.bands[providerIndex]?.value ?? 0) }));
			const line = smoothPath(points);
			return {
				provider,
				line,
				area: line ? `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z` : "",
				total: columns.reduce((sum, column) => sum + (column.bands[providerIndex]?.value ?? 0), 0),
			};
		}).sort((left, right) => right.total - left.total);
		for (const path of paths) {
			svg.appendChild(svgElement("path", { d: path.area, fill: providerColor(path.provider), "fill-opacity": 0.12 }));
		}
		for (const path of paths) {
			svg.appendChild(svgElement("path", { d: path.line, fill: "none", stroke: providerColor(path.provider), "stroke-width": 2, "vector-effect": "non-scaling-stroke" }));
		}
		const hoverLine = svgElement("line", {
			x1: 0,
			x2: 0,
			y1: PLOT_TOP,
			y2: VIEW_HEIGHT,
			stroke: "#7f7f7f",
			"stroke-width": 1,
			"vector-effect": "non-scaling-stroke",
		});
		hoverLine.style.display = "none";
		svg.appendChild(hoverLine);
		const tooltip = document.createElement("div");
		tooltip.className = "usage-tooltip";
		tooltip.style.display = "none";
		plot.addEventListener("mousemove", (event) => {
			if (!days.length) return;
			const bounds = plot.getBoundingClientRect();
			const fraction = bounds.width === 0 ? 0 : (event.clientX - bounds.left) / bounds.width;
			const index = Math.min(days.length - 1, Math.max(0, Math.round(fraction * (days.length - 1))));
			const left = days.length <= 1 ? 0 : (index / (days.length - 1)) * 100;
			hoverLine.style.display = "";
			hoverLine.setAttribute("x1", String(index * stepX));
			hoverLine.setAttribute("x2", String(index * stepX));
			tooltip.style.display = "";
			tooltip.style.left = `${left}%`;
			tooltip.style.transform = left > 60 ? "translateX(-100%)" : "translateX(0)";
			tooltip.innerHTML = "";
			const heading = document.createElement("div");
			heading.className = "usage-tooltip-day";
			heading.textContent = formatDayShort(days[index]);
			tooltip.appendChild(heading);
			for (const band of columns[index].bands) {
				const row = document.createElement("div");
				row.className = "usage-tooltip-row";
				const name = document.createElement("span");
				name.className = "usage-tooltip-name";
				name.appendChild(providerMark(band.provider));
				name.appendChild(document.createTextNode(providerLabel(band.provider)));
				const value = document.createElement("span");
				value.textContent = format(band.value);
				row.appendChild(name);
				row.appendChild(value);
				tooltip.appendChild(row);
			}
			const total = document.createElement("div");
			total.className = "usage-tooltip-row usage-tooltip-total";
			const totalLabel = document.createElement("span");
			totalLabel.className = "usage-tooltip-name";
			totalLabel.textContent = "Total";
			const totalValue = document.createElement("span");
			totalValue.textContent = format(columns[index].total);
			total.appendChild(totalLabel);
			total.appendChild(totalValue);
			tooltip.appendChild(total);
		});
		plot.addEventListener("mouseleave", () => {
			hoverLine.style.display = "none";
			tooltip.style.display = "none";
		});
		plot.appendChild(svg);
		plot.appendChild(tooltip);
		body.appendChild(axis);
		body.appendChild(plot);
		chart.appendChild(body);
		const dates = document.createElement("div");
		dates.className = "usage-chart-dates";
		for (const index of [0, Math.floor(days.length / 2), days.length - 1]) {
			const label = document.createElement("span");
			label.textContent = days[index] ? formatDayShort(days[index]) : "";
			dates.appendChild(label);
		}
		chart.appendChild(dates);
		container.appendChild(chart);
	}

	function cell(row, text, className = "") {
		const value = document.createElement("td");
		value.className = className;
		value.textContent = text;
		row.appendChild(value);
		return value;
	}

	function tableHead(labels) {
		const head = document.createElement("thead");
		const row = document.createElement("tr");
		for (const [label, numeric] of labels) {
			const heading = document.createElement("th");
			heading.className = numeric ? "number" : "";
			heading.textContent = label;
			row.appendChild(heading);
		}
		head.appendChild(row);
		return head;
	}

	function renderBreakdown(summary) {
		const container = byId("usageBreakdownTable");
		if (!container) return;
		container.innerHTML = "";
		renderBreakdownControls(byId("usageBreakdownControls"));
		const table = document.createElement("table");
		table.className = "usage-table";
		const body = document.createElement("tbody");
		if (page.breakdown === "model") {
			table.appendChild(tableHead([["Model", false], ["Cost", true], ["Share", true], ["Tokens", true]]));
			if (!summary.models.length) {
				const row = document.createElement("tr");
				const empty = cell(row, "No activity in this window.", "usage-empty-row");
				empty.colSpan = 4;
				body.appendChild(row);
			} else {
				for (const model of summary.models) {
					const row = document.createElement("tr");
					const nameCell = document.createElement("td");
					const name = document.createElement("span");
					name.className = "usage-model-name";
					name.appendChild(providerMark(model.provider));
					name.appendChild(document.createTextNode(model.model));
					nameCell.appendChild(name);
					row.appendChild(nameCell);
					cell(row, formatUsd(model.costUsd), "number");
					cell(row, formatPercent(model.costShare), "number muted");
					cell(row, formatTokens(model.totalTokens), "number muted");
					body.appendChild(row);
				}
			}
		} else {
			const providers = summary.providers.map((provider) => provider.provider);
			table.appendChild(tableHead([
				["Day", false],
				...providers.map((provider) => [providerLabel(provider), true]),
				["Total", true],
				["Tokens", true],
			]));
			const recent = [...summary.daily].reverse().slice(0, 8);
			if (!recent.length) {
				const row = document.createElement("tr");
				const empty = cell(row, "No activity in this window.", "usage-empty-row");
				empty.colSpan = providers.length + 3;
				body.appendChild(row);
			} else {
				for (const day of recent) {
					const row = document.createElement("tr");
					cell(row, formatDayShort(day.day));
					const byProvider = new Map(day.byProvider.map((provider) => [provider.provider, provider]));
					for (const provider of providers) cell(row, formatUsd(byProvider.get(provider)?.costUsd ?? 0), "number muted");
					cell(row, formatUsd(day.costUsd), "number");
					cell(row, formatTokens(day.totalTokens), "number muted");
					body.appendChild(row);
				}
			}
		}
		table.appendChild(body);
		container.appendChild(table);
	}

	function renderLoaded() {
		const summary = page.summary;
		if (!summary) return;
		byId("usageRange").textContent = `${formatDayShort(summary.sinceDay)} to ${formatDayShort(summary.untilDay)}`;
		const content = byId("usageContent");
		content.className = "usage-loaded";
		content.innerHTML = `
			<div id="usageNotices"></div>
			<section class="usage-main-grid">
				<div class="usage-summary">
					<div class="usage-headline"><span id="usageKicker" class="usage-kicker"></span><span id="usageHeadline" class="usage-headline-value"></span><span id="usageHeadlineDetail" class="usage-detail"></span></div>
					<div id="usageProviders" class="usage-summary"></div>
				</div>
				<div class="usage-chart-section">
					<div class="usage-section-head"><h2 id="usageChartTitle"></h2><div class="usage-chart-controls"><div id="usageMetricControls" class="usage-segmented compact"></div><div id="usageLegend" class="usage-legend"></div></div></div>
					<div id="usageChart"></div>
				</div>
			</section>
			<section id="usageMetrics" class="usage-metrics"></section>
			<section class="usage-breakdown">
				<div class="usage-section-head"><h2>Breakdown</h2><div id="usageBreakdownControls" class="usage-segmented compact"></div></div>
				<div id="usageBreakdownTable" class="usage-table-wrap"></div>
			</section>`;
		byId("usageNotices").appendChild(makeNotice(summary));
		byId("usageKicker").textContent = page.metric === "cost" ? "Raw token cost" : "Processed tokens";
		byId("usageHeadline").textContent = page.metric === "cost"
			? `${formatUsd(summary.costUsd)}*`
			: formatTokens(summary.totalTokens);
		byId("usageHeadlineDetail").textContent = page.metric === "cost"
			? "* if billed at full API rate"
			: `Input, cache reads and output across ${formatCount(summary.sessions)} sessions.`;
		renderProviderSummary(summary, byId("usageProviders"));
		byId("usageChartTitle").textContent = `Daily ${page.metric === "cost" ? "cost" : "processed tokens"}`;
		renderMetricControls(byId("usageMetricControls"));
		renderLegend(summary, byId("usageLegend"));
		renderChart(summary, byId("usageChart"));
		const activeDays = summary.daily.filter((day) => day.totalTokens > 0).length;
		const dailyAverage = activeDays === 0 ? 0 : summary.totalTokens / activeDays;
		const observedInput = summary.uncachedInputTokens + summary.cachedInputTokens;
		const cachedShare = observedInput === 0 ? 0 : summary.cachedInputTokens / observedInput;
		const metrics = byId("usageMetrics");
		metrics.appendChild(metricCard("Processed tokens", formatTokens(summary.totalTokens), `${formatTokens(dailyAverage)} per active day`));
		metrics.appendChild(metricCard("Cached input", formatTokens(summary.cachedInputTokens), `${formatPercent(cachedShare)} of observed input`));
		metrics.appendChild(metricCard("Uncached input", formatTokens(summary.uncachedInputTokens), `${formatTokens(summary.cacheCreationTokens)} cache writes`));
		metrics.appendChild(metricCard("Output", formatTokens(summary.outputTokens), `includes ${formatTokens(summary.reasoningTokens)} reasoning`));
		metrics.appendChild(metricCard(
			"Cache savings",
			formatUsd(summary.costQuality.cacheSavingsUsd),
			summary.costUsd > 0
				? `${(summary.costQuality.cacheSavingsUsd / summary.costUsd).toFixed(1)}x the raw token cost`
				: "vs full input rates",
		));
		renderBreakdown(summary);
	}

	window.qorperaUsage = {
		open(options) {
			const changedCompany = page.backendUrl !== options.backendUrl;
			page.backendUrl = options.backendUrl;
			page.onBack = options.onBack;
			if (changedCompany) page.summary = null;
			if (!root().querySelector(".usage-page")) pageShell();
			// Embedded (inside Settings): the host chrome owns navigation, so
			// the page's own back arrow disappears and the padding collapses.
			root().querySelector(".usage-page").classList.toggle("embedded", Boolean(options.embedded));
			renderWindowControls();
			if (page.summary) renderLoaded();
			else loadUsage(false);
		},
	};
})();
