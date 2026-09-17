import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerGuestLayout,
	type CompanyComputerStateAdoptionInput,
	planCompanyComputerStateAdoption,
} from "@qorpera/contracts";
import { type LxdOfficeGuestBinding, parseLxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";
import type { OfficeInventoryEntry } from "./lxd-office-storage-inventory.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN = /(?:^|\/)(?:live|company-live|identity|credentials|\.codex|\.claude)(?:\/|$)/;
export interface LxdOfficeAdoptionItem {
	readonly destination: string;
	readonly kind: "directory" | "file";
	readonly mode: number;
	readonly source: Readonly<OfficeInventoryEntry> | null;
}
export interface LxdOfficeAdoptionPlan {
	readonly schema: "qorpera.lxd-office-adoption-plan/v1";
	readonly adoptionId: string;
	readonly observationSha256: string;
	readonly destinationName: string;
	readonly guestLayout: Readonly<CompanyComputerGuestLayout>;
	readonly items: readonly LxdOfficeAdoptionItem[];
	readonly quarantine: readonly string[];
	readonly screens: ReturnType<typeof planCompanyComputerStateAdoption>;
}
type Selection = { source: string; destination: string | null; role: "shared" | "screen" | "browser" | "quarantine" };
export function officeAdoptionRelativePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value) > 4096 ||
		/[\x00-\x1f\x7f\\\ufffd]/.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)
	)
		throw new Error("UNSAFE_OFFICE_ADOPTION_PATH");
	return value;
}
function beneath(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}
function freeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Compile an exhaustive reviewed mapping into a new private tree. Sources
 * remain in place; quarantine is an explicit exclusion from every admitted
 * surface. Nothing infers a screen owner or browser grant from a folder name.
 * The input is operator configuration, never a model/member filesystem tool. */
