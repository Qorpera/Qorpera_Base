import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface RoutineEditorModel {
	agentRoutineRuns(
		sessions: Array<{ file: string; staffAgentId?: string; scheduledJobId?: string; startedAtMs?: number }>,
		staffAgentId: string,
	): Array<{ file: string }>;
	intervalMinutes(value: number, unit: string): number | undefined;
	intervalLabel(intervalMinutes: number, unit?: string): string;
	intervalOptions(unit: string): readonly number[];
	intervalParts(intervalMinutes: number): { value: number; unit: string };
	readyDraft(draft: { title: string; prompt: string; triggers: object[] }): boolean;
	routineRuns(
		sessions: Array<{ file: string; scheduledJobId?: string; startedAtMs?: number; mtimeMs?: number }>,
		jobId: string,
	): Array<{ file: string }>;
	triggerMode(trigger: object): "interval" | "advanced";
	weekdayInterval(trigger: object): boolean;
	weekdayPreset(value: string[] | undefined): string;
	weekdaysForPreset(value: string): string[] | undefined;
}

const userland = join(import.meta.dirname, "..", "userland");
const modelSource = readFileSync(join(userland, "routine-editor-model.js"), "utf-8");
const editorSource = readFileSync(join(userland, "routine-editor.js"), "utf-8");
const editorStyles = readFileSync(join(userland, "routine-editor.css"), "utf-8");
const indexSource = readFileSync(join(userland, "index.html"), "utf-8");

function loadModel(): RoutineEditorModel {
	const context: { qorperaRoutineEditorModel?: RoutineEditorModel } = {};
	runInNewContext(modelSource, context);
	if (!context.qorperaRoutineEditorModel) throw new Error("routine editor model was not installed");
	return context.qorperaRoutineEditorModel;
}

