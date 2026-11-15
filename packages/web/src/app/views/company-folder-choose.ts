import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { CompanyFolderBrowser, type CompanyFolderPick, type CompanyFolderSource } from "./company-folder.ts";

/** Open's "A file…" on an agent's computer (20260930758000): the company folder's own browser, in its choose mode, in a
 * dialog. The member picks one file, or goes into one folder, and presses "Open on this computer": that path is the
 * answer. Cancel, Escape, a click beside it, or the owner's signal (the window closing) answer null. The folder is read as
 * the member, and only read: choose mode reaches nothing that changes it. */
export function chooseInCompanyFolder(
	source: Pick<CompanyFolderSource, "signal" | "current" | "folder" | "folderHints">,
	signal: AbortSignal,
): Promise<string | null> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(null);
			return;
		}
		let pick: CompanyFolderPick | null = null;
		let chosen: string | null = null;
		/** Until the folder's top is read, the line says so (the browser's own words are for screen readers); a read that
		 * failed says so above it, and the line is quiet. */
		let phase: "opening" | "open" | "failed" = "opening";
		const stop = new AbortController();
		const lifetime = AbortSignal.any([source.signal, signal, stop.signal]);
		const host = h("div", { class: "folder-choose-browser" });
		const line = h("p", { class: "folder-choose-pick", role: "status" });
		const confirm = button(
			t("Open on this computer"),
			() => {
				if (!pick) return;
				chosen = pick.path;
				dialog.close();
			},
			{ primary: true, disabled: true },
		);
		const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
		const draw = () => {
			line.textContent =
				phase === "opening"
					? t("Opening Company File")
					: phase === "failed"
						? ""
						: !pick
							? t("Pick a file, or go into a folder to open it.")
							: pick.kind === "file"
								? t("Opens {name}.", { name: name(pick.path) })
								: t("Opens the folder {name}.", { name: name(pick.path) });
			line.title = pick?.path ?? "";
			confirm.disabled = pick === null;
		};
		let browser: CompanyFolderBrowser | undefined;
		const dialog = new SurfaceDialog(t("Choose a file or a folder"), "folder-choose-dialog", () => {
			stop.abort();
			browser?.dispose();
			resolve(chosen);
		});
		const open = async () => {
			browser?.dispose();
			pick = null;
			phase = "opening";
			draw();
			const shown = new CompanyFolderBrowser(
				host,
				{
					signal: lifetime,
					current: () => source.current(),
					folder: () => source.folder(),
					folderHints: (onHint) => source.folderHints(onHint),
				},
				() => ({ me: "", members: [], staff: [] }),
				{
					choose: (next) => {
						pick = next;
						draw();
					},
				},
			);
			browser = shown;
			try {
				await shown.open();
				phase = "open";
				draw();
			} catch {
				if (lifetime.aborted || browser !== shown) return;
				shown.dispose();
				browser = undefined;
				phase = "failed";
				draw();
				replace(
					host,
					h(
						"div",
						{ class: "files-status folder-choose-failed", role: "status" },
						h("span", null, t("The Company File could not be read just now.")),
						button(t("Try again"), () => void open(), { small: true }),
					),
				);
			}
		};
		replace(
			dialog.content,
			// The house dialog title's look, in line with the folder's own rows below it.
			h(
				"header",
				{ class: "folder-choose-head" },
				h(
					"div",
					{ class: "dialog-page-title" },
					h("h2", null, t("Choose a file or a folder")),
					h("p", null, t("It opens on this computer.")),
				),
			),
			host,
			h(
				"div",
				{ class: "surface-actions folder-choose-actions" },
				line,
				button(t("Cancel"), () => dialog.close()),
				confirm,
			),
		);
		draw();
		dialog.open();
		signal.addEventListener("abort", () => dialog.close(false), { once: true, signal: stop.signal });
		source.signal.addEventListener("abort", () => dialog.close(false), { once: true, signal: stop.signal });
		void open();
	});
}
