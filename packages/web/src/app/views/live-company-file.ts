import type { WebCompanyFiles } from "../../cloud/company-files.ts";
import { button, h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { CompanyFolderBrowser, type CompanyFolderPeople } from "./company-folder.ts";

/** The Company File page: the company's folder (folder core C4, P33), read only until member writes (P31). Every
 * company is folder-v2 (founder decision, 3 October 2026), so there is one page. */
export class LiveCompanyFileView {
	readonly el = h("section", { class: "page" });
	readonly routeHash: string;
	readonly role: string;
	readonly authorityKey: string;
	readonly #stop: AbortController;
	#browser: CompanyFolderBrowser | undefined;
	#disposed = false;
	constructor(
		company: WebCompanyFiles,
		stop: AbortController,
		authorityKey: string,
		/** Who the folder's changes are shown by (the company's members and agents). */
		people: () => CompanyFolderPeople = () => ({ me: "", members: [], staff: [] }),
	) {
		this.#stop = stop;
		this.routeHash = location.hash;
		this.role = company.company.role;
		this.authorityKey = authorityKey;
		company.signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (company.signal.aborted) {
			this.dispose();
			return;
		}
		const open = async () => {
			this.#browser?.dispose();
			const browser = new CompanyFolderBrowser(this.el, company, people);
			this.#browser = browser;
			try {
				await browser.open();
			} catch {
				if (stop.signal.aborted || this.#disposed) return;
				browser.dispose();
				this.#browser = undefined;
				replace(
					this.el,
					h("h1", null, t("Company File")),
					button(t("Retry opening Company File"), () => void open()),
				);
			}
		};
		void open();
	}
	/** The page holds no unsaved work: it is read only. */
	leaveMessage(): string | null {
		return null;
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stop.abort();
		this.#browser?.dispose();
		this.#browser = undefined;
		this.el.replaceChildren();
		this.el.remove();
	}
}
