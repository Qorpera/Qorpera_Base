/* Pure routine-editor helpers. Kept separate from DOM wiring so interval and
 * run-history behavior can be covered without booting Electron. */
(function installRoutineEditorModel(root) {
	const unitMinutes = Object.freeze({ minutes: 1, hours: 60, days: 1_440, weekdays: 1_440, weeks: 10_080 });
	const minimumMinutes = 5;
	const maximumMinutes = 10_080;
	const intervalValueOptions = Object.freeze({
		minutes: Object.freeze([1, 2, 5, 10, 15, 20, 30, 45]),
		hours: Object.freeze([1, 2, 3, 4, 6, 8, 12, 24]),
		days: Object.freeze([1, 2, 3, 4, 5, 6, 7]),
		weekdays: Object.freeze([1]),
		weeks: Object.freeze([1]),
	});
	const weekdays = Object.freeze([
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	]);
	const weekdayPresets = Object.freeze({
		weekdays: Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday"]),
		weekends: Object.freeze(["sunday", "saturday"]),
		monday: Object.freeze(["monday"]),
		tuesday: Object.freeze(["tuesday"]),
		wednesday: Object.freeze(["wednesday"]),
		thursday: Object.freeze(["thursday"]),
		friday: Object.freeze(["friday"]),
		saturday: Object.freeze(["saturday"]),
		sunday: Object.freeze(["sunday"]),
	});

	function intervalParts(intervalMinutes) {
		const minutes = Number(intervalMinutes);
		if (!Number.isInteger(minutes) || minutes < minimumMinutes || minutes > maximumMinutes) {
			return { value: 1, unit: "hours" };
		}
		for (const unit of ["weeks", "days", "hours"]) {
			const factor = unitMinutes[unit];
			if (minutes % factor === 0) return { value: minutes / factor, unit };
		}
		return { value: minutes, unit: "minutes" };
	}

	function intervalMinutes(value, unit) {
		const factor = unitMinutes[unit];
		const amount = Number(value);
		if (!factor || !Number.isInteger(amount) || amount < 1) return undefined;
		const minutes = amount * factor;
		return minutes >= minimumMinutes && minutes <= maximumMinutes ? minutes : undefined;
	}

	function intervalOptions(unit) {
		return intervalValueOptions[unit] ?? intervalValueOptions.minutes;
	}

	function clockMinutes(value) {
		if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
		const [hour, minute] = value.split(":").map(Number);
		return hour * 60 + minute;
	}

	function validWeekdays(value) {
		return (
			value === undefined ||
			(Array.isArray(value) &&
				value.length >= 1 &&
				value.length <= weekdays.length &&
				new Set(value).size === value.length &&
				value.every((weekday) => weekdays.includes(weekday)))
		);
	}

	function validScheduleTrigger(trigger) {
		if (
			trigger?.kind !== "schedule" ||
			!Number.isInteger(trigger.intervalMinutes) ||
			trigger.intervalMinutes < minimumMinutes ||
			trigger.intervalMinutes > maximumMinutes
		) {
			return false;
		}
		const hasWindow =
			trigger.windowStart !== undefined || trigger.windowEnd !== undefined || trigger.months !== undefined;
		if (hasWindow) {
			const start = clockMinutes(trigger.windowStart);
			const end = clockMinutes(trigger.windowEnd);
			return (
				start !== undefined &&
				end !== undefined &&
				start <= end &&
				typeof trigger.timeZone === "string" &&
				Boolean(trigger.timeZone) &&
				trigger.timeZone !== "auto" &&
				(trigger.months === undefined ||
					(Array.isArray(trigger.months) &&
						trigger.months.length >= 1 &&
						trigger.months.length <= 12 &&
						new Set(trigger.months).size === trigger.months.length &&
						trigger.months.every((month) => Number.isInteger(month) && month >= 1 && month <= 12))) &&
				validWeekdays(trigger.weekdays)
			);
		}
		const weeklyFields = [trigger.weekdays, trigger.localTime, trigger.timeZone].filter(
			(value) => value !== undefined,
		).length;
		return (
			weeklyFields === 0 ||
			(weeklyFields === 3 &&
				validWeekdays(trigger.weekdays) &&
				clockMinutes(trigger.localTime) !== undefined &&
				typeof trigger.timeZone === "string" &&
				Boolean(trigger.timeZone))
		);
	}

	function scheduleTrigger(triggers) {
		return Array.isArray(triggers) ? triggers.find(validScheduleTrigger) : undefined;
	}

	function scheduleTriggers(triggers) {
		return Array.isArray(triggers) ? triggers.filter(validScheduleTrigger) : [];
	}

	function readyDraft(draft) {
		const triggers = Array.isArray(draft?.triggers) ? draft.triggers : [];
		return Boolean(
			draft?.title?.trim() &&
				draft?.prompt?.trim() &&
				triggers.length >= 1 &&
				triggers.length <= 12 &&
				scheduleTriggers(triggers).length === triggers.length,
		);
	}

	function weekdayInterval(trigger) {
		return Boolean(
			trigger?.kind === "schedule" &&
				trigger.intervalMinutes === unitMinutes.weekdays &&
				trigger.windowStart === undefined &&
				trigger.windowEnd === undefined &&
				trigger.months === undefined &&
				weekdayPreset(trigger.weekdays) === "weekdays" &&
				clockMinutes(trigger.localTime) !== undefined &&
				typeof trigger.timeZone === "string" &&
				Boolean(trigger.timeZone),
		);
	}

	function triggerMode(trigger) {
		if (weekdayInterval(trigger)) return "interval";
		return trigger?.windowStart !== undefined || trigger?.localTime !== undefined ? "advanced" : "interval";
	}

	function intervalLabel(interval, unit) {
		if (unit === "weekdays") return "Every weekday";
		const minutes = Number(interval);
		if (minutes === 60) return "Every hour";
		if (minutes === 1_440) return "Every day";
		if (minutes === 10_080) return "Every week";
		const parts = intervalParts(minutes);
		const singular = parts.value === 1 ? parts.unit.slice(0, -1) : parts.unit;
		return `Every ${parts.value} ${singular}`;
	}

	function weekdayPreset(value) {
		if (!Array.isArray(value) || value.length === 0 || value.length === weekdays.length) return "every";
		const normalized = weekdays.filter((weekday) => value.includes(weekday));
		for (const [preset, presetDays] of Object.entries(weekdayPresets)) {
			if (presetDays.length === normalized.length && presetDays.every((weekday) => normalized.includes(weekday))) {
				return preset;
			}
		}
		return normalized[0] ?? "every";
	}

	function weekdaysForPreset(preset) {
		if (preset === "every") return undefined;
		const value = weekdayPresets[preset];
		return value ? [...value] : undefined;
	}

	function routineRuns(sessions, jobId) {
		if (!jobId || !Array.isArray(sessions)) return [];
		return sessions
			.filter((session) => session?.scheduledJobId === jobId)
			.sort(
				(left, right) =>
					Number(right.startedAtMs ?? right.mtimeMs ?? 0) - Number(left.startedAtMs ?? left.mtimeMs ?? 0),
			);
	}

	function agentRoutineRuns(sessions, staffAgentId) {
		if (!staffAgentId || !Array.isArray(sessions)) return [];
		return sessions
			.filter(
				(session) =>
					session?.staffAgentId === staffAgentId &&
					typeof session?.scheduledJobId === "string",
			)
			.sort(
				(left, right) =>
					Number(right.startedAtMs ?? right.mtimeMs ?? 0) - Number(left.startedAtMs ?? left.mtimeMs ?? 0),
			);
	}

	root.qorperaRoutineEditorModel = Object.freeze({
		agentRoutineRuns,
		clockMinutes,
		intervalLabel,
		intervalMinutes,
		intervalOptions,
		intervalParts,
		maximumMinutes,
		minimumMinutes,
		readyDraft,
		routineRuns,
		scheduleTrigger,
		scheduleTriggers,
		triggerMode,
		unitMinutes,
		weekdayPreset,
		weekdayInterval,
		weekdays,
		weekdaysForPreset,
	});
})(globalThis);