export function planLxdOfficeAdoption(
	value: unknown,
	bound: LxdOfficeGuestBinding,
	observation: LxdOfficeStorageObservation,
): Readonly<LxdOfficeAdoptionPlan> {
	const binding = parseLxdOfficeGuestBinding(bound);
	if (
		observation.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding) ||
		observation.allocationId !== binding.allocationId ||
		observation.inventory.root !== binding.workbenchSource ||
		!UUID.test(observation.intentId) ||
		!UUID.test(observation.hostBootId)
	)
		throw new Error("OFFICE_ADOPTION_OBSERVATION_MISMATCH");
	const input = officeRecord(value, ["schema", "adoptionId", "shared", "legacy", "quarantine"]);
	// Naming `company` (even as null) selects layout version 2: a fifth root for
	// company-owned kept state that the next generation carries the same way.
	const companyRoot = !!input.shared && typeof input.shared === "object" && "company" in input.shared;
	const shared = officeRecord(input.shared, ["workbench", "desktopHome", ...(companyRoot ? ["company"] : [])]);
	if (
		input.schema !== "qorpera.lxd-office-adoption-input/v1" ||
		typeof input.adoptionId !== "string" ||
		!UUID.test(input.adoptionId) ||
		!Array.isArray(input.quarantine) ||
		input.quarantine.length > 100000
	)
		throw new Error("INVALID_OFFICE_ADOPTION_INPUT");
	const destinationName = `.qorpera-adopted-${input.adoptionId}`;
	const root = binding.workbenchSource;
	const layout = (base: string): CompanyComputerGuestLayout => ({
		workbenchRoot: `${base}/${destinationName}/workbench`,
		desktopHome: `${base}/${destinationName}/desktop`,
		screenStateRoot: `${base}/${destinationName}/screens`,
		browserProfilesRoot: `${base}/${destinationName}/profiles`,
		...(companyRoot ? { companyRoot: `${base}/${destinationName}/company` } : {}),
	});
	const hostLayout = layout(root);
	const guestLayout = layout("/var/lib/qorpera-office");
	const entries = observation.inventory.entries;
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));
	if (
		byPath.size !== entries.length ||
		byPath.get(".")?.kind !== "directory" ||
		entries.length > 100000 ||
		entries.some((entry) => beneath(entry.path, destinationName))
	)
		throw new Error("OFFICE_ADOPTION_DESTINATION_OR_INVENTORY_INVALID");
	const selections: Selection[] = [];
	const selectedPaths = new Set<string>();
	const select = (source: unknown, destination: string | null, role: Selection["role"]) => {
		const path = officeAdoptionRelativePath(source);
		const entry = byPath.get(path);
		if (!entry || (destination !== null && entry.kind !== "directory"))
			throw new Error("OFFICE_ADOPTION_SOURCE_MISSING");
		if (selectedPaths.has(path)) throw new Error("AMBIGUOUS_OFFICE_ADOPTION_SOURCE");
		selectedPaths.add(path);
		selections.push({ source: path, destination, role });
	};
	if (shared.workbench !== null) select(shared.workbench, "workbench", "shared");
	if (shared.desktopHome !== null) select(shared.desktopHome, "desktop", "shared");
	if (companyRoot && shared.company !== null) select(shared.company, "company", "shared");
	let screens: ReturnType<typeof planCompanyComputerStateAdoption> = [];
	if (input.legacy !== null) {
		const legacy = officeRecord(input.legacy, ["roots", "mappings"]);
		const roots = officeRecord(legacy.roots, ["screenStateRoot", "browserProfilesRoot"]);
		if (!Array.isArray(legacy.mappings) || legacy.mappings.length > 32)
			throw new Error("INVALID_OFFICE_ADOPTION_MAPPINGS");
		const scope = {
			companyId: binding.companyId,
			environmentId: binding.environmentId,
			companyComputerId: binding.companyComputerId,
			logicalComputerId: binding.logicalComputerId,
		};
		const mappings = legacy.mappings.map((value) => {
			const row = officeRecord(value, ["legacy", "binding", "browserProfile"]);
			officeRecord(row.legacy, [...Object.keys(scope), "screenId", "staffAgentId", "screenOrdinal"]);
			const screen = officeRecord(row.binding, [
				...Object.keys(scope),
				"screenId",
				"staffAgentId",
				"screenOrdinal",
				"screenGeneration",
				"computerGeneration",
			]);
			if (screen.computerGeneration !== binding.computerGeneration)
				throw new Error("OFFICE_ADOPTION_SCREEN_GENERATION_MISMATCH");
			if (row.browserProfile !== null) officeRecord(row.browserProfile, ["profileId", "grantId", "version"]);
			return structuredClone(row) as unknown as CompanyComputerStateAdoptionInput["mappings"][number];
		});
		screens = planCompanyComputerStateAdoption({
			scope,
			layout: hostLayout,
			legacyRoots: {
				screenStateRoot: `${root}/${officeAdoptionRelativePath(roots.screenStateRoot)}`,
				browserProfilesRoot: `${root}/${officeAdoptionRelativePath(roots.browserProfilesRoot)}`,
			},
			mappings,
		});
		for (const screen of screens) {
			select(screen.desktop.source.slice(root.length + 1), `screens/${screen.binding.screenId}`, "screen");
			const source = screen.browser.source.slice(root.length + 1);
			if (screen.browser.disposition === "adopt")
				select(source, `profiles/${screen.browser.grant.profileId}`, "browser");
			else if (byPath.has(source)) select(source, null, "quarantine");
		}
	}
	for (const path of input.quarantine) select(path, null, "quarantine");
	const selectionByPath = new Map(selections.map((selection) => [selection.source, selection]));
	const structural = new Set<string>();
	for (const right of selections) {
		const parts = right.source.split("/");
		while (parts.length > 1) {
			parts.pop();
			const path = parts.join("/");
			structural.add(path);
			const left = selectionByPath.get(path);
			if (!left) continue;
			// An explicit quarantine may carve sensitive state out of a selected
			// tree. No other overlapping copy or grant can override that exclusion.
			if (left.destination === null || right.destination !== null)
				throw new Error("AMBIGUOUS_OFFICE_ADOPTION_SOURCE");
		}
	}
	const items = new Map<string, LxdOfficeAdoptionItem>();
	const add = (item: LxdOfficeAdoptionItem) => {
		officeAdoptionRelativePath(item.destination);
		if (items.has(item.destination)) {
			const previous = items.get(item.destination)!;
			if (previous.kind === "directory" && item.kind === "directory" && previous.source === null) {
				items.set(item.destination, item);
				return;
			}
			if (!isDeepStrictEqual(previous, item)) throw new Error("AMBIGUOUS_OFFICE_ADOPTION_DESTINATION");
			return;
		}
		items.set(item.destination, item);
	};
	for (const destination of ["workbench", "desktop", "screens", "profiles", ...(companyRoot ? ["company"] : [])])
		add({ destination, kind: "directory", mode: 0o700, source: null });
	for (const entry of entries) {
		if (entry.path === ".") continue;
		officeAdoptionRelativePath(entry.path);
		const parts = entry.path.split("/");
		let selection: Selection | undefined;
		while (parts.length) {
			selection = selectionByPath.get(parts.join("/"));
			if (selection) break;
			parts.pop();
		}
		if (selection?.destination === null) continue;
		if (!selection) {
			if (entry.kind === "directory" && structural.has(entry.path)) continue;
			throw new Error("UNREVIEWED_OFFICE_STORAGE");
		}
		if (FORBIDDEN.test(entry.path)) throw new Error("OFFICE_ADOPTION_SENSITIVE_STATE_REQUIRES_QUARANTINE");
		const destination = `${selection.destination}${entry.path.slice(selection.source.length)}`;
		add({
			destination,
			kind: entry.kind,
			mode: entry.kind === "directory" ? 0o700 : 0o600 | (entry.mode & 0o100),
			source: { ...entry },
		});
	}
	// Parent directories are explicit manifest entries; an executor never uses
	// recursive mkdir through an unverified path supplied by the legacy tree.
	for (const item of [...items.values()]) {
		const parts = item.destination.split("/");
		while (parts.length > 1) {
			parts.pop();
			const destination = parts.join("/");
			if (!items.has(destination)) add({ destination, kind: "directory", mode: 0o700, source: null });
			else if (items.get(destination)!.kind !== "directory")
				throw new Error("AMBIGUOUS_OFFICE_ADOPTION_DESTINATION");
		}
	}
	return freeze({
		schema: "qorpera.lxd-office-adoption-plan/v1",
		adoptionId: input.adoptionId,
		observationSha256: officeDigest(observation),
		destinationName,
		guestLayout,
		items: [...items.values()].sort(
			(a, b) =>
				a.destination.split("/").length - b.destination.split("/").length ||
				Buffer.compare(Buffer.from(a.destination), Buffer.from(b.destination)),
		),
		quarantine: selections
			.filter((selection) => selection.destination === null)
			.map((selection) => selection.source)
			.sort(),
		screens,
	});
}
