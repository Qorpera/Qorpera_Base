(function installArtifactDashboardModel(root) {
	"use strict";

	function validTimestamp(value) {
		return typeof value === "string" && Number.isFinite(Date.parse(value));
	}

	function metricObservations(metric) {
		if (!Array.isArray(metric?.observations)) return [];
		return metric.observations
			.filter(
				(observation) =>
					observation &&
					typeof observation === "object" &&
					typeof observation.value === "number" &&
					Number.isFinite(observation.value) &&
					validTimestamp(observation.at),
			)
			.map((observation) => ({
				at: observation.at,
				value: observation.value,
				...(typeof observation.sourceRef === "string" && observation.sourceRef.trim()
					? { sourceRef: observation.sourceRef.trim() }
					: {}),
				...(Array.isArray(observation.evidence)
					? { evidence: observation.evidence.filter((entry) => typeof entry === "string" && entry.trim()) }
					: {}),
			}))
			.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
	}

	function metricDelta(metric) {
		const observations = metricObservations(metric);
		if (observations.length < 2) return undefined;
		const previous = observations.at(-2).value;
		const current = observations.at(-1).value;
		const value = current - previous;
		let tone = "neutral";
		if (value !== 0 && metric.direction === "higher-is-better") tone = value > 0 ? "favorable" : "unfavorable";
		if (value !== 0 && metric.direction === "lower-is-better") tone = value < 0 ? "favorable" : "unfavorable";
		if (value !== 0 && metric.direction === "target" && typeof metric.target === "number") {
			tone = Math.abs(current - metric.target) < Math.abs(previous - metric.target) ? "favorable" : "unfavorable";
		}
		return Object.freeze({ value, previous, current, tone });
	}

	function latestMetricSource(metric) {
		const observations = metricObservations(metric);
		for (let index = observations.length - 1; index >= 0; index -= 1) {
			if (observations[index].sourceRef) return observations[index].sourceRef;
		}
		if (!Array.isArray(metric?.evidence)) return undefined;
		for (let index = metric.evidence.length - 1; index >= 0; index -= 1) {
			const evidence = metric.evidence[index];
			if (typeof evidence === "string" && evidence.trim() && !evidence.startsWith("connection-request:")) {
				return evidence.trim();
			}
		}
		return undefined;
	}

	function artifactSummary(artifact) {
		const metrics = Array.isArray(artifact?.metrics) ? artifact.metrics : [];
		const dataNeeds = Array.isArray(artifact?.dataNeeds) ? artifact.dataNeeds : [];
		const observedTimes = metrics.flatMap((metric) => {
			const timestamps = metricObservations(metric).map((observation) => observation.at);
			if (validTimestamp(metric?.observedAt)) timestamps.push(metric.observedAt);
			return timestamps;
		});
		const latestObservedAt = observedTimes.sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
		const sources = new Set();
		for (const need of dataNeeds) {
			for (const sourceRef of Array.isArray(need?.sourceRefs) ? need.sourceRefs : []) {
				if (typeof sourceRef === "string" && sourceRef.trim() && !sourceRef.startsWith("connection-request:")) {
					sources.add(sourceRef.trim());
				}
			}
		}
		for (const metric of metrics) {
			for (const observation of metricObservations(metric)) {
				if (observation.sourceRef) sources.add(observation.sourceRef);
			}
		}
		return Object.freeze({
			metricCount: metrics.length,
			measuredMetricCount: metrics.filter((metric) => metric?.value !== undefined && metric?.status !== "unknown").length,
			staleMetricCount: metrics.filter((metric) => metric?.status === "stale").length,
			blockedMetricCount: metrics.filter((metric) => metric?.status === "blocked").length,
			trendMetricCount: metrics.filter((metric) => metricObservations(metric).length >= 2).length,
			sourceCount: sources.size,
			latestObservedAt,
			unresolvedDataNeedCount: dataNeeds.filter(
				(need) => !["available", "declined"].includes(need?.status),
			).length,
		});
	}

	root.QorperaArtifactDashboard = Object.freeze({
		artifactSummary,
		latestMetricSource,
		metricDelta,
		metricObservations,
	});
})(globalThis);
