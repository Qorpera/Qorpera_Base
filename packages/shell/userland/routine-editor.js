/* Agent-owned interval routine editor. This final userland layer replaces the
 * earlier advanced job form while leaving its scheduler and future trigger
 * infrastructure intact. */
(function installRoutineEditor() {
	const model = globalThis.qorperaRoutineEditorModel;
	if (!model) throw new Error("routine editor model did not load");
	const routineEditorAssetBase = new URL(".", document.currentScript?.src || window.location.href);

	const baseOpenAgentRoutineEditor = openAgentRoutineEditor;
	const baseRenderAgentComputerPanel = renderAgentComputerPanel;
	const baseHandleAgentSidepanelBack = handleAgentSidepanelBack;
	const baseCloseAgentSidepanel = closeAgentSidepanel;
	const baseRefreshState = refreshState;
	const baseRenderHistory = renderHistory;
	let routineSelectMenu = null;
	let routineSelectTrigger = null;

	function syncRoutineTitlebar(open) {
		const titlebar = $("agentSidepanelTitlebar");
		const back = $("agentSidepanelBack");
		const close = $("agentSidepanelClose");
		if (!titlebar || !back || !close) return;
		titlebar.classList.toggle("routine-editor-titlebar", open);
		back.textContent = open ? "‹" : "←";
		back.setAttribute("aria-label", open ? "Back to agent page" : "Close agent side panel");
		if (open) close.replaceChildren(routineIcon("./icon-bot.svg", "agent-bot-button-icon"));
		else close.textContent = "\u00d7";
		close.setAttribute("aria-label", open ? "Close agent panel" : "Close agent side panel");
		close.classList.toggle("routine-close", open);
	}

	function currentRoutineJob(staff, editor) {
		return editor?.id ? agentRoutines(staff).find((candidate) => candidate.id === editor.id) : null;
	}

	function setEditorStatus(editor, message, kind = "") {
		editor.status = message;
		const status = document.querySelector(".agent-routine-editor .agent-routine-status");
		if (!status) return;
		status.textContent = message;
		status.dataset.kind = kind;
	}

	function setEditorError(editor, message) {
		editor.error = message;
		const error = document.querySelector(".agent-routine-editor .agent-routine-error");
		if (error) {
			error.textContent = message;
			error.hidden = !message;
		}
	}

	function routineChatResult(run) {
		if (typeof run.resultText === "string" && run.resultText.trim()) return run.resultText.trim();
		if (run.outcome === "running") return "Running…";
		if (run.outcome === "failed") {
			return [run.failureCause, run.failureGuidance, run.partialChangeSummary].filter(Boolean).join("\n\n");
		}
		if (run.outcome === "incomplete") {
			return run.partialChangeSummary || "This routine stopped before it finished.";
		}
		return "Routine completed.";
	}

	function routineChatEntry(job, run) {
		const entry = document.createElement("section");
		entry.className = "routine-chat-run";
		entry.dataset.routineRunFile = run.file;
		entry.dataset.messageTimestamp = String(sessionRunTime(run));

		const prompt = document.createElement("div");
		prompt.className = "msg user routine-chat-prompt";
		const promptLabel = document.createElement("small");
		promptLabel.textContent = `Routine · ${job.title || run.scheduledJobTitle || "Untitled"}`;
		const promptText = document.createElement("span");
		promptText.textContent = run.scheduledJobPrompt || job.prompt;
		prompt.append(promptLabel, promptText);

		const response = document.createElement("div");
		response.className = `msg assistant routine-chat-result is-${run.outcome || "running"}`;
		const responseMeta = document.createElement("small");
		const outcome = run.outcome || "running";
		responseMeta.textContent = `${TRAIL_OUTCOME_LABELS[outcome] ?? "Run"} · ${new Date(sessionRunTime(run)).toLocaleString([], {
			dateStyle: "medium",
			timeStyle: "short",
		})}`;
		const responseBody = document.createElement("div");
		responseBody.className = "routine-chat-result-body";
		renderMarkdown(responseBody, routineChatResult(run));
		const inspect = document.createElement("button");
		inspect.type = "button";
		inspect.textContent = "View run details";
		inspect.onclick = () => openRunInspection(run);
		response.append(responseMeta, responseBody, inspect);
		entry.append(prompt, response);
		return entry;
	}

	function renderRoutineChatRuns(scrollToLatest = false) {
		const messages = $("messages");
		if (!messages) return;
		const existingFiles = new Set(
			[...messages.querySelectorAll(":scope > .routine-chat-run")].map((entry) => entry.dataset.routineRunFile),
		);
		const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
		for (const entry of messages.querySelectorAll(":scope > .routine-chat-run")) entry.remove();
		if (!currentStaffId || currentRoomId || currentView !== "chat") return;

		const jobsById = new Map((state.scheduledJobs ?? []).map((job) => [job.id, job]));
		const runs = model.agentRoutineRuns(state.sessions, currentStaffId).slice(0, 12).reverse();
		let addedRun = false;
		for (const run of runs) {
			const job = jobsById.get(run.scheduledJobId) ?? {
				title: run.scheduledJobTitle || "Deleted routine",
				prompt: run.scheduledJobPrompt || "Routine instruction is no longer available.",
			};
			const entry = routineChatEntry(job, run);
			const runTime = sessionRunTime(run);
			const later = [...messages.children].find((candidate) => {
				const timestamp = Number(candidate.dataset.messageTimestamp);
				return Number.isFinite(timestamp) && timestamp > runTime;
			});
			if (later) messages.insertBefore(entry, later);
			else appendConversationEntry(entry);
			if (!existingFiles.has(run.file)) addedRun = true;
		}
		if ((scrollToLatest || (nearBottom && addedRun)) && runs.length) messages.scrollTop = messages.scrollHeight;
	}

	function editorSaveInput(staff, editor) {
		const triggers = editor.draft.triggers.map((trigger) =>
			trigger.kind === "schedule" && trigger.timeZone === "auto"
				? { ...trigger, timeZone: localTimeZone() }
				: trigger,
		);
		return {
			title: editor.draft.title.trim(),
			prompt: editor.draft.prompt.trim(),
			triggers,
			enabled: Boolean(editor.draft.enabled),
			placement: "cloud",
			staffAgentId: staffId(staff),
		};
	}

	async function persistRoutine(staff, editor, detached = false) {
		if ((!detached && agentRoutineEditor !== editor) || !model.readyDraft(editor.draft)) {
			return currentRoutineJob(staff, editor);
		}
		if (editor.savePromise) {
			editor.saveAgain = true;
			await editor.savePromise;
			return currentRoutineJob(staff, editor);
		}

		const revision = editor.revision;
		const job = currentRoutineJob(staff, editor);
		if (agentRoutineEditor === editor) {
			setEditorStatus(editor, "Saving\u2026", "saving");
			setEditorError(editor, "");
		}
		editor.saveAgain = false;
		editor.savePromise = scheduledJobRequest(
			() =>
				job
					? window.qorpera.updateScheduledJob(job.id, editorSaveInput(staff, editor))
					: window.qorpera.createScheduledJob(editorSaveInput(staff, editor)),
			"Could not save the routine.",
		);
		const result = await editor.savePromise;
		editor.savePromise = null;
		if (!result?.ok) {
			if (agentRoutineEditor === editor) {
				setEditorStatus(editor, "", "");
				setEditorError(editor, result?.error ?? "Could not save the routine.");
			}
			return null;
		}

		rememberScheduledJob(result.job);
		editor.mode = "edit";
		editor.id = result.job.id;
		if (editor.revision === revision) {
			editor.dirty = false;
			if (agentRoutineEditor === editor) setEditorStatus(editor, "Saved", "saved");
		} else {
			editor.saveAgain = true;
		}
		if (editor.saveAgain) {
			editor.saveAgain = false;
			return persistRoutine(staff, editor, detached || agentRoutineEditor !== editor);
		}
		return result.job;
	}

	function persistRoutineBeforeExit(editor) {
		if (!editor) return;
		if (editor.saveTimer) {
			clearTimeout(editor.saveTimer);
			editor.saveTimer = null;
		}
		const staff = currentStaff();
		if (
			staff &&
			editor.staffAgentId === staffId(staff) &&
			editor.dirty &&
			model.readyDraft(editor.draft)
		) {
			void persistRoutine(staff, editor, true);
		}
	}

	function queueRoutineSave(staff, editor, delay = 500) {
		editor.dirty = true;
		editor.revision += 1;
		setEditorError(editor, "");
		if (editor.saveTimer) clearTimeout(editor.saveTimer);
		if (!model.readyDraft(editor.draft)) {
			setEditorStatus(editor, "", "");
			return;
		}
		setEditorStatus(editor, "Unsaved changes", "dirty");
		editor.saveTimer = setTimeout(() => {
			editor.saveTimer = null;
			void persistRoutine(staff, editor);
		}, delay);
	}

	function routineRunStatus(run, job) {
		const outcome = displayedTrailOutcome(run, job?.running ? run.file : "");
		return TRAIL_OUTCOME_LABELS[outcome] ?? (outcome === "running" ? "Running" : "Run");
	}

	function renderRunHistory(form, staff, editor) {
		const section = document.createElement("section");
		section.className = "agent-routine-history";
		const title = document.createElement("h3");
		title.textContent = "Run history";
		section.appendChild(title);
		const job = currentRoutineJob(staff, editor);
		const runs = model.routineRuns(state.sessions, job?.id).slice(0, 8);
		if (!runs.length) {
			const empty = document.createElement("p");
			empty.textContent = "No runs yet";
			section.appendChild(empty);
		} else {
			for (const run of runs) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "agent-routine-history-row";
				const copy = document.createElement("span");
				const status = document.createElement("strong");
				status.textContent = routineRunStatus(run, job);
				const time = document.createElement("small");
				time.textContent = new Date(sessionRunTime(run)).toLocaleString([], {
					dateStyle: "medium",
					timeStyle: "short",
				});
				copy.append(status, time);
				const inspect = document.createElement("span");
				inspect.textContent = "View";
				button.append(copy, inspect);
				button.onclick = () => {
					closeAgentSidepanel(false);
					syncRoutineTitlebar(false);
					openRunInspection(run);
				};
				section.appendChild(button);
			}
		}
		form.appendChild(section);
	}

	function closeRoutineSelectMenu(restoreFocus = false) {
		const trigger = routineSelectTrigger;
		if (routineSelectMenu) routineSelectMenu.remove();
		routineSelectMenu = null;
		routineSelectTrigger = null;
		if (trigger) {
			trigger.setAttribute("aria-expanded", "false");
			trigger.removeAttribute("aria-controls");
			if (restoreFocus && trigger.isConnected) trigger.focus();
		}
		document.removeEventListener("pointerdown", handleRoutineSelectPointerDown, true);
		document.removeEventListener("keydown", handleRoutineSelectKeydown, true);
		window.removeEventListener("resize", handleRoutineSelectViewportChange);
		$("agentSidepanelContent")?.removeEventListener("scroll", handleRoutineSelectViewportChange);
	}

	function handleRoutineSelectPointerDown(event) {
		if (!routineSelectMenu || !routineSelectTrigger) return;
		if (routineSelectMenu.contains(event.target) || routineSelectTrigger.contains(event.target)) return;
		closeRoutineSelectMenu();
	}

	function handleRoutineSelectKeydown(event) {
		if (!routineSelectMenu) return;
		if (event.key === "Escape") {
			event.preventDefault();
			closeRoutineSelectMenu(true);
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const options = [...routineSelectMenu.querySelectorAll('[role="option"]:not(:disabled)')];
		if (!options.length) return;
		event.preventDefault();
		const active = options.indexOf(document.activeElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? options.length - 1
					: event.key === "ArrowUp"
						? (active - 1 + options.length) % options.length
						: (active + 1) % options.length;
		options[next].focus();
	}

	function handleRoutineSelectViewportChange() {
		closeRoutineSelectMenu();
	}

	function placeRoutineSelectMenu(menu, trigger) {
		const triggerRect = trigger.getBoundingClientRect();
		const sidepanelRect = $("agentSidepanel")?.getBoundingClientRect();
		const boundary =
			sidepanelRect && sidepanelRect.width > 0
				? sidepanelRect
				: { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0, width: window.innerWidth };
		const inset = 8;
		const gap = 5;
		const maximumWidth = Math.max(0, boundary.width - inset * 2);
		const width = Math.min(Math.max(198, triggerRect.width), maximumWidth);
		const left = Math.max(boundary.left + inset, Math.min(triggerRect.left, boundary.right - inset - width));
		menu.style.width = `${width}px`;
		menu.style.left = `${left}px`;
		const availableBelow = boundary.bottom - inset - triggerRect.bottom - gap;
		const availableAbove = triggerRect.top - boundary.top - inset - gap;
		const desiredHeight = Math.min(220, menu.scrollHeight);
		const openBelow = availableBelow >= Math.min(96, desiredHeight) || availableBelow >= availableAbove;
		const available = Math.max(0, openBelow ? availableBelow : availableAbove);
		const height = Math.min(desiredHeight, available);
		menu.style.maxHeight = `${height}px`;
		menu.style.top = `${
			openBelow
				? triggerRect.bottom + gap
				: Math.max(boundary.top + inset, triggerRect.top - gap - height)
		}px`;
		menu.dataset.placement = openBelow ? "below" : "above";
	}

	function setRoutineSelectOptionSelected(option, selected) {
		option.setAttribute("aria-selected", String(selected));
		option.classList.toggle("selected", selected);
		const check = option.querySelector(".agent-routine-select-check");
		if (selected && !check) option.appendChild(routineIcon("./icon-check.svg", "agent-routine-select-check"));
		else if (!selected) check?.remove();
	}

	function openRoutineSelectMenu(trigger, ariaLabel, options, value, onChange, multiple = false) {
		if (routineSelectTrigger === trigger) {
			closeRoutineSelectMenu(true);
			return;
		}
		closeRoutineSelectMenu();
		const selectedValues = new Set((Array.isArray(value) ? value : [value]).map(String));
		if (multiple && !selectedValues.size) selectedValues.add("any");
		const menu = document.createElement("div");
		menu.id = "agentRoutineSelectMenu";
		menu.className = "agent-routine-select-menu";
		menu.setAttribute("role", "listbox");
		menu.setAttribute("aria-label", `${ariaLabel} options`);
		if (multiple) menu.setAttribute("aria-multiselectable", "true");
		for (const [candidate, label, disabled = false] of options) {
			const candidateValue = String(candidate);
			const option = document.createElement("button");
			option.type = "button";
			option.className = "agent-routine-select-option";
			option.setAttribute("role", "option");
			option.disabled = disabled;
			const text = document.createElement("span");
			text.textContent = label;
			option.appendChild(text);
			setRoutineSelectOptionSelected(option, selectedValues.has(candidateValue));
			option.onclick = (event) => {
				event.stopPropagation();
				if (multiple) {
					if (candidateValue === "any") {
						selectedValues.clear();
						selectedValues.add("any");
					} else {
						selectedValues.delete("any");
						if (selectedValues.has(candidateValue)) selectedValues.delete(candidateValue);
						else selectedValues.add(candidateValue);
						if (!selectedValues.size) selectedValues.add("any");
					}
					for (const candidateOption of menu.querySelectorAll('[role="option"]')) {
						setRoutineSelectOptionSelected(
							candidateOption,
							selectedValues.has(candidateOption.dataset.value),
						);
					}
					const nextValues = options
						.map(([nextCandidate]) => String(nextCandidate))
						.filter((nextCandidate) => nextCandidate !== "any" && selectedValues.has(nextCandidate));
					trigger.dataset.value = JSON.stringify(nextValues);
					const nextLabel = onChange(nextValues);
					trigger.querySelector(".agent-routine-select-value").textContent = nextLabel;
					trigger.title = nextLabel;
					return;
				}
				trigger.dataset.value = candidateValue;
				trigger.querySelector(".agent-routine-select-value").textContent = label;
				closeRoutineSelectMenu();
				onChange(candidateValue);
				if (trigger.isConnected) trigger.focus();
			};
			option.dataset.value = candidateValue;
			menu.appendChild(option);
		}
		document.body.appendChild(menu);
		routineSelectMenu = menu;
		routineSelectTrigger = trigger;
		trigger.setAttribute("aria-expanded", "true");
		trigger.setAttribute("aria-controls", menu.id);
		placeRoutineSelectMenu(menu, trigger);
		document.addEventListener("pointerdown", handleRoutineSelectPointerDown, true);
		document.addEventListener("keydown", handleRoutineSelectKeydown, true);
		window.addEventListener("resize", handleRoutineSelectViewportChange);
		$("agentSidepanelContent")?.addEventListener("scroll", handleRoutineSelectViewportChange);
		(menu.querySelector('.selected:not(:disabled)') ?? menu.querySelector('[role="option"]:not(:disabled)'))?.focus();
	}

	function routineSelect(ariaLabel, options, value, onChange, selectedLabel) {
		const selected = options.find(([candidate]) => String(candidate) === String(value)) ?? options[0];
		const control = document.createElement("button");
		control.type = "button";
		control.className = "agent-routine-select";
		control.dataset.value = String(selected[0]);
		control.setAttribute("aria-label", ariaLabel);
		control.setAttribute("aria-haspopup", "listbox");
		control.setAttribute("aria-expanded", "false");
		const label = document.createElement("span");
		label.className = "agent-routine-select-value";
		label.textContent = selectedLabel ?? selected[1];
		control.append(label, routineIcon("./icon-chevron-down.svg", "agent-routine-select-chevron"));
		control.onclick = (event) => {
			event.stopPropagation();
			openRoutineSelectMenu(control, ariaLabel, options, control.dataset.value, onChange);
		};
		return control;
	}

	function routineMultiSelect(ariaLabel, options, values, selectedLabel, onChange) {
		const control = document.createElement("button");
		control.type = "button";
		control.className = "agent-routine-select";
		control.dataset.value = JSON.stringify(values);
		control.setAttribute("aria-label", ariaLabel);
		control.setAttribute("aria-haspopup", "listbox");
		control.setAttribute("aria-expanded", "false");
		control.title = selectedLabel;
		const label = document.createElement("span");
		label.className = "agent-routine-select-value";
		label.textContent = selectedLabel;
		control.append(label, routineIcon("./icon-chevron-down.svg", "agent-routine-select-chevron"));
		control.onclick = (event) => {
			event.stopPropagation();
			const selected = JSON.parse(control.dataset.value);
			openRoutineSelectMenu(control, ariaLabel, options, selected, onChange, true);
		};
		return control;
	}

	function rerenderRoutineEditor(staff) {
		closeRoutineSelectMenu();
		const content = $("agentSidepanelContent");
		const scrollTop = content?.scrollTop ?? 0;
		renderAgentComputerPanel(staff, true);
		if (content) content.scrollTop = scrollTop;
	}

	function intervalAmountOptions(parts) {
		const values = [...new Set([...model.intervalOptions(parts.unit), parts.value])].sort((left, right) => left - right);
		return values.map((value) => [
			value,
			String(value),
			model.intervalMinutes(value, parts.unit) === undefined,
		]);
	}

	function localTimeZone() {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	}

	function localClockValue(date = new Date()) {
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}

	function monthSelectionLabel(values) {
		if (!values.length) return "Any month";
		const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		return values.map((value) => labels[Number(value) - 1]).filter(Boolean).join(", ");
	}

	function nextIntervalAnchor(value, unit, now = new Date()) {
		const candidate = new Date(now);
		candidate.setSeconds(0, 0);
		if (value.startsWith("minute:")) {
			candidate.setMinutes(Number(value.slice("minute:".length)));
			if (candidate.getTime() <= now.getTime()) candidate.setHours(candidate.getHours() + 1);
			return candidate.toISOString();
		}
		if (!value.startsWith("time:")) return undefined;
		const [hour, minute] = value.slice("time:".length).split(":").map(Number);
		candidate.setHours(hour, minute, 0, 0);
		if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + (unit === "weeks" ? 7 : 1));
		return candidate.toISOString();
	}

	function intervalAnchorOptions(unit) {
		const options = [["from-now", "from now"]];
		if (unit === "minutes" || unit === "hours") {
			for (let minute = 0; minute < 60; minute += 5) {
				const value = String(minute).padStart(2, "0");
				options.push([`minute:${value}`, `:${value}`]);
			}
			return options;
		}
		for (let minute = 0; minute < 24 * 60; minute += 30) {
			const value = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
			options.push([`time:${value}`, formattedTime(value)]);
		}
		return options;
	}

	function intervalAnchorValue(trigger, unit) {
		if (!trigger.startAt) return "from-now";
		if (unit === "weekdays" && model.clockMinutes(trigger.localTime) !== undefined) {
			return `time:${trigger.localTime}`;
		}
		const anchor = new Date(trigger.startAt);
		if (!Number.isFinite(anchor.getTime())) return "from-now";
		if (unit === "minutes" || unit === "hours") {
			return `minute:${String(anchor.getMinutes()).padStart(2, "0")}`;
		}
		return `time:${localClockValue(anchor)}`;
	}

	function updateIntervalAnchor(staff, editor, trigger, unit, value) {
		if (value === "from-now") {
			delete trigger.startAt;
			if (unit === "weekdays") {
				trigger.localTime = localClockValue();
				trigger.timeZone = localTimeZone();
			}
		} else {
			const startAt = nextIntervalAnchor(value, unit);
			if (!startAt) return;
			trigger.startAt = startAt;
			if (unit === "weekdays" && value.startsWith("time:")) {
				trigger.localTime = value.slice("time:".length);
				trigger.timeZone = localTimeZone();
			}
		}
		queueRoutineSave(staff, editor, 200);
	}

	function updateTriggerInterval(staff, editor, trigger, value, unit, rerender = false) {
		const minutes = model.intervalMinutes(Number(value), unit);
		if (!minutes) {
			setEditorError(editor, "Choose an interval between 5 minutes and 7 days.");
			return;
		}
		const wasWeekdayInterval = model.weekdayInterval(trigger);
		trigger.intervalMinutes = minutes;
		if (unit === "minutes") delete trigger.startAt;
		if (unit === "weekdays") {
			const anchor = trigger.startAt ? new Date(trigger.startAt) : new Date();
			delete trigger.months;
			delete trigger.windowStart;
			delete trigger.windowEnd;
			trigger.weekdays = model.weekdaysForPreset("weekdays");
			trigger.localTime = localClockValue(anchor);
			trigger.timeZone = localTimeZone();
		} else if (wasWeekdayInterval) {
			delete trigger.weekdays;
			delete trigger.localTime;
			delete trigger.timeZone;
		}
		queueRoutineSave(staff, editor, 200);
		if (rerender) rerenderRoutineEditor(staff);
	}

	function renderIntervalControls(container, staff, editor, trigger) {
		const controls = document.createElement("div");
		controls.className = "agent-routine-interval-controls";
		const parts = model.weekdayInterval(trigger)
			? { value: 1, unit: "weekdays" }
			: model.intervalParts(trigger.intervalMinutes);
		if (parts.unit === "minutes" && trigger.startAt) {
			delete trigger.startAt;
			queueRoutineSave(staff, editor, 0);
		}
		const mode = routineSelect(
			"Schedule type",
			[
				["interval", "Interval"],
				["advanced", "Advanced"],
			],
			"interval",
			(value) => {
				if (value !== "advanced") return;
				delete trigger.startAt;
				delete trigger.localTime;
				delete trigger.months;
				delete trigger.weekdays;
				trigger.windowStart = "00:00";
				trigger.windowEnd = "23:00";
				trigger.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
				queueRoutineSave(staff, editor, 0);
				rerenderRoutineEditor(staff);
			},
		);
		const every = document.createElement("span");
		every.textContent = "every";
		const amount = routineSelect("Interval amount", intervalAmountOptions(parts), parts.value, (value) => {
			updateTriggerInterval(staff, editor, trigger, value, parts.unit, true);
		});
		amount.hidden = parts.unit === "weekdays";
		const selectedUnitLabel =
			parts.value === 1
				? { hours: "hour", days: "day", weekdays: "weekday", weeks: "week" }[parts.unit]
				: undefined;
		const unit = routineSelect(
			"Interval unit",
			[
				["minutes", "minutes"],
				["hours", "hours"],
				["days", "days"],
				["weekdays", "weekdays"],
				["weeks", "weeks"],
			],
			parts.unit,
			(value) => {
				const candidate = model.intervalMinutes(parts.value, value);
				const nextValue = candidate
					? parts.value
					: model.intervalOptions(value).find((option) => model.intervalMinutes(option, value) !== undefined);
				updateTriggerInterval(staff, editor, trigger, nextValue, value, true);
			},
			selectedUnitLabel,
		);
		controls.append(mode, every, amount, unit);
		if (parts.unit !== "minutes") {
			const at = document.createElement("span");
			at.textContent = "at";
			const anchor = routineSelect(
				"Interval anchor",
				intervalAnchorOptions(parts.unit),
				intervalAnchorValue(trigger, parts.unit),
				(value) => updateIntervalAnchor(staff, editor, trigger, parts.unit, value),
			);
			const anchorControl = document.createElement("span");
			anchorControl.className = "agent-routine-anchor-control";
			anchorControl.append(at, anchor);
			controls.append(anchorControl);
		}
		container.appendChild(controls);
	}

	function formattedTime(value) {
		const minutes = model.clockMinutes(value) ?? 0;
		const hour = Math.floor(minutes / 60);
		const minute = minutes % 60;
		return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
	}

	function timeOptions(startAt = "00:00") {
		const minimum = model.clockMinutes(startAt) ?? 0;
		const options = [];
		for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
			const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
			options.push([value, formattedTime(value), minutes < minimum]);
		}
		return options;
	}

	function renderAdvancedControls(container, staff, editor, trigger) {
		const priorLocalTime = trigger.localTime;
		if (!trigger.windowStart || !trigger.windowEnd) {
			delete trigger.startAt;
			delete trigger.localTime;
			trigger.windowStart = priorLocalTime || "00:00";
			trigger.windowEnd = priorLocalTime || "23:00";
			trigger.timeZone =
				trigger.timeZone && trigger.timeZone !== "auto"
					? trigger.timeZone
					: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		}

		const mode = routineSelect(
			"Schedule type",
			[
				["interval", "Interval"],
				["advanced", "Advanced"],
			],
			"advanced",
			(value) => {
				if (value !== "interval") return;
				delete trigger.months;
				delete trigger.weekdays;
				delete trigger.localTime;
				delete trigger.windowStart;
				delete trigger.windowEnd;
				delete trigger.timeZone;
				queueRoutineSave(staff, editor, 0);
				rerenderRoutineEditor(staff);
			},
		);
		mode.className = "agent-routine-trigger-mode";
		container.appendChild(mode);

		const monthRow = document.createElement("label");
		monthRow.className = "agent-routine-advanced-row";
		monthRow.appendChild(document.createTextNode("Months"));
		const monthOptions = [["any", "Any month"]];
		for (const [index, label] of [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		].entries()) {
			monthOptions.push([String(index + 1), label]);
		}
		const selectedMonths = trigger.months?.map(String) ?? [];
		monthRow.appendChild(
			routineMultiSelect("Months", monthOptions, selectedMonths, monthSelectionLabel(selectedMonths), (values) => {
				if (values.length) trigger.months = values.map(Number);
				else delete trigger.months;
				queueRoutineSave(staff, editor, 200);
				return monthSelectionLabel(values);
			}),
		);

		const dayRow = document.createElement("label");
		dayRow.className = "agent-routine-advanced-row";
		dayRow.appendChild(document.createTextNode("Days"));
		dayRow.appendChild(
			routineSelect(
				"Days",
				[
					["every", "Every day"],
					["weekdays", "Weekdays"],
					["weekends", "Weekends"],
					["monday", "Every Monday"],
					["tuesday", "Every Tuesday"],
					["wednesday", "Every Wednesday"],
					["thursday", "Every Thursday"],
					["friday", "Every Friday"],
					["saturday", "Every Saturday"],
					["sunday", "Every Sunday"],
				],
				model.weekdayPreset(trigger.weekdays),
				(value) => {
					const next = model.weekdaysForPreset(value);
					if (next) trigger.weekdays = next;
					else delete trigger.weekdays;
					queueRoutineSave(staff, editor, 200);
				},
			),
		);

		const timeRow = document.createElement("label");
		timeRow.className = "agent-routine-advanced-row time-frequency";
		timeRow.appendChild(document.createTextNode("Time"));
		const timeControls = document.createElement("span");
		const every = routineSelect("Time frequency", [["every", "Every"]], "every", () => undefined);
		const intervalParts = model.intervalParts(trigger.intervalMinutes);
		const parts =
			intervalParts.unit === "weeks" ? { value: intervalParts.value * 7, unit: "days" } : intervalParts;
		const amount = routineSelect("Interval amount", intervalAmountOptions(parts), parts.value, (value) => {
			updateTriggerInterval(staff, editor, trigger, value, parts.unit);
		});
		const unit = routineSelect(
			"Interval unit",
			[
				["minutes", "minutes"],
				["hours", "hours"],
				["days", "days"],
			],
			parts.unit,
			(value) => {
				const candidate = model.intervalMinutes(parts.value, value);
				const nextValue = candidate
					? parts.value
					: model.intervalOptions(value).find((option) => model.intervalMinutes(option, value) !== undefined);
				updateTriggerInterval(staff, editor, trigger, nextValue, value, true);
			},
		);
		timeControls.append(every, amount, unit);
		timeRow.appendChild(timeControls);

		const windowRow = document.createElement("div");
		windowRow.className = "agent-routine-advanced-window";
		const between = document.createElement("span");
		between.textContent = "between";
		const start = routineSelect("Start time", timeOptions(), trigger.windowStart, (value) => {
			trigger.windowStart = value;
			if ((model.clockMinutes(trigger.windowEnd) ?? 0) < (model.clockMinutes(value) ?? 0)) trigger.windowEnd = value;
			queueRoutineSave(staff, editor, 200);
			rerenderRoutineEditor(staff);
		});
		const and = document.createElement("span");
		and.textContent = "and";
		const end = routineSelect("End time", timeOptions(trigger.windowStart), trigger.windowEnd, (value) => {
			trigger.windowEnd = value;
			queueRoutineSave(staff, editor, 200);
		});
		const startBound = document.createElement("span");
		startBound.className = "agent-routine-advanced-bound";
		startBound.append(between, start);
		const endBound = document.createElement("span");
		endBound.className = "agent-routine-advanced-bound";
		endBound.append(and, end);
		windowRow.append(startBound, endBound);
		container.append(monthRow, dayRow, timeRow, windowRow);
	}

	function renderTriggerEditor(item, staff, editor, trigger) {
		const panel = document.createElement("div");
		panel.className = `agent-routine-trigger-editor is-${model.triggerMode(trigger)}`;
		if (model.triggerMode(trigger) === "advanced") renderAdvancedControls(panel, staff, editor, trigger);
		else renderIntervalControls(panel, staff, editor, trigger);
		item.appendChild(panel);
	}

	function routineIcon(source, className) {
		const icon = document.createElement("img");
		icon.src = new URL(source, routineEditorAssetBase).href;
		icon.alt = "";
		icon.className = className;
		return icon;
	}

	function renderIntervalTrigger(form, staff, editor) {
		const section = document.createElement("section");
		section.className = "agent-routine-triggers interval-only";
		const title = document.createElement("span");
		title.textContent = "When to run";
		section.appendChild(title);
		const schedules = editor.draft.triggers.filter((trigger) => trigger.kind === "schedule");
		const list = document.createElement("div");
		list.className = `agent-routine-trigger-list${schedules.length ? "" : " is-empty"}`;
		if (!schedules.length) {
			const add = document.createElement("button");
			add.type = "button";
			add.className = "agent-routine-add-trigger";
			add.append(routineIcon("./icon-plus.svg", "agent-routine-add-icon"), document.createTextNode("Add trigger"));
			add.onclick = () => {
				editor.draft.triggers.push({ id: crypto.randomUUID(), kind: "schedule", intervalMinutes: 30 });
				editor.openTriggerId = null;
				queueRoutineSave(staff, editor, 0);
				rerenderRoutineEditor(staff);
			};
			list.appendChild(add);
		} else {
			for (const trigger of schedules) {
				const intervalLabel = model.intervalLabel(
					trigger.intervalMinutes,
					model.weekdayInterval(trigger) ? "weekdays" : undefined,
				);
				const item = document.createElement("div");
				item.className = "agent-routine-trigger-item";
				const summary = document.createElement("button");
				summary.type = "button";
				summary.className = "agent-routine-trigger-summary";
				summary.setAttribute("aria-expanded", String(editor.openTriggerId === trigger.id));
				summary.append(
					routineIcon("./icon-clock.svg", "agent-routine-summary-icon"),
					document.createTextNode(intervalLabel),
				);
				summary.onclick = () => {
					editor.openTriggerId = editor.openTriggerId === trigger.id ? null : trigger.id;
					rerenderRoutineEditor(staff);
				};
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "agent-routine-trigger-hover-remove";
				remove.setAttribute("aria-label", `Remove ${intervalLabel} trigger`);
				remove.title = "Remove trigger";
				remove.appendChild(routineIcon("./icon-x.svg", "agent-routine-trigger-remove-icon"));
				remove.onclick = (event) => {
					event.stopPropagation();
					editor.draft.triggers = editor.draft.triggers.filter((candidate) => candidate.id !== trigger.id);
					editor.openTriggerId = null;
					queueRoutineSave(staff, editor, 0);
					if (!editor.draft.triggers.length) setEditorStatus(editor, "Add a trigger to save", "dirty");
					rerenderRoutineEditor(staff);
				};
				item.append(summary, remove);
				if (editor.openTriggerId === trigger.id) {
					renderTriggerEditor(item, staff, editor, trigger);
				}
				list.appendChild(item);
			}
			const addAnother = document.createElement("button");
			addAnother.type = "button";
			addAnother.className = "agent-routine-add-another";
			addAnother.disabled = schedules.length >= 12;
			addAnother.append(
				routineIcon("./icon-plus.svg", "agent-routine-add-icon"),
				document.createTextNode("Add another"),
			);
			addAnother.onclick = () => {
				editor.draft.triggers.push({ id: crypto.randomUUID(), kind: "schedule", intervalMinutes: 30 });
				editor.openTriggerId = null;
				queueRoutineSave(staff, editor, 0);
				rerenderRoutineEditor(staff);
			};
			list.appendChild(addAnother);
		}
		section.appendChild(list);
		form.appendChild(section);
	}

	renderAgentRoutineEditor = function renderSimpleAgentRoutineEditor(content, staff) {
		closeRoutineSelectMenu();
		const editor = agentRoutineEditor;
		if (!editor || editor.staffAgentId !== staffId(staff)) {
			agentRoutineEditor = null;
			renderAgentComputerPanel(staff, true);
			return;
		}
		if (editor.mode === "edit" && !currentRoutineJob(staff, editor)) {
			agentRoutineEditor = null;
			$("agentSidepanelTitle").textContent = staffDisplayName(staff);
			renderAgentComputerPanel(staff, true);
			return;
		}
		editor.revision ??= 0;
		editor.savePromise ??= null;
		editor.saveAgain ??= false;
		editor.saveTimer ??= null;
		editor.openTriggerId ??= null;

		const section = document.createElement("section");
		section.className = "agent-routine-editor";
		const form = document.createElement("form");
		form.className = "agent-routine-form simple";
		form.onsubmit = (event) => event.preventDefault();

		const toolbar = document.createElement("div");
		toolbar.className = "agent-routine-toolbar";
		const active = document.createElement("label");
		active.className = "agent-routine-active";
		const enabled = document.createElement("input");
		enabled.type = "checkbox";
		enabled.checked = editor.draft.enabled;
		enabled.onchange = () => {
			editor.draft.enabled = enabled.checked;
			queueRoutineSave(staff, editor, 0);
		};
		const switchTrack = document.createElement("span");
		switchTrack.className = "agent-routine-switch";
		active.append(enabled, switchTrack, document.createTextNode("Active"));
		const toolbarActions = document.createElement("div");
		toolbarActions.className = "agent-routine-toolbar-actions";
		const remove = document.createElement("button");
		remove.type = "button";
		remove.textContent = "Delete";
		remove.onclick = async () => {
			const job = currentRoutineJob(staff, editor);
			if (!job) {
				handleAgentSidepanelBack();
				return;
			}
			editor.pending = true;
			remove.disabled = true;
			const result = await scheduledJobRequest(
				() => window.qorpera.deleteScheduledJob(job.id),
				"Could not delete the routine.",
			);
			editor.pending = false;
			if (result?.ok) {
				forgetScheduledJob(job.id);
				handleAgentSidepanelBack();
				return;
			}
			remove.disabled = false;
			setEditorError(editor, result?.error ?? "Could not delete the routine.");
		};
		toolbarActions.append(remove);
		toolbar.append(active, toolbarActions);
		form.appendChild(toolbar);

		const title = document.createElement("input");
		title.type = "text";
		title.maxLength = 160;
		title.placeholder = "Name this routine";
		title.value = editor.draft.title;
		title.oninput = () => {
			editor.draft.title = title.value;
			queueRoutineSave(staff, editor);
		};
		title.onblur = () => void persistRoutine(staff, editor);
		form.appendChild(agentRoutineField("Name", title));

		const instruction = document.createElement("textarea");
		instruction.maxLength = 32_768;
		instruction.placeholder = "What should this routine do each time it runs?";
		instruction.value = editor.draft.prompt;
		instruction.oninput = () => {
			editor.draft.prompt = instruction.value;
			queueRoutineSave(staff, editor);
		};
		instruction.onblur = () => void persistRoutine(staff, editor);
		form.appendChild(agentRoutineField("Instruction", instruction));

		renderIntervalTrigger(form, staff, editor);
		renderRunHistory(form, staff, editor);

		const error = document.createElement("div");
		error.className = "agent-routine-error";
		error.textContent = editor.error;
		error.hidden = !editor.error;
		form.appendChild(error);
		const status = document.createElement("div");
		status.className = "agent-routine-status";
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		status.textContent = editor.status;
		form.appendChild(status);
		section.appendChild(form);
		content.appendChild(section);
		syncRoutineTitlebar(true);
	};

	openAgentRoutineEditor = function openSimpleAgentRoutineEditor(staff, job = null) {
		baseOpenAgentRoutineEditor(staff, job);
		syncRoutineTitlebar(true);
	};

	renderAgentComputerPanel = function renderSimpleAgentComputerPanel(staff, force = false) {
		baseRenderAgentComputerPanel(staff, force);
		if (agentRoutineEditor) {
			syncRoutineTitlebar(true);
			return;
		}
		syncRoutineTitlebar(false);
		const empty = document.querySelector(".agent-routines-empty p");
		if (empty) empty.textContent = "Routines are recurring tasks this agent runs in its chat at a set interval.";
	};

	handleAgentSidepanelBack = function handleSimpleAgentSidepanelBack() {
		closeRoutineSelectMenu();
		const editor = agentRoutineEditor;
		persistRoutineBeforeExit(editor);
		baseHandleAgentSidepanelBack();
		syncRoutineTitlebar(false);
	};

	closeAgentSidepanel = function closeSimpleAgentSidepanel(restoreFocus = true) {
		closeRoutineSelectMenu();
		const editor = agentRoutineEditor;
		persistRoutineBeforeExit(editor);
		baseCloseAgentSidepanel(restoreFocus);
		syncRoutineTitlebar(false);
	};

	refreshState = async function refreshRoutineState() {
		await baseRefreshState();
		renderRoutineChatRuns();
	};

	renderHistory = function renderHistoryWithRoutineRuns(messages) {
		baseRenderHistory(messages);
		renderRoutineChatRuns(true);
	};

	$("agentSidepanelBack").onclick = handleAgentSidepanelBack;
})();
