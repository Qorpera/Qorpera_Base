// The site door (index.html beside it): holds the frame a company's website shows in, waits for one pass from the app
// that framed it, checks it, and posts it to the site's own host from this document into that frame, so the frame
// becomes the site with this site's real Origin. It says once that it is ready, and each time the site's page has
// loaded; it takes only a message from its parent, of this same origin, and only one pass.
(() => {
	const app = window.parent;
	if (app === window) return;
	const READY = "qorpera-site-door-ready";
	const PASS = "qorpera-site-door";
	const SHOWN = "qorpera-site-door-shown";
	const INSPECTOR_MODE = "qorpera-inspector-mode";
	const INSPECTOR_PICK = "qorpera-inspector-pick";
	const IDENTITY_TOKENS_CSS = "qorpera:identity-tokens-css";
	const TARGET = "qorpera-site";
	// A site's own host or an isolated preview host (never a next host), the one path that takes a pass, a pass of base64url, a path of the site.
	const ACTION = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*(?:--p(?:[0-7]|[a-z0-9]{8}))?\.qorpera\.(?:com|site)\/__qorpera\/member$/;
	const PASS_TEXT = /^[A-Za-z0-9_-]{43}$/;
	const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,511}$/;
	let used = false;
	let targetOrigin = "";
	let frame;
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!frame || typeof data !== "object" || data === null) return;
		if (used && targetOrigin) {
			if (event.source === app && event.origin === location.origin && data.type === INSPECTOR_MODE) {
				if (frame.contentWindow)
					frame.contentWindow.postMessage({ type: INSPECTOR_MODE, active: Boolean(data.active) }, targetOrigin);
				return;
			}
			if (
				event.source === app &&
				event.origin === location.origin &&
				data.type === IDENTITY_TOKENS_CSS &&
				typeof data.css === "string"
			) {
				if (frame.contentWindow) {
					const vars =
						data.vars && typeof data.vars === "object" && !Array.isArray(data.vars) ? data.vars : {};
					frame.contentWindow.postMessage({ type: IDENTITY_TOKENS_CSS, css: data.css, vars }, targetOrigin);
				}
				return;
			}
			if (event.source === frame.contentWindow && event.origin === targetOrigin && data.type === INSPECTOR_PICK) {
				app.postMessage({ type: INSPECTOR_PICK, target: data.target }, location.origin);
				return;
			}
			return;
		}
		if (event.source !== app || event.origin !== location.origin || data.type !== PASS) return;
		const { action, pass, path, title } = data;
		if (typeof action !== "string" || !ACTION.test(action) || typeof pass !== "string" || !PASS_TEXT.test(pass)) return;
		if (path !== undefined && (typeof path !== "string" || !PATH.test(path))) return;
		targetOrigin = new URL(action).origin;
		used = true;
		if (typeof title === "string" && title.length <= 200) frame.title = title;
		const form = document.createElement("form");
		form.method = "post";
		form.action = action;
		form.target = TARGET;
		form.hidden = true;
		const field = (name, value) => {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = name;
			input.value = value;
			form.append(input);
		};
		field("pass", pass);
		if (path !== undefined) field("path", path);
		document.body.append(form);
		form.submit();
		form.remove();
	});
	const ready = () => {
		// The site's frame fills the door. Styles through the CSSOM: this page's policy allows no style sheet.
		document.documentElement.style.cssText = "height:100%";
		document.body.style.cssText = "margin:0;height:100%;overflow:hidden";
		frame = document.createElement("iframe");
		frame.name = TARGET;
		frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#fff";
		// Its own empty page is this site's; the site's page never is: only that load is the site's.
		frame.addEventListener("load", () => {
			if (used && frame.contentDocument === null) app.postMessage({ type: SHOWN }, location.origin);
		});
		document.body.append(frame);
		app.postMessage({ type: READY }, location.origin);
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
	else ready();
})();