describe("agent routine editor", () => {
	it("converts editable intervals within the scheduler ceiling", () => {
		const model = loadModel();
		expect(model.intervalParts(60)).toEqual({ value: 1, unit: "hours" });
		expect(model.intervalParts(1_440)).toEqual({ value: 1, unit: "days" });
		expect(model.intervalParts(10_080)).toEqual({ value: 1, unit: "weeks" });
		expect(model.intervalParts(90)).toEqual({ value: 90, unit: "minutes" });
		expect(model.intervalMinutes(5, "minutes")).toBe(5);
		expect(model.intervalMinutes(2, "days")).toBe(2_880);
		expect(model.intervalMinutes(1, "weekdays")).toBe(1_440);
		expect(model.intervalMinutes(4, "minutes")).toBeUndefined();
		expect(model.intervalMinutes(2, "weeks")).toBeUndefined();
		expect(model.intervalOptions("minutes")).toEqual([1, 2, 5, 10, 15, 20, 30, 45]);
		expect(model.intervalOptions("weekdays")).toEqual([1]);
		expect(model.intervalLabel(30)).toBe("Every 30 minutes");
		expect(model.intervalLabel(1_440, "weekdays")).toBe("Every weekday");
	});

	it("requires the simple name, instruction, and interval contract", () => {
		const model = loadModel();
		const trigger = { id: "schedule", kind: "schedule", intervalMinutes: 60 };
		expect(model.readyDraft({ title: "", prompt: "Review cash", triggers: [trigger] })).toBe(false);
		expect(model.readyDraft({ title: "Cash review", prompt: "", triggers: [trigger] })).toBe(false);
		expect(model.readyDraft({ title: "Cash review", prompt: "Review cash", triggers: [] })).toBe(false);
		expect(model.readyDraft({ title: "Cash review", prompt: "Review cash", triggers: [trigger] })).toBe(true);
		expect(
			model.readyDraft({
				title: "Cash review",
				prompt: "Review cash",
				triggers: [trigger, { id: "schedule-2", kind: "schedule", intervalMinutes: 30 }],
			}),
		).toBe(true);
		expect(
			model.readyDraft({
				title: "Cash review",
				prompt: "Review cash",
				triggers: [trigger, { id: "github", kind: "github" }],
			}),
		).toBe(false);
	});

	it("models advanced calendar interval controls", () => {
		const model = loadModel();
		const advanced = {
			kind: "schedule",
			intervalMinutes: 30,
			months: [2, 5],
			weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
			windowStart: "09:00",
			windowEnd: "17:00",
			timeZone: "Europe/Copenhagen",
		};
		expect(model.triggerMode(advanced)).toBe("advanced");
		expect(advanced.months).toEqual([2, 5]);
		expect(model.weekdayPreset(advanced.weekdays)).toBe("weekdays");
		expect(model.weekdaysForPreset("weekends")).toEqual(["sunday", "saturday"]);
		expect(model.weekdaysForPreset("every")).toBeUndefined();
		expect(model.readyDraft({ title: "Cash review", prompt: "Review cash", triggers: [advanced] })).toBe(true);
		expect(
			model.readyDraft({
				title: "Cash review",
				prompt: "Review cash",
				triggers: [{ ...advanced, timeZone: "auto" }],
			}),
		).toBe(false);

		const weekdayInterval = {
			kind: "schedule",
			intervalMinutes: 1_440,
			weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
			localTime: "09:00",
			timeZone: "Europe/Copenhagen",
		};
		expect(model.weekdayInterval(weekdayInterval)).toBe(true);
		expect(model.triggerMode(weekdayInterval)).toBe("interval");
		expect(model.readyDraft({ title: "Cash review", prompt: "Review cash", triggers: [weekdayInterval] })).toBe(true);
	});

	it("shows only runs owned by the edited routine in newest-first order", () => {
		const model = loadModel();
		expect(
			model.routineRuns(
				[
					{ file: "old.jsonl", scheduledJobId: "routine-a", startedAtMs: 10 },
					{ file: "other.jsonl", scheduledJobId: "routine-b", startedAtMs: 30 },
					{ file: "new.jsonl", scheduledJobId: "routine-a", startedAtMs: 20 },
				],
				"routine-a",
			),
		).toEqual([
			{ file: "new.jsonl", scheduledJobId: "routine-a", startedAtMs: 20 },
			{ file: "old.jsonl", scheduledJobId: "routine-a", startedAtMs: 10 },
		]);
	});

	it("projects only an agent's own routine runs into that agent's chat", () => {
		const model = loadModel();
		expect(
			model.agentRoutineRuns(
				[
					{ file: "owned-new.jsonl", staffAgentId: "agent-a", scheduledJobId: "routine-a", startedAtMs: 30 },
					{ file: "other-agent.jsonl", staffAgentId: "agent-b", scheduledJobId: "routine-b", startedAtMs: 20 },
					{ file: "owned-old.jsonl", staffAgentId: "agent-a", scheduledJobId: "routine-a", startedAtMs: 10 },
				],
				"agent-a",
			),
		).toEqual([
			{ file: "owned-new.jsonl", staffAgentId: "agent-a", scheduledJobId: "routine-a", startedAtMs: 30 },
			{ file: "owned-old.jsonl", staffAgentId: "agent-a", scheduledJobId: "routine-a", startedAtMs: 10 },
		]);
	});

	it("loads after the base renderer and omits advanced execution and publishing controls", () => {
		expect(indexSource.indexOf("./routine-editor-model.js")).toBeGreaterThan(indexSource.indexOf("./renderer.js"));
		expect(indexSource.indexOf("./routine-editor.js")).toBeGreaterThan(
			indexSource.indexOf("./routine-editor-model.js"),
		);
		expect(indexSource).toContain('<img class="agent-bot-button-icon" src="./icon-bot.svg" alt="">');
		expect(editorSource).toContain("staffAgentId: staffId(staff)");
		expect(editorSource).toContain('trigger.timeZone === "auto"');
		expect(editorSource).toContain('textContent = "Run history"');
		expect(editorSource).toContain('placement: "cloud"');
		expect(editorSource).toContain('document.createTextNode("Add another")');
		expect(editorSource).toContain('if (parts.unit !== "minutes")');
		expect(editorSource).toContain('at.textContent = "at"');
		expect(editorSource).toContain('["from-now", "from now"]');
		expect(editorSource).toContain('"Interval anchor"');
		expect(editorSource.indexOf('["weekdays", "weekdays"]')).toBeLessThan(editorSource.indexOf('["weeks", "weeks"]'));
		expect(editorSource).toContain('className = "agent-routine-trigger-hover-remove"');
		expect(editorSource).toContain("editor.openTriggerId === trigger.id");
		expect(editorSource).toContain("editor.draft.triggers.filter");
		expect(editorSource).toContain('setEditorStatus(editor, "Add a trigger to save", "dirty")');
		expect(editorSource).not.toContain("schedules.length <= 1");
		expect(editorSource).toContain('className = "agent-routine-advanced-bound"');
		expect(editorSource).toContain('back.setAttribute("aria-label", open ? "Back to agent page"');
		expect(editorSource).toContain('routineIcon("./icon-bot.svg", "agent-bot-button-icon")');
		expect(editorSource).toContain('$("agentSidepanelBack").onclick = handleAgentSidepanelBack');
		expect(editorSource).toContain('open ? "Close agent panel" : "Close agent side panel"');
		expect(editorSource).not.toContain('close.textContent = open ? "\\u00bb"');
		expect(editorSource).toContain("closeAgentSidepanel(false);");
		expect(editorSource).not.toContain("baseCloseAgentSidepanel(false);");
		expect(editorSource).toContain('setAttribute("aria-multiselectable", "true")');
		expect(editorSource).toContain("monthSelectionLabel(selectedMonths)");
		expect(editorSource).toContain("trigger.months = values.map(Number)");
		expect(editorSource).toContain('setAttribute("aria-haspopup", "listbox")');
		expect(editorSource).toContain("document.body.appendChild(menu)");
		expect(editorSource).not.toContain('document.createElement("select")');
		expect(editorStyles).toContain("position: fixed;");
		expect(editorStyles).toContain(".agent-routine-select-menu");
		expect(editorStyles).toContain(":hover > .agent-routine-trigger-hover-remove");
		expect(editorStyles).toContain(".agent-routine-advanced-bound {\n\tdisplay: contents;");
		expect(editorSource).toContain('windowStart = "00:00"');
		expect(editorSource).toContain("model.agentRoutineRuns");
		expect(editorSource).toContain("run.scheduledJobPrompt || job.prompt");
		expect(editorSource).not.toContain("runScheduledJob");
		expect(editorSource).not.toContain("Test run");
		expect(editorSource).not.toContain("scheduledJobEffortSelect");
		expect(editorSource).not.toContain("scheduledJobPlacementSelect");
		expect(editorSource).not.toContain("scheduledJobPublicationEditor");
		expect(editorSource).not.toContain("GitHub event");
	});
});
