/* The browser tab's title counts the agents whose work waits on the member in the open company, "(2) Qorpera", so a
 * member in another tab sees that something is stopped at them (Jonas, 11 Nov 2026: "it's really stopped at you. it's
 * hard to tell right now"). Set here alone; none is shown outside a company. */

const COUNT = /^\(\d+\) /u;

/** Shows `count` before the page's own title, or the title alone at 0. */
export function showWaitingInTitle(count: number): void {
	if (typeof document === "undefined") return;
	const base = document.title.replace(COUNT, "");
	const title = count > 0 ? `(${count}) ${base}` : base;
	if (document.title !== title) document.title = title;
}
