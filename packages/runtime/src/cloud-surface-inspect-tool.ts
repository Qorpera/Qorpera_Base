import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	type CloudCodingCommandReceipt,
	IDENTITY_TOKENS_CSS_PATH,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
	parseEconomicsDocument,
	parseStrategyHypothesesDocument,
	parseStrategyLandscapeDocument,
	parseStrategyPlaysDocument,
	parseSurfaceChartDocument,
	readSurfaceLayout,
	resolveSurfaceSource,
	SURFACE_LAYOUT_PATH,
	type SurfaceChartDocument,
	type SurfaceLayoutRead,
	type SurfaceReadBlock,
	type SurfaceReadNode,
	type SurfaceSource,
	type SurfaceStarterKind,
	type SurfaceTab,
	starterSurfaceLayout,
	surfaceCompanyPath,
	surfaceGlobMatches,
} from "@qorpera/contracts";
import { decodeInspectImageOutput } from "./cloud-coding-image-inspect.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { FolderImageRefusal, type FolderImageView, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import type { StudioChatGptVoiceMachine } from "./cloud-studio-voice-recorder.ts";

export const STUDIO_INSPECT_SURFACE_SCHEMA = "qorpera.studio-surface-inspect/v1";

export type InspectSurfaceTheme = "light" | "dark";
export type InspectSurfaceViewport = "desktop" | "mobile";

const WORK_ROOT = "/tmp/qorpera-studio-inspect";
const UPLOAD_CHUNK_BYTES = 14_000;
const MAX_UPLOAD_CHUNKS = 16;
const CAPTURE_TIMEOUT_MS = 45_000;
const SETUP_TIMEOUT_MS = 20_000;
const CANCEL_ON_ABORT_MS = 5_000;
const MAX_INLINE_IMAGE_BYTES = 24_000;
const MAX_TOTAL_INLINE_IMAGES_BYTES = 64_000;
const MAX_INLINE_SVG_BYTES = 24_000;
const MAX_TOTAL_INLINE_SVG_BYTES = 64_000;
const MAX_INLINE_MODULE_BYTES = 32_000;
const MAX_TOTAL_INLINE_MODULES_BYTES = 64_000;
const MAX_PREVIEW_HTML_BYTES = 256_000;
const MAX_CAPTURE_HEIGHT = 1800;
const MAX_SCROLL_Y = 6000;
const MAX_BASE64_OUTPUT_BYTES = Math.ceil((8 * 1024 * 1024) / 3) * 4 + 256;
const SCRIPT_END = "QORPERA_STUDIO_INSPECT_END";

const CAPTURE_SCRIPT_CJS = [
	'const { spawn } = require("node:child_process");',
	'const crypto = require("node:crypto");',
	'const fs = require("node:fs");',
	'const http = require("node:http");',
	'const path = require("node:path");',
	'const zlib = require("node:zlib");',
	"const [work, widthRaw, heightRaw, mobileRaw, fullRaw, scrollYRaw, folderRootRaw] = process.argv.slice(2);",
	"const width = Number(widthRaw) || 1280;",
	"const height = Number(heightRaw) || 800;",
	'const mobile = mobileRaw === "1";',
	'const fullPage = fullRaw === "1";',
	"const scrollY = Math.max(0, Math.min(6000, Number(scrollYRaw) || 0));",
	"const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });",
	"const findChrome = () => {",
	"  if (process.env.QORPERA_INSPECT_CHROMIUM) return process.env.QORPERA_INSPECT_CHROMIUM;",
	'  for (const p of ["/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {',
	"    if (fs.existsSync(p)) return p;",
	"  }",
	'  return "chromium";',
	"};",
	"const MIME = {",
	'  ".html": "text/html; charset=utf-8",',
	'  ".css": "text/css; charset=utf-8",',
	'  ".js": "application/javascript; charset=utf-8",',
	'  ".json": "application/json; charset=utf-8",',
	'  ".svg": "image/svg+xml",',
	'  ".png": "image/png",',
	'  ".jpg": "image/jpeg",',
	'  ".jpeg": "image/jpeg",',
	'  ".webp": "image/webp",',
	"};",
	'const ASSET_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);',
	"(async () => {",
	'  if (!work || !path.isAbsolute(work)) throw new Error("work must be absolute");',
	'  const siteDir = path.join(work, "site");',
	'  const gzPath = path.join(siteDir, "index.html.gz.b64");',
	'  const htmlPath = path.join(siteDir, "index.html");',
	"  if (fs.existsSync(gzPath)) {",
	'    const gz = Buffer.from(fs.readFileSync(gzPath, "utf8"), "base64");',
	"    fs.writeFileSync(htmlPath, zlib.gunzipSync(gz));",
	"    try { fs.unlinkSync(gzPath); } catch {}",
	"  }",
	"  let companyDir = null;",
	"  if (folderRootRaw) {",
	'    const candidate = path.resolve("/company", folderRootRaw);',
	'    try { const real = fs.realpathSync(candidate); const comp = fs.realpathSync("/company"); const r = path.relative(comp, real); if (r && !r.startsWith("..") && !path.isAbsolute(r)) companyDir = real; } catch {}',
	"  }",
	"  const server = http.createServer((req, res) => {",
	'    const reqPath = (req.url || "/").split("?")[0];',
	'    if (companyDir && reqPath.startsWith("/company-asset/")) {',
	'      let rel = ""; try { rel = decodeURIComponent(reqPath.slice("/company-asset/".length)); } catch { res.writeHead(400); res.end(); return; }',
	'      try { const resolved = fs.realpathSync(path.resolve(companyDir, rel)); const r = path.relative(companyDir, resolved); const mime = MIME[path.extname(resolved).toLowerCase()]; if (!r || r.startsWith("..") || path.isAbsolute(r) || !ASSET_MIME.has(mime) || !fs.statSync(resolved).isFile()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "Content-Type": mime }); fs.createReadStream(resolved).pipe(res); return; } catch { res.writeHead(404); res.end(); return; }',
	"    }",
	'    const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\\/+/, "");',
	"    const resolved = path.resolve(siteDir, rel);",
	"    const relCheck = path.relative(siteDir, resolved);",
	'    if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {',
	'      res.writeHead(404); res.end("not found"); return;',
	"    }",
	'    res.writeHead(200, { "Content-Type": MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream" });',
	"    fs.createReadStream(resolved).pipe(res);",
	"  });",
	'  await new Promise((res) => server.listen(0, "127.0.0.1", res));',
	"  const port = server.address().port;",
	'  const userData = path.join(work, "chrome");',
	'  const proc = spawn(findChrome(), ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--remote-debugging-port=0", "--user-data-dir=" + userData, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });',
	"  let ws = null;",
	"  try {",
	'    let wsUrl = null, errBuf = "", spawnErr = null;',
	'    proc.on("error", (err) => { spawnErr = err; });',
	'    proc.stderr.setEncoding("utf8");',
	'    proc.stderr.on("data", (c) => { errBuf = (errBuf + c).slice(-4096); const m = /DevTools listening on (ws:\\/\\/[^\\s]+)/.exec(errBuf); if (m) wsUrl = m[1]; });',
	"    const bootBy = Date.now() + 20000;",
	"    while (!wsUrl && !spawnErr && proc.exitCode === null && Date.now() < bootBy) await sleep(50);",
	"    if (spawnErr) throw spawnErr;",
	'    if (!wsUrl) throw new Error("chromium did not open devtools: " + errBuf.slice(-240));',
	'    const base = wsUrl.replace(/^ws:\\/\\//, "http://").replace(/\\/devtools\\/.*/, "");',
	"    let targetWs = null;",
	"    for (let i = 0; i < 40 && !targetWs; i++) {",
	'      const list = await fetch(base + "/json/list").then((r) => r.json()).catch(() => []);',
	'      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);',
	"      if (page) targetWs = page.webSocketDebuggerUrl; else await sleep(50);",
	"    }",
	'    if (!targetWs) throw new Error("no browser page target");',
	"    ws = new WebSocket(targetWs);",
	'    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("devtools socket failed")); });',
	"    let nextId = 0; const pending = new Map(); let loadResolve = null;",
	"    const loaded = new Promise((res) => { loadResolve = res; });",
	"    const rejectAll = (msg) => { for (const p of pending.values()) p.rej(new Error(msg)); pending.clear(); };",
	'    ws.onclose = () => rejectAll("devtools socket closed");',
	'    ws.onerror = () => rejectAll("devtools socket error");',
	"    ws.onmessage = (ev) => {",
	"      const msg = JSON.parse(String(ev.data));",
	"      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }",
	'      if (msg.method === "Page.loadEventFired" && loadResolve) { loadResolve(); loadResolve = null; }',
	"    };",
	'    const send = (method, params = {}) => new Promise((res, rej) => { if (ws.readyState !== 1) return rej(new Error("devtools socket not open")); const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });',
	'    await send("Page.enable");',
	'    await send("Runtime.enable");',
	'    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });',
	'    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/index.html" });',
	"    await Promise.race([loaded, sleep(12000)]);",
	'    const settle = await send("Runtime.evaluate", { expression: "(async()=>{if(document.fonts&&document.fonts.ready)await document.fonts.ready.catch(()=>{});await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));return Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight||0));})()", awaitPromise: true, returnByValue: true });',
	"    const scrollHeight = Number(settle && settle.result && settle.result.value) || height;",
	"    const y = fullPage ? 0 : Math.min(scrollY, Math.max(0, scrollHeight - height));",
	`    const captureHeight = fullPage ? Math.max(height, Math.min(${MAX_CAPTURE_HEIGHT}, scrollHeight)) : height;`,
	'    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y, width, height: captureHeight, scale: 1 } });',
	'    if (!shot || typeof shot.data !== "string" || !shot.data.length) throw new Error("empty screenshot");',
	'    const data = Buffer.from(shot.data, "base64");',
	'    const hash = crypto.createHash("sha256").update(data).digest("hex");',
	'    const writeAll = async (s) => { if (!process.stdout.write(s)) await new Promise((r) => process.stdout.once("drain", r)); };',
	'    await writeAll("QORPERA_META:" + JSON.stringify({ scrollHeight, scrollY: y, captureHeight }) + "\\n");',
	'    await writeAll("QORPERA_IMG:" + data.length + ":" + hash + ":\\n");',
	'    for (let i = 0; i < data.length; i += 49152) await writeAll(data.subarray(i, Math.min(data.length, i + 49152)).toString("base64"));',
	"  } finally {",
	"    try { if (ws) ws.close(); } catch {}",
	'    try { proc.kill("SIGKILL"); } catch {}',
	"    try { server.close(); } catch {}",
	"    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}",
	"  }",
	"})().catch((e) => { process.stderr.write(String(e && e.message ? e.message : e) + '\\n'); try { fs.rmSync(work, { recursive: true, force: true }); } catch {} process.exit(1); });",
].join("\n");

export interface StudioInspectBinaryMeta {
	readonly bytes: number;
	readonly mediaType: string;
	readonly inCompanyMount?: boolean;
}

export interface StudioInspectSnapshot {
	readonly surfaceTitle: string;
	readonly folderRoot: string;
	readonly starter: SurfaceStarterKind;
	readonly files: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, { readonly bytes: Uint8Array; readonly mediaType: string }>>;
	readonly knownBinaries?: Readonly<Record<string, StudioInspectBinaryMeta>>;
}

export interface InspectSurfaceToolOptions {
	readonly machine: StudioChatGptVoiceMachine;
	readonly loadSnapshot: (signal: AbortSignal) => Promise<StudioInspectSnapshot>;
	readonly pollMs?: number;
}

export interface RenderedStudioPreview {
	readonly html: string;
	readonly activeTab: { readonly id: string; readonly title: string };
	readonly tabs: readonly { readonly id: string; readonly title: string }[];
	readonly renderedBlocks: readonly { readonly type: string; readonly heading: string; readonly filled: boolean }[];
	readonly warnings: readonly string[];
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function sanitizeInlineCss(css: string): string {
	return css.replace(/<\/style/gi, "<\\/style").replace(/@import\s+[^;]+;/gi, "");
}

function sanitizeInlineSvg(svg: string): string {
	return svg
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveCompanyPath(folderRoot: string, bindingPath: string): string | undefined {
	try {
		return surfaceCompanyPath(folderRoot, bindingPath);
	} catch {
		return undefined;
	}
}

function createSnapshotReader(snapshot: StudioInspectSnapshot) {
	const parsed = new Map<string, unknown>();
	const readJson = (bindingPath: string): unknown => {
		const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
		if (!path) return undefined;
		if (!parsed.has(path)) {
			const text = snapshot.files[path];
			let val: unknown;
			if (text !== undefined) {
				try {
					val = JSON.parse(text);
				} catch {
					val = undefined;
				}
			}
			parsed.set(path, val);
		}
		return parsed.get(path);
	};
	return {
		readSource(source: SurfaceSource | undefined): { readonly found: boolean; readonly value: unknown } {
			if (source === undefined) return { found: false, value: undefined };
			return resolveSurfaceSource(source, readJson);
		},
		fileText(bindingPath: string): string | undefined {
			const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
			return path ? snapshot.files[path] : undefined;
		},
		binary(bindingPath: string): { readonly bytes: Uint8Array; readonly mediaType: string } | undefined {
			const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
			return path ? snapshot.binaries[path] : undefined;
		},
		knownBinary(bindingPath: string): { readonly path: string; readonly meta: StudioInspectBinaryMeta } | undefined {
			const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
			if (!path) return undefined;
			const meta = snapshot.knownBinaries?.[path];
			return meta ? { path, meta } : undefined;
		},
	};
}

function formatNum(value: number, unit?: string): string {
	if (!Number.isFinite(value)) return "–";
	const abs = Math.abs(value);
	const body =
		abs >= 1_000_000
			? `${(value / 1_000_000).toFixed(1)}M`
			: abs >= 10_000
				? `${(value / 1_000).toFixed(1)}k`
				: Number.isInteger(value)
					? String(value)
					: value.toFixed(1);
	if (!unit) return body;
	if (unit === "$" || unit === "€" || unit === "£") return `${unit}${body}`;
	if (unit === "%") return `${body}%`;
	return `${body} ${unit}`;
}

function resolveSvgColor(raw: string | undefined, fallback: string, palette: readonly string[], dark: boolean): string {
	if (!raw) return fallback;
	const trimmed = raw.trim();
	const cssVar = /^var\((--[a-z0-9-]+)\)$/i.exec(trimmed);
	if (cssVar) {
		const name = cssVar[1]!.toLowerCase();
		if (name.includes("accent") || name.includes("primary")) return palette[0]!;
		if (name.includes("muted") || name.includes("soft")) return dark ? "#b8b7b2" : "#686866";
		if (name.includes("danger") || name.includes("error")) return dark ? "#ff9084" : "#b33a2f";
		if (name.includes("success") || name.includes("positive")) return dark ? "#5ed6a9" : "#0f7a55";
		return fallback;
	}
	return escapeHtml(trimmed);
}

function resolveAxisSpan(
	values: readonly number[],
	explicitMin: number | undefined,
	explicitMax: number | undefined,
	defaultZeroFloor: boolean,
): { readonly min: number; readonly max: number } {
	const dataMin = values.length > 0 ? Math.min(...values) : 0;
	const dataMax = values.length > 0 ? Math.max(...values) : 1;
	let min = explicitMin ?? (defaultZeroFloor ? Math.min(0, dataMin) : dataMin);
	let max = explicitMax ?? Math.max(defaultZeroFloor ? 1 : dataMin + 1, dataMax);
	if (min >= max) {
		if (explicitMax !== undefined && explicitMin === undefined) min = max - Math.max(1, Math.abs(max));
		else max = min + Math.max(1, Math.abs(min));
	}
	return { min, max };
}

function renderChartSvg(doc: SurfaceChartDocument, dark: boolean): string {
	const palette = dark
		? ["#e5835c", "#5ed6a9", "#6aa8ff", "#f2c35d", "#d49bff", "#ff9084"]
		: ["#d76f45", "#0f7a55", "#2b6cb0", "#b7791f", "#7c4dff", "#b33a2f"];
	const text = dark ? "#f4f3f0" : "#161615";
	const muted = dark ? "#b8b7b2" : "#686866";
	const grid = dark ? "rgba(255,255,255,0.09)" : "rgba(18,18,17,0.08)";
	const W = 720;
	const H = 310;

	if (doc.kind === "pie") {
		const slices = (doc.series?.[0]?.data ?? [])
			.map((entry, idx) => {
				const value =
					entry === null
						? 0
						: typeof entry === "number"
							? entry
							: typeof entry.value === "number"
								? entry.value
								: entry.value[1];
				const name =
					(entry && typeof entry === "object" && entry.name) || doc.categories?.[idx] || `Item ${idx + 1}`;
				const rawColor = entry && typeof entry === "object" ? entry.color : undefined;
				return {
					name,
					value: Math.max(0, value),
					color: resolveSvgColor(rawColor, palette[idx % palette.length]!, palette, dark),
				};
			})
			.filter((s) => s.value > 0);
		const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
		const cx = 210;
		const cy = 155;
		const r = 110;
		const inner = doc.donut ? 62 : 0;
		let angle = -Math.PI / 2;
		const paths = slices
			.map((s) => {
				const span = (s.value / total) * Math.PI * 2;
				const end = angle + span;
				const large = span > Math.PI ? 1 : 0;
				const x1 = cx + Math.cos(angle) * r;
				const y1 = cy + Math.sin(angle) * r;
				const x2 = cx + Math.cos(end) * r;
				const y2 = cy + Math.sin(end) * r;
				let d: string;
				if (inner > 0) {
					const ix1 = cx + Math.cos(end) * inner;
					const iy1 = cy + Math.sin(end) * inner;
					const ix2 = cx + Math.cos(angle) * inner;
					const iy2 = cy + Math.sin(angle) * inner;
					d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix2} ${iy2} Z`;
				} else {
					d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
				}
				angle = end;
				return `<path d="${d}" fill="${s.color}" stroke="${dark ? "#181918" : "#fff"}" stroke-width="2"/>`;
			})
			.join("");
		const legend = slices
			.slice(0, 8)
			.map(
				(s, idx) =>
					`<g transform="translate(380,${46 + idx * 28})"><circle cx="6" cy="6" r="5" fill="${s.color}"/><text x="20" y="10" fill="${text}" font-size="13">${escapeHtml(s.name)} — ${formatNum(s.value, doc.unit)} (${Math.round((s.value / total) * 100)}%)</text></g>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${paths}${legend}</svg>`;
	}

	if (doc.kind === "funnel") {
		const stages = (doc.series?.[0]?.data ?? []).map((entry, idx) => ({
			name: (entry && typeof entry === "object" && entry.name) || doc.categories?.[idx] || `Stage ${idx + 1}`,
			value:
				entry === null
					? 0
					: typeof entry === "number"
						? entry
						: typeof entry.value === "number"
							? entry.value
							: entry.value[1],
			color: resolveSvgColor(
				entry && typeof entry === "object" ? entry.color : undefined,
				palette[idx % palette.length]!,
				palette,
				dark,
			),
		}));
		const maxVal = Math.max(...stages.map((s) => s.value), 1);
		const rowH = Math.min(46, Math.floor((H - 30) / Math.max(stages.length, 1)));
		const bars = stages
			.map((s, idx) => {
				const w = Math.max(90, Math.round((s.value / maxVal) * 520));
				const x = Math.round((W - w) / 2);
				const y = 16 + idx * (rowH + 6);
				return `<rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="8" fill="${s.color}" opacity="0.9"/><text x="${W / 2}" y="${y + rowH / 2 + 5}" text-anchor="middle" fill="#fff" font-size="13" font-weight="650">${escapeHtml(s.name)} · ${formatNum(s.value, doc.unit)}</text>`;
			})
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${bars}</svg>`;
	}

	if (doc.kind === "sankey") {
		const nodes = doc.nodes ?? [];
		const links = doc.links ?? [];
		const sources = new Set(links.map((l) => l.source));
		const targets = new Set(links.map((l) => l.target));
		const left = nodes.filter((n) => sources.has(n.name) && !targets.has(n.name));
		const right = nodes.filter((n) => targets.has(n.name) && !sources.has(n.name));
		const middle = nodes.filter((n) => !left.includes(n) && !right.includes(n));
		const cols = [left, middle, right].filter((c) => c.length > 0);
		const pos = new Map<string, { x: number; y: number; color: string }>();
		cols.forEach((col, cIdx) => {
			const x = cols.length === 1 ? W / 2 : 120 + (cIdx * (W - 240)) / (cols.length - 1);
			col.forEach((n, rIdx) => {
				const y = 40 + ((rIdx + 0.5) * (H - 80)) / Math.max(col.length, 1);
				pos.set(n.name, {
					x,
					y,
					color: resolveSvgColor(n.color, palette[(cIdx * 3 + rIdx) % palette.length]!, palette, dark),
				});
			});
		});
		const maxFlow = Math.max(...links.map((l) => l.value), 1);
		const edgesSvg = links
			.map((l) => {
				const a = pos.get(l.source);
				const b = pos.get(l.target);
				if (!a || !b) return "";
				const strokeW = Math.max(3, Math.round((l.value / maxFlow) * 26));
				const mx = (a.x + b.x) / 2;
				return `<path d="M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}" fill="none" stroke="${a.color}" stroke-opacity="0.38" stroke-width="${strokeW}"/>`;
			})
			.join("");
		const nodesSvg = [...pos.entries()]
			.map(
				([name, p]) =>
					`<rect x="${p.x - 6}" y="${p.y - 16}" width="12" height="32" rx="3" fill="${p.color}"/><text x="${p.x > W / 2 ? p.x + 12 : p.x - 12}" y="${p.y + 4}" text-anchor="${p.x > W / 2 ? "start" : "end"}" fill="${text}" font-size="12" font-weight="600">${escapeHtml(name)}</text>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${edgesSvg}${nodesSvg}</svg>`;
	}

	if (doc.kind === "radar" && doc.indicators && doc.indicators.length >= 3) {
		const cx = 360;
		const cy = 155;
		const r = 105;
		const n = doc.indicators.length;
		const rings = [0.33, 0.66, 1]
			.map((scale) => {
				const pts = doc
					.indicators!.map((_, i) => {
						const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
						return `${cx + Math.cos(a) * r * scale},${cy + Math.sin(a) * r * scale}`;
					})
					.join(" ");
				return `<polygon points="${pts}" fill="none" stroke="${grid}" stroke-width="1"/>`;
			})
			.join("");
		const labels = doc.indicators
			.map((ind, i) => {
				const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
				const lx = cx + Math.cos(a) * (r + 22);
				const ly = cy + Math.sin(a) * (r + 18);
				return `<text x="${lx}" y="${ly}" text-anchor="middle" fill="${muted}" font-size="11.5">${escapeHtml(ind.name)}</text>`;
			})
			.join("");
		const polys = (doc.series ?? [])
			.map((s, sIdx) => {
				const color = resolveSvgColor(s.color, palette[sIdx % palette.length]!, palette, dark);
				const pts = doc
					.indicators!.map((ind, i) => {
						const raw = s.data[i];
						const v =
							typeof raw === "number"
								? raw
								: raw && typeof raw === "object" && typeof raw.value === "number"
									? raw.value
									: 0;
						const ratio = Math.max(0, Math.min(1, v / ind.max));
						const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
						return `${cx + Math.cos(a) * r * ratio},${cy + Math.sin(a) * r * ratio}`;
					})
					.join(" ");
				return `<polygon points="${pts}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2.2"/>`;
			})
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${rings}${polys}${labels}</svg>`;
	}

	if (doc.kind === "heatmap" && doc.xCategories && doc.yCategories && doc.cells) {
		const cols = doc.xCategories.length;
		const rows = doc.yCategories.length;
		const left = 96;
		const top = 16;
		const cellW = Math.max(16, Math.floor((W - left - 20) / Math.max(cols, 1)));
		const cellH = Math.max(18, Math.floor((H - top - 36) / Math.max(rows, 1)));
		const vals = doc.cells.map((c) => c[2]);
		const min = Math.min(...vals);
		const max = Math.max(...vals);
		const span = max - min || 1;
		const rects = doc.cells
			.map(([x, y, v]) => {
				const opacity = 0.12 + ((v - min) / span) * 0.85;
				const px = left + x * cellW;
				const py = top + y * cellH;
				return `<rect x="${px + 1}" y="${py + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="4" fill="${palette[0]}" fill-opacity="${opacity.toFixed(2)}"/><text x="${px + cellW / 2}" y="${py + cellH / 2 + 4}" text-anchor="middle" fill="${text}" font-size="10.5">${formatNum(v, doc.unit)}</text>`;
			})
			.join("");
		const yLabels = doc.yCategories
			.map(
				(label, idx) =>
					`<text x="${left - 8}" y="${top + idx * cellH + cellH / 2 + 4}" text-anchor="end" fill="${muted}" font-size="11">${escapeHtml(label)}</text>`,
			)
			.join("");
		const xLabels = doc.xCategories
			.map(
				(label, idx) =>
					`<text x="${left + idx * cellW + cellW / 2}" y="${top + rows * cellH + 18}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(label)}</text>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${rects}${yLabels}${xLabels}</svg>`;
	}

	const seriesList = doc.series ?? [];
	const seriesColors = seriesList.map((s, sIdx) =>
		resolveSvgColor(s.color, palette[sIdx % palette.length]!, palette, dark),
	);
	const allNums: number[] = [];
	const allXs: number[] = [];
	for (const s of seriesList) {
		for (let idx = 0; idx < s.data.length; idx += 1) {
			const item = s.data[idx];
			if (typeof item === "number") {
				allNums.push(item);
				allXs.push(idx);
			} else if (item && typeof item === "object") {
				if (typeof item.value === "number") {
					allNums.push(item.value);
					allXs.push(idx);
				} else {
					allXs.push(item.value[0]);
					allNums.push(item.value[1]);
				}
			}
		}
		for (const line of s.markLine ?? []) allNums.push(line.value);
	}
	const count = Math.max(...seriesList.map((s) => s.data.length), doc.categories?.length ?? 0, 1);
	const cats = doc.categories ?? Array.from({ length: count }, (_, i) => String(i + 1));
	const legend =
		seriesList.length > 1
			? seriesList
					.map(
						(s, idx) =>
							`<g transform="translate(${62 + idx * 130}, 10)"><circle cx="5" cy="4" r="4" fill="${seriesColors[idx]}"/><text x="14" y="8" fill="${muted}" font-size="11.5">${escapeHtml(s.name.slice(0, 16))}</text></g>`,
					)
					.join("")
			: "";

	if (doc.kind === "bar" && doc.horizontal === true) {
		const { min: minV, max: maxV } = resolveAxisSpan(
			allNums,
			doc.xAxisMin ?? doc.yAxisMin,
			doc.xAxisMax ?? doc.yAxisMax,
			true,
		);
		const padL = 112;
		const padR = 24;
		const padT = seriesList.length > 1 ? 30 : 20;
		const padB = 34;
		const plotW = W - padL - padR;
		const plotH = H - padT - padB;
		const xFor = (val: number) => padL + ((Math.max(minV, Math.min(maxV, val)) - minV) / (maxV - minV || 1)) * plotW;
		const x0 = xFor(Math.max(minV, Math.min(maxV, 0)));
		const gridLines = [0, 0.25, 0.5, 0.75, 1]
			.map((f) => {
				const val = minV + (maxV - minV) * f;
				const x = xFor(val);
				return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="${grid}" stroke-dasharray="3 4"/><text x="${x}" y="${H - 14}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(formatNum(val, doc.unit))}</text>`;
			})
			.join("");
		const groupH = plotH / count;
		const barH = Math.max(8, Math.min(28, (groupH * 0.72) / Math.max(seriesList.length, 1)));
		let shapes = "";
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			s.data.forEach((item, idx) => {
				const val =
					typeof item === "number"
						? item
						: item && typeof item === "object" && typeof item.value === "number"
							? item.value
							: 0;
				const barColor =
					item && typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				const y = padT + idx * groupH + (groupH - barH * seriesList.length) / 2 + sIdx * barH;
				const x1 = xFor(val);
				shapes += `<rect x="${Math.min(x0, x1)}" y="${y}" width="${Math.max(2, Math.abs(x1 - x0))}" height="${Math.max(2, barH - 2)}" rx="4" fill="${barColor}"/>`;
			});
			for (const line of s.markLine ?? []) {
				if (line.value < minV || line.value > maxV) continue;
				const mx = xFor(line.value);
				const label = line.label
					? `${line.label} · ${formatNum(line.value, doc.unit)}`
					: formatNum(line.value, doc.unit);
				shapes += `<line x1="${mx}" y1="${padT}" x2="${mx}" y2="${H - padB}" stroke="${muted}" stroke-dasharray="4 4" stroke-width="1.25"/><text x="${mx}" y="${padT - 5}" text-anchor="middle" fill="${muted}" font-size="10.5">${escapeHtml(label)}</text>`;
			}
		});
		const yLabels = cats
			.map(
				(cat, idx) =>
					`<text x="${padL - 8}" y="${padT + (idx + 0.5) * groupH + 4}" text-anchor="end" fill="${muted}" font-size="11">${escapeHtml(cat.slice(0, 16))}</text>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${legend}${gridLines}${shapes}${yLabels}</svg>`;
	}

	const { min: minY, max: maxY } = resolveAxisSpan(allNums, doc.yAxisMin, doc.yAxisMax, doc.kind !== "scatter");
	const padL = 62;
	const padR = 20;
	const padT = 26;
	const padB = 40;
	const plotW = W - padL - padR;
	const plotH = H - padT - padB;
	const yFor = (val: number) =>
		padT + plotH - ((Math.max(minY, Math.min(maxY, val)) - minY) / (maxY - minY || 1)) * plotH;
	const gridLines = [0, 0.25, 0.5, 0.75, 1]
		.map((f) => {
			const val = minY + (maxY - minY) * f;
			const y = yFor(val);
			return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${grid}" stroke-dasharray="3 4"/><text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="${muted}" font-size="11">${escapeHtml(formatNum(val, doc.unit))}</text>`;
		})
		.join("");

	let shapes = "";
	if (doc.kind === "bar") {
		const groupW = plotW / count;
		const barW = Math.max(8, Math.min(36, (groupW * 0.72) / Math.max(seriesList.length, 1)));
		const y0 = yFor(Math.max(minY, Math.min(maxY, 0)));
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			s.data.forEach((item, idx) => {
				const val =
					typeof item === "number"
						? item
						: item && typeof item === "object" && typeof item.value === "number"
							? item.value
							: 0;
				const barColor =
					item && typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				const x = padL + idx * groupW + (groupW - barW * seriesList.length) / 2 + sIdx * barW;
				const y1 = yFor(val);
				shapes += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${barW - 2}" height="${Math.max(2, Math.abs(y1 - y0))}" rx="4" fill="${barColor}"/>`;
			});
		});
	} else if (doc.kind === "scatter") {
		const { min: minX, max: maxX } = resolveAxisSpan(allXs, doc.xAxisMin, doc.xAxisMax, false);
		const xFor = (val: number) => padL + ((val - minX) / (maxX - minX || 1)) * plotW;
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			s.data.forEach((item, idx) => {
				if (item === null) return;
				const xVal = typeof item === "number" ? idx : typeof item.value === "number" ? idx : item.value[0];
				const yVal = typeof item === "number" ? item : typeof item.value === "number" ? item.value : item.value[1];
				const pointColor =
					typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				shapes += `<circle cx="${xFor(xVal)}" cy="${yFor(yVal)}" r="6" fill="${pointColor}" fill-opacity="0.85"/>`;
			});
		});
	} else {
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			const pts: { x: number; y: number; color: string }[] = [];
			s.data.forEach((item, idx) => {
				if (item === null) return;
				const val = typeof item === "number" ? item : typeof item.value === "number" ? item.value : item.value[1];
				const x = padL + (count === 1 ? plotW / 2 : (idx / (count - 1)) * plotW);
				const pointColor =
					typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				pts.push({ x, y: yFor(val), color: pointColor });
			});
			if (pts.length > 0) {
				const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
				if (doc.kind === "area") {
					const baseY = yFor(minY);
					const area = `${path} L ${pts[pts.length - 1]!.x.toFixed(1)} ${baseY.toFixed(1)} L ${pts[0]!.x.toFixed(1)} ${baseY.toFixed(1)} Z`;
					shapes += `<path d="${area}" fill="${seriesColor}" fill-opacity="0.18"/>`;
				}
				shapes += `<path d="${path}" fill="none" stroke="${seriesColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
				shapes += pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="${p.color}"/>`).join("");
			}
		});
	}
	for (const s of seriesList) {
		for (const line of s.markLine ?? []) {
			if (line.value < minY || line.value > maxY) continue;
			const my = yFor(line.value);
			const label = line.label
				? `${line.label} · ${formatNum(line.value, doc.unit)}`
				: formatNum(line.value, doc.unit);
			shapes += `<line x1="${padL}" y1="${my}" x2="${W - padR}" y2="${my}" stroke="${muted}" stroke-dasharray="4 4" stroke-width="1.25"/><text x="${W - padR - 4}" y="${my - 5}" text-anchor="end" fill="${muted}" font-size="10.5">${escapeHtml(label)}</text>`;
		}
	}
	let xLabels = "";
	if (doc.kind === "scatter") {
		const { min: minX, max: maxX } = resolveAxisSpan(allXs, doc.xAxisMin, doc.xAxisMax, false);
		xLabels = [0, 0.25, 0.5, 0.75, 1]
			.map((f) => {
				const val = minX + (maxX - minX) * f;
				const x = padL + f * plotW;
				return `<text x="${x}" y="${H - 14}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(formatNum(val))}</text>`;
			})
			.join("");
	} else {
		const step = Math.max(1, Math.ceil(cats.length / 10));
		xLabels = cats
			.map((cat, idx) => {
				if (idx % step !== 0 && idx !== cats.length - 1) return "";
				const x =
					padL +
					(doc.kind === "bar"
						? (idx + 0.5) * (plotW / count)
						: count === 1
							? plotW / 2
							: (idx / (count - 1)) * plotW);
				return `<text x="${x}" y="${H - 14}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(cat.slice(0, 14))}</text>`;
			})
			.join("");
	}
	return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${legend}${gridLines}${shapes}${xLabels}</svg>`;
}

function renderBlockHtml(
	block: SurfaceReadBlock,
	snapshot: StudioInspectSnapshot,
	reader: ReturnType<typeof createSnapshotReader>,
	dark: boolean,
	inlineBudget: { imageUsed: number; svgUsed: number; moduleUsed: number },
	renderedBlocks: { readonly type: string; readonly heading: string; readonly filled: boolean }[],
	warnings: string[],
): string {
	const heading = "heading" in block && typeof block.heading === "string" ? block.heading : block.type;
	const wrap = (title: string, body: string, filled: boolean) => {
		renderedBlocks.push({ type: block.type, heading: title, filled });
		return `<section class="pv-section" data-block="${escapeHtml(block.type)}"><div class="pv-section-head"><h2>${escapeHtml(title)}</h2></div>${body}</section>`;
	};

	switch (block.type) {
		case "title": {
			const nameRead = reader.readSource(block.name);
			const lineRead = reader.readSource(block.line);
			const name =
				typeof nameRead.value === "string" && nameRead.value.trim() ? nameRead.value.trim() : snapshot.surfaceTitle;
			const line = typeof lineRead.value === "string" ? lineRead.value.trim() : "";
			renderedBlocks.push({ type: "title", heading: name, filled: Boolean(line || name) });
			return `<header class="pv-hero"><h1>${escapeHtml(name)}</h1>${line ? `<p class="pv-hero-line">${escapeHtml(line)}</p>` : ""}</header>`;
		}
		case "facts": {
			const items: { label: string; value: string }[] = [];
			if ("items" in block) {
				for (const item of block.items) {
					const got = reader.readSource(item.from);
					items.push({
						label: item.label,
						value: got.found && got.value !== null && got.value !== undefined ? String(got.value) : "?",
					});
				}
			} else {
				const got = reader.readSource(block.from);
				if (isPlainRecord(got.value)) {
					for (const [k, v] of Object.entries(got.value)) {
						if (block.skip.includes(k) || items.length >= block.take) continue;
						if (typeof v === "string" || typeof v === "number") items.push({ label: k, value: String(v) });
					}
				} else if (Array.isArray(got.value)) {
					for (const row of got.value) {
						if (items.length >= block.take) break;
						if (isPlainRecord(row) && typeof row.label === "string") {
							items.push({ label: row.label, value: String(row.value ?? "?") });
						}
					}
				}
			}
			const filled = items.some((i) => i.value !== "?");
			if (!filled) warnings.push(`Facts block "${heading}" has no populated figures.`);
			const grid = `<div class="pv-facts">${items.map((i) => `<div class="pv-fact"><div class="pv-fact-val">${escapeHtml(i.value)}</div><div class="pv-fact-lbl">${escapeHtml(i.label)}</div></div>`).join("")}</div>`;
			return block.heading
				? wrap(block.heading, grid, filled)
				: (() => {
						renderedBlocks.push({ type: "facts", heading: "Facts", filled });
						return `<section class="pv-section">${grid}</section>`;
					})();
		}
		case "chart": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseSurfaceChartDocument(read.value) : null;
			const title = block.heading ?? doc?.title ?? "Chart";
			if (!doc) {
				warnings.push(`Chart block "${title}" has no valid chart data.`);
				return wrap(title, `<div class="pv-empty">No chart data yet</div>`, false);
			}
			const caption = block.caption ?? doc.note;
			return wrap(
				title,
				`${doc.subtitle ? `<p class="pv-sub">${escapeHtml(doc.subtitle)}</p>` : ""}<div class="pv-chart-card">${renderChartSvg(doc, dark)}</div>${caption ? `<p class="pv-caption">${escapeHtml(caption)}</p>` : ""}`,
				true,
			);
		}
		case "plays": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseStrategyPlaysDocument(read.value) : null;
			const title = block.heading ?? "Competing plays";
			if (!doc) {
				warnings.push(`Plays block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No plays staged yet</div>`, false);
			}
			const cards = doc.plays
				.map(
					(play) =>
						`<article class="pv-card${play.status === "recommended" ? " is-accent" : ""}"><div class="pv-card-top"><strong>${escapeHtml(play.name)}</strong>${play.status === "recommended" ? `<span class="pv-badge is-accent">Recommended</span>` : ""}</div>${play.thesis ? `<p>${escapeHtml(play.thesis)}</p>` : ""}</article>`,
				)
				.join("");
			return wrap(
				title,
				`${doc.summary ? `<p class="pv-sub">${escapeHtml(doc.summary)}</p>` : ""}<div class="pv-grid">${cards}</div>`,
				true,
			);
		}
		case "economics": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseEconomicsDocument(read.value) : null;
			const title = block.heading ?? doc?.title ?? "Unit economics";
			if (!doc) {
				warnings.push(`Economics block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No economics model yet</div>`, false);
			}
			const levers = doc.inputs
				.slice(0, 6)
				.map(
					(input) =>
						`<div class="pv-fact"><div class="pv-fact-val">${escapeHtml(formatNum(input.value, input.unit))}</div><div class="pv-fact-lbl">${escapeHtml(input.label)}</div></div>`,
				)
				.join("");
			const scenarios = (doc.scenarios ?? [])
				.map((scenario) => `<span class="pv-pill">${escapeHtml(scenario.name)}</span>`)
				.join("");
			return wrap(
				title,
				`${doc.subtitle ? `<p class="pv-sub">${escapeHtml(doc.subtitle)}</p>` : ""}${scenarios ? `<div class="pv-pills">${scenarios}</div>` : ""}<div class="pv-facts">${levers}</div>`,
				true,
			);
		}
		case "hypotheses": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseStrategyHypothesesDocument(read.value) : null;
			const title = block.heading ?? "Hypotheses";
			if (!doc) {
				warnings.push(`Hypotheses block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No hypotheses yet</div>`, false);
			}
			const rows = doc.hypotheses
				.slice(0, 8)
				.map(
					(item) =>
						`<div class="pv-hyp-row"><span class="pv-badge is-${escapeHtml(item.impact)}">${escapeHtml(item.impact)}</span><strong>${escapeHtml(item.bet)}</strong><span class="pv-muted">${escapeHtml(item.status)}</span></div>`,
				)
				.join("");
			return wrap(title, `<div class="pv-list">${rows}</div>`, true);
		}
		case "landscape": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseStrategyLandscapeDocument(read.value) : null;
			const title = block.heading ?? "Competitive landscape";
			if (!doc) {
				warnings.push(`Landscape block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No rivals mapped yet</div>`, false);
			}
			const placed = doc.players.filter((p) => typeof p.x === "number" && typeof p.y === "number");
			const mapSvg =
				doc.axes && placed.length >= 2
					? `<div class="pv-chart-card"><svg viewBox="0 0 640 280" class="pv-svg"><rect x="44" y="16" width="560" height="224" rx="12" fill="none" stroke="${dark ? "rgba(255,255,255,0.12)" : "rgba(18,18,17,0.12)"}"/><line x1="324" y1="16" x2="324" y2="240" stroke="${dark ? "rgba(255,255,255,0.08)" : "rgba(18,18,17,0.08)"}" stroke-dasharray="4 4"/><line x1="44" y1="128" x2="604" y2="128" stroke="${dark ? "rgba(255,255,255,0.08)" : "rgba(18,18,17,0.08)"}" stroke-dasharray="4 4"/>${placed
							.map((p) => {
								const cx = 44 + (Math.max(0, Math.min(100, p.x!)) / 100) * 560;
								const cy = 240 - (Math.max(0, Math.min(100, p.y!)) / 100) * 224;
								const fill = p.isUs ? (dark ? "#e5835c" : "#d76f45") : dark ? "#908f8a" : "#555";
								return `<circle cx="${cx}" cy="${cy}" r="${p.isUs ? 9 : 6}" fill="${fill}"/><text x="${cx + 10}" y="${cy + 4}" fill="${dark ? "#f4f3f0" : "#161615"}" font-size="12" font-weight="${p.isUs ? "700" : "500"}">${escapeHtml(p.name)}</text>`;
							})
							.join(
								"",
							)}<text x="324" y="264" text-anchor="middle" fill="${dark ? "#b8b7b2" : "#686866"}" font-size="11.5">${escapeHtml(doc.axes.xLabel)} · ${escapeHtml(doc.axes.yLabel)}</text></svg></div>`
					: "";
			const chips = doc.players
				.map(
					(p) =>
						`<span class="pv-pill${p.isUs ? " is-accent" : ""}">${escapeHtml(p.name)}${p.pricing ? ` · ${escapeHtml(p.pricing)}` : ""}</span>`,
				)
				.join("");
			return wrap(
				title,
				`${doc.wedge ? `<p class="pv-wedge"><strong>Our wedge:</strong> ${escapeHtml(doc.wedge)}</p>` : ""}${mapSvg}<div class="pv-pills">${chips}</div>`,
				true,
			);
		}
		case "palette": {
			const read = reader.readSource(block.from);
			const entries: { name: string; value: string }[] = [];
			if (isPlainRecord(read.value)) {
				for (const [k, v] of Object.entries(read.value)) {
					if (typeof v === "string") entries.push({ name: k, value: v });
				}
			} else if (Array.isArray(read.value)) {
				for (const item of read.value) {
					if (
						isPlainRecord(item) &&
						typeof item.name === "string" &&
						typeof (item.hex ?? item.value) === "string"
					) {
						entries.push({ name: item.name, value: String(item.hex ?? item.value) });
					}
				}
			}
			const title = block.heading ?? "Palette";
			if (entries.length === 0) return wrap(title, `<div class="pv-empty">No palette colours yet</div>`, false);
			return wrap(
				title,
				`<div class="pv-swatches">${entries.map((c) => `<div class="pv-swatch"><span class="pv-swatch-chip" style="background:${escapeHtml(c.value)}"></span><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.value)}</small></div>`).join("")}</div>`,
				true,
			);
		}
		case "brand_mark": {
			const title = block.heading ?? "Mark";
			const svgText = reader.fileText(block.from);
			const bin = reader.binary(block.from);
			const known = reader.knownBinary(block.from);
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			let visual = "";
			if (svgText && /<svg[\s>]/i.test(svgText)) {
				const rawBytes = Buffer.byteLength(svgText, "utf8");
				if (rawBytes <= MAX_INLINE_SVG_BYTES) {
					const sanitized = sanitizeInlineSvg(svgText);
					const svgBytes = Buffer.byteLength(sanitized, "utf8");
					if (inlineBudget.svgUsed + svgBytes <= MAX_TOTAL_INLINE_SVG_BYTES) {
						inlineBudget.svgUsed += svgBytes;
						visual = `<div class="pv-mark-svg">${sanitized}</div>`;
					}
				}
				if (!visual) {
					const kb = Math.max(1, Math.round(rawBytes / 1024));
					visual = `<div class="pv-art-badge">SVG · ${kb} KB</div>`;
				}
			} else if (
				bin &&
				bin.bytes.byteLength <= MAX_INLINE_IMAGE_BYTES &&
				inlineBudget.imageUsed + bin.bytes.byteLength <= MAX_TOTAL_INLINE_IMAGES_BYTES
			) {
				inlineBudget.imageUsed += bin.bytes.byteLength;
				const b64 = Buffer.from(bin.bytes).toString("base64");
				visual = `<img class="pv-mark-img" src="data:${escapeHtml(bin.mediaType)};base64,${b64}" alt="${escapeHtml(title)}"/>`;
			} else if (bin) {
				visual = `<div class="pv-art-badge">${escapeHtml(bin.mediaType)} · ${Math.round(bin.bytes.byteLength / 1024)} KB</div>`;
			} else if (known) {
				const rel = known.path.startsWith(rootPrefix) ? known.path.slice(rootPrefix.length) : undefined;
				if (known.meta.inCompanyMount && rel && known.meta.mediaType.startsWith("image/")) {
					visual = `<img class="pv-mark-img" src="/company-asset/${encodeURI(rel)}" alt="${escapeHtml(title)}"/>`;
				} else {
					visual = `<div class="pv-art-badge">${escapeHtml(known.meta.mediaType)} · ${Math.round(known.meta.bytes / 1024)} KB</div>`;
				}
			}
			if (!visual) {
				warnings.push(`Brand mark "${title}" (${block.from}) is missing.`);
				return wrap(title, `<div class="pv-empty">No mark staged yet</div>`, false);
			}
			const grounds = block.grounds.map((g) => `<div class="pv-mark-ground is-${g}">${visual}</div>`).join("");
			return wrap(title, `<div class="pv-marks">${grounds}</div>`, true);
		}
		case "table": {
			const read = reader.readSource(block.from);
			const rows = Array.isArray(read.value) ? read.value.filter(isPlainRecord) : [];
			const title = block.heading ?? "Table";
			if (rows.length === 0) return wrap(title, `<div class="pv-empty">No rows yet</div>`, false);
			const cols =
				block.columns?.map((c) => ({ key: c.key, label: c.label })) ??
				Object.keys(rows[0]!)
					.slice(0, 8)
					.map((k) => ({ key: k, label: k }));
			const head = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
			const body = rows
				.slice(0, 20)
				.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(r[c.key] ?? ""))}</td>`).join("")}</tr>`)
				.join("");
			return wrap(
				title,
				`<div class="pv-table-wrap"><table class="pv-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
				true,
			);
		}
		case "cards": {
			const title = block.heading ?? "Cards";
			const cards: { title: string; body: string; badge?: string }[] = [];
			if ("items" in block) {
				for (const item of block.items) {
					const got = reader.readSource(item.from);
					if (got.found && got.value !== undefined && got.value !== null) {
						cards.push({
							title: item.title,
							body: typeof got.value === "string" ? got.value : JSON.stringify(got.value),
						});
					}
				}
			} else {
				const got = reader.readSource(block.from);
				if (Array.isArray(got.value)) {
					for (const item of got.value) {
						if (!isPlainRecord(item)) continue;
						const cardTitle = String(item[block.title] ?? "");
						const lines = block.lines
							.map((k) => String(item[k] ?? ""))
							.filter(Boolean)
							.join(" · ");
						const badge = block.badge && item[block.badge] ? String(item[block.badge]) : undefined;
						cards.push({ title: cardTitle, body: lines, ...(badge ? { badge } : {}) });
					}
				}
			}
			if (cards.length === 0) return wrap(title, `<div class="pv-empty">No cards yet</div>`, false);
			return wrap(
				title,
				`<div class="pv-grid">${cards.map((c) => `<article class="pv-card"><div class="pv-card-top"><strong>${escapeHtml(c.title)}</strong>${c.badge ? `<span class="pv-badge">${escapeHtml(c.badge)}</span>` : ""}</div><p>${escapeHtml(c.body.slice(0, 320))}</p></article>`).join("")}</div>`,
				true,
			);
		}
		case "spec_list": {
			const read = reader.readSource(block.from);
			const title = block.heading ?? "Specifications";
			if (!isPlainRecord(read.value)) return wrap(title, `<div class="pv-empty">No specs yet</div>`, false);
			const skip = new Set(block.skip ?? []);
			const rows = Object.entries(read.value)
				.filter(([k]) => !skip.has(k))
				.slice(0, 20)
				.map(
					([k, v]) =>
						`<div class="pv-spec-row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v))}</strong></div>`,
				)
				.join("");
			return wrap(
				title,
				rows ? `<div class="pv-specs">${rows}</div>` : `<div class="pv-empty">No specs yet</div>`,
				Boolean(rows),
			);
		}
		case "artifacts": {
			const title = block.heading ?? "Artifacts";
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			const candidates = [
				...new Set([
					...Object.keys(snapshot.files),
					...Object.keys(snapshot.binaries),
					...Object.keys(snapshot.knownBinaries ?? {}),
				]),
			]
				.filter((p) => p.startsWith(rootPrefix) && p !== `${rootPrefix}${SURFACE_LAYOUT_PATH}`)
				.filter((p) => {
					const rel = p.slice(rootPrefix.length);
					const matched =
						!block.match || block.match.some((g) => surfaceGlobMatches(g, g.startsWith("/") ? `/${p}` : rel));
					const skipped = block.skip?.some((g) => surfaceGlobMatches(g, g.startsWith("/") ? `/${p}` : rel));
					return matched && !skipped;
				})
				.slice(0, 12);
			if (candidates.length === 0) return wrap(title, `<div class="pv-empty">No artifacts staged yet</div>`, false);
			const cards = candidates
				.map((fullPath) => {
					const rel = fullPath.slice(rootPrefix.length);
					const bin = snapshot.binaries[fullPath];
					const known = snapshot.knownBinaries?.[fullPath];
					const txt = snapshot.files[fullPath];
					if (
						bin?.mediaType.startsWith("image/") &&
						bin.bytes.byteLength <= MAX_INLINE_IMAGE_BYTES &&
						inlineBudget.imageUsed + bin.bytes.byteLength <= MAX_TOTAL_INLINE_IMAGES_BYTES
					) {
						inlineBudget.imageUsed += bin.bytes.byteLength;
						const b64 = Buffer.from(bin.bytes).toString("base64");
						return `<figure class="pv-art-card"><img src="data:${escapeHtml(bin.mediaType)};base64,${b64}" alt="${escapeHtml(rel)}"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (bin) {
						const kb = Math.max(1, Math.round(bin.bytes.byteLength / 1024));
						return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">${escapeHtml(rel.split(".").pop()?.toUpperCase() ?? "FILE")} · ${kb} KB</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (known?.inCompanyMount && known.mediaType.startsWith("image/")) {
						return `<figure class="pv-art-card"><img src="/company-asset/${encodeURI(rel)}" alt="${escapeHtml(rel)}"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (known) {
						const kb = Math.max(1, Math.round(known.bytes / 1024));
						return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">${escapeHtml(rel.split(".").pop()?.toUpperCase() ?? "FILE")} · ${kb} KB</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (txt && rel.toLowerCase().endsWith(".svg") && /<svg[\s>]/i.test(txt)) {
						const rawBytes = Buffer.byteLength(txt, "utf8");
						if (rawBytes <= MAX_INLINE_SVG_BYTES) {
							const sanitized = sanitizeInlineSvg(txt);
							const svgBytes = Buffer.byteLength(sanitized, "utf8");
							if (inlineBudget.svgUsed + svgBytes <= MAX_TOTAL_INLINE_SVG_BYTES) {
								inlineBudget.svgUsed += svgBytes;
								return `<figure class="pv-art-card"><div class="pv-art-svg">${sanitized}</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
							}
						}
						const kb = Math.max(1, Math.round(rawBytes / 1024));
						return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">SVG · ${kb} KB</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">${escapeHtml(rel.split(".").pop()?.toUpperCase() ?? "FILE")}</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
				})
				.join("");
			return wrap(title, `<div class="pv-art-grid">${cards}</div>`, true);
		}
		case "report": {
			const title = block.heading ?? "Reports";
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			const matches =
				"from" in block
					? [resolveCompanyPath(snapshot.folderRoot, block.from)].filter((p): p is string =>
							Boolean(p && (snapshot.files[p] || snapshot.binaries[p] || snapshot.knownBinaries?.[p])),
						)
					: [
							...new Set([
								...Object.keys(snapshot.files),
								...Object.keys(snapshot.binaries),
								...Object.keys(snapshot.knownBinaries ?? {}),
							]),
						].filter((p) => {
							if (!p.startsWith(rootPrefix)) return false;
							const rel = p.slice(rootPrefix.length);
							return surfaceGlobMatches(block.match, block.match.startsWith("/") ? `/${p}` : rel);
						});
			if (matches.length === 0) return wrap(title, `<div class="pv-empty">No reports staged yet</div>`, false);
			const items = matches
				.slice(0, 6)
				.map((p) => {
					const txt = snapshot.files[p];
					if (txt && p.endsWith(".json")) {
						try {
							const parsed = JSON.parse(txt) as Record<string, unknown>;
							const rTitle = typeof parsed.title === "string" ? parsed.title : (p.split("/").pop() ?? p);
							const lead =
								typeof parsed.summary === "string"
									? parsed.summary
									: typeof parsed.subtitle === "string"
										? parsed.subtitle
										: "";
							return `<article class="pv-card"><strong>${escapeHtml(rTitle)}</strong>${lead ? `<p>${escapeHtml(lead.slice(0, 220))}</p>` : ""}</article>`;
						} catch {
							return `<article class="pv-card"><strong>${escapeHtml(p.split("/").pop() ?? p)}</strong></article>`;
						}
					}
					return `<article class="pv-card"><strong>${escapeHtml(p.split("/").pop() ?? p)}</strong></article>`;
				})
				.join("");
			return wrap(title, `<div class="pv-grid">${items}</div>`, true);
		}
		case "explainer": {
			const title = block.heading ?? "Explainer";
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			const matches =
				"from" in block
					? [resolveCompanyPath(snapshot.folderRoot, block.from)].filter((p): p is string =>
							Boolean(p && snapshot.files[p]),
						)
					: Object.keys(snapshot.files).filter((p) => {
							if (!p.startsWith(rootPrefix)) return false;
							return surfaceGlobMatches(block.match, p.slice(rootPrefix.length));
						});
			if (matches.length === 0) return wrap(title, `<div class="pv-empty">No explainer staged yet</div>`, false);
			return wrap(
				title,
				`<div class="pv-grid">${matches.map((p) => `<article class="pv-card is-accent"><strong>${escapeHtml(p.slice(rootPrefix.length))}</strong><p>Animated breakdown ready</p></article>`).join("")}</div>`,
				true,
			);
		}
		case "module": {
			const title = block.heading ?? "Interactive module";
			const htmlPath = resolveCompanyPath(snapshot.folderRoot, `${block.from.replace(/\/+$/, "")}/index.html`);
			const html = htmlPath ? snapshot.files[htmlPath] : undefined;
			if (!html) {
				warnings.push(`Module block "${title}" (${block.from}/index.html) is missing.`);
				return wrap(title, `<div class="pv-empty">Module not built yet</div>`, false);
			}
			const h = typeof block.height === "number" ? block.height : 360;
			const escaped = escapeHtml(html);
			const modBytes = Buffer.byteLength(escaped, "utf8");
			if (
				modBytes <= MAX_INLINE_MODULE_BYTES &&
				inlineBudget.moduleUsed + modBytes <= MAX_TOTAL_INLINE_MODULES_BYTES
			) {
				inlineBudget.moduleUsed += modBytes;
				return wrap(
					title,
					`<iframe class="pv-module" style="height:${h}px" sandbox="allow-scripts" srcdoc="${escaped}"></iframe>`,
					true,
				);
			}
			const kb = Math.max(1, Math.round(Buffer.byteLength(html, "utf8") / 1024));
			return wrap(
				title,
				`<div class="pv-art-card is-doc"><div class="pv-art-badge">HTML MODULE · ${kb} KB</div><figcaption>${escapeHtml(block.from)}/index.html</figcaption></div>`,
				true,
			);
		}
		case "swatch_row":
		case "type_specimen":
		case "stage_3d": {
			const title = "heading" in block && block.heading ? block.heading : block.type;
			const hasSource =
				"from" in block
					? reader.readSource(block.from).found
					: "model" in block
						? reader.readSource(block.model).found
						: false;
			return wrap(
				title,
				`<div class="pv-empty">${hasSource ? `${escapeHtml(block.type)} configured` : `Empty ${escapeHtml(block.type)}`}</div>`,
				hasSource,
			);
		}
		default:
			return wrap("Block", `<div class="pv-empty">Unknown block</div>`, false);
	}
}

export function renderStudioPreviewHtml(options: {
	readonly snapshot: StudioInspectSnapshot;
	readonly tabId?: string;
	readonly theme: InspectSurfaceTheme;
}): RenderedStudioPreview {
	const { snapshot, theme } = options;
	const layoutPath = snapshot.folderRoot ? `${snapshot.folderRoot}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH;
	const layoutText = snapshot.files[layoutPath];
	const read = layoutText === undefined ? undefined : readSurfaceLayout(layoutText);
	const layout: SurfaceLayoutRead = read && "layout" in read ? read.layout : starterSurfaceLayout(snapshot.starter);
	const tabs = layout.tabs.map((tab) => ({ id: tab.id, title: tab.title }));
	let activeTab: SurfaceTab<SurfaceReadNode> | undefined;
	if (options.tabId) {
		activeTab = layout.tabs.find((tab) => tab.id === options.tabId);
		if (!activeTab) {
			throw new CloudToolArgumentRefusal(
				`Tab "${options.tabId}" was not found. Available tabs: ${tabs.map((t) => t.id).join(", ")}`,
			);
		}
	} else {
		activeTab = layout.tabs[0]!;
	}

	const dark = theme === "dark";
	const reader = createSnapshotReader(snapshot);
	const renderedBlocks: { readonly type: string; readonly heading: string; readonly filled: boolean }[] = [];
	const warnings: string[] = [];
	const inlineBudget = { imageUsed: 0, svgUsed: 0, moduleUsed: 0 };
	if (read && "problem" in read) {
		warnings.push(`layout.json parse warning (using starter fallback): ${read.problem}`);
	}

	const nodesHtml = activeTab.blocks
		.map((node) => {
			if (node.type === "row") {
				const cells = node.blocks
					.map(
						(child) =>
							`<div class="pv-row-cell">${renderBlockHtml(child, snapshot, reader, dark, inlineBudget, renderedBlocks, warnings)}</div>`,
					)
					.join("");
				return `<div class="pv-row" style="--cols:${node.blocks.length}">${cells}</div>`;
			}
			return renderBlockHtml(node, snapshot, reader, dark, inlineBudget, renderedBlocks, warnings);
		})
		.join("\n");

	const tokensCss = snapshot.files[IDENTITY_TOKENS_CSS_PATH];
	const tabBar =
		tabs.length > 1
			? `<nav class="pv-tabs">${tabs.map((t) => `<span class="pv-tab${t.id === activeTab!.id ? " is-on" : ""}">${escapeHtml(t.title)}</span>`).join("")}</nav>`
			: "";

	const html = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(snapshot.surfaceTitle)} — ${escapeHtml(activeTab.title)}</title>
${tokensCss ? `<style>${sanitizeInlineCss(tokensCss)}</style>` : ""}
<style>
:root{--bg:${dark ? "#141514" : "#faf9f6"};--pane:${dark ? "#1d1f1e" : "#ffffff"};--text:${dark ? "#f4f3f0" : "#161615"};--muted:${dark ? "#b8b7b2" : "#686866"};--border:${dark ? "rgba(255,255,255,0.1)" : "rgba(18,18,17,0.09)"};--accent:var(--studio-accent,${dark ? "#e5835c" : "#d76f45"});--good:${dark ? "#5ed6a9" : "#0f7a55"};--warn:${dark ? "#f2c35d" : "#9a6300"};--bad:${dark ? "#ff9084" : "#b33a2f"};--font:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.5;-webkit-font-smoothing:antialiased}
.pv-page{max-width:1080px;margin:0 auto;padding:28px 28px 48px;display:grid;gap:24px}
.pv-tabs{display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--border);padding-bottom:12px}
.pv-tab{padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;color:var(--muted)}
.pv-tab.is-on{background:var(--text);color:var(--bg)}
.pv-hero h1{margin:0;font-size:32px;letter-spacing:-0.02em;line-height:1.15}
.pv-hero-line{margin:8px 0 0;color:var(--muted);font-size:16px}
.pv-section{display:grid;gap:12px;min-width:0}
.pv-section-head h2{margin:0;font-size:17px;font-weight:680;letter-spacing:-0.01em}
.pv-sub,.pv-caption,.pv-wedge{margin:0;color:var(--muted);font-size:13.5px}
.pv-row{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:18px;align-items:start}
.pv-row-cell{min-width:0}
.pv-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.pv-fact{padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:var(--pane)}
.pv-fact-val{font-size:22px;font-weight:700;letter-spacing:-0.02em}
.pv-fact-lbl{margin-top:4px;font-size:12px;color:var(--muted)}
.pv-chart-card{border:1px solid var(--border);border-radius:16px;background:var(--pane);padding:12px}
.pv-svg{display:block;width:100%;height:auto}
.pv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.pv-card{padding:16px;border:1px solid var(--border);border-radius:16px;background:var(--pane);display:grid;gap:8px;align-content:start}
.pv-card.is-accent{border-color:var(--accent)}
.pv-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pv-card p{margin:0;font-size:13px;color:var(--muted)}
.pv-badge{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:680;background:var(--border);color:var(--text)}
.pv-badge.is-accent{background:var(--accent);color:#fff}
.pv-badge.is-fatal{background:var(--bad);color:#fff}
.pv-badge.is-high{background:var(--warn);color:#fff}
.pv-pills{display:flex;flex-wrap:wrap;gap:6px}
.pv-pill{padding:5px 11px;border-radius:999px;border:1px solid var(--border);background:var(--pane);font-size:12px;font-weight:600}
.pv-pill.is-accent{border-color:var(--accent);color:var(--accent)}
.pv-list,.pv-specs{display:grid;border-top:1px solid var(--border)}
.pv-hyp-row,.pv-spec-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 4px;border-bottom:1px solid var(--border);font-size:13px}
.pv-muted{color:var(--muted);font-size:12px}
.pv-swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.pv-swatch{display:grid;gap:4px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--pane);font-size:12px}
.pv-swatch-chip{height:44px;border-radius:8px;border:1px solid var(--border)}
.pv-marks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.pv-mark-ground{display:grid;place-items:center;min-height:140px;padding:20px;border-radius:16px;border:1px solid var(--border)}
.pv-mark-ground.is-light{background:#ffffff;color:#111}
.pv-mark-ground.is-dark{background:#111211;color:#fff}
.pv-mark-svg svg,.pv-mark-img{max-width:180px;max-height:96px;display:block}
.pv-table-wrap{overflow:hidden;border:1px solid var(--border);border-radius:14px;background:var(--pane)}
.pv-table{width:100%;border-collapse:collapse;font-size:12.5px}
.pv-table th,.pv-table td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border)}
.pv-table th{color:var(--muted);font-weight:650}
.pv-art-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.pv-art-card{margin:0;border:1px solid var(--border);border-radius:14px;background:var(--pane);overflow:hidden;display:grid}
.pv-art-card img,.pv-art-svg svg{display:block;width:100%;max-height:240px;object-fit:contain;background:var(--bg)}
.pv-art-card figcaption{padding:8px 12px;font-size:12px;color:var(--muted);border-top:1px solid var(--border)}
.pv-art-badge{display:grid;place-items:center;height:110px;font-weight:700;color:var(--muted);font-size:18px}
.pv-module{width:100%;border:1px solid var(--border);border-radius:16px;background:var(--pane)}
.pv-empty{padding:18px;border:1px dashed var(--border);border-radius:14px;color:var(--muted);font-size:13px}
@media (max-width:640px){.pv-page{padding:18px 14px 36px}.pv-row{grid-template-columns:minmax(0,1fr)}}
</style>
</head>
<body>
<main class="pv-page">
${tabBar}
${nodesHtml}
</main>
</body>
</html>`;

	return {
		html,
		activeTab: { id: activeTab.id, title: activeTab.title },
		tabs,
		renderedBlocks,
		warnings,
	};
}

async function runMachineStep(options: {
	readonly machine: StudioChatGptVoiceMachine;
	readonly key: string;
	readonly command: string;
	readonly timeoutMs: number;
	readonly context: CloudToolContext;
	readonly pollMs: number;
}): Promise<{ readonly exitCode: number | null; readonly state: string; readonly output: string }> {
	const { machine, key, command, timeoutMs, context, pollMs } = options;
	const { scope, operations, gateway } = machine;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		) {
			throw new Error("Coding command result differs");
		}
		return receipt;
	};

	const cancelOnAbort = async (commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CANCEL_ON_ABORT_MS);
		timer.unref?.();
		try {
			await gateway.cancel(scope, commandId, controller.signal);
		} catch {
			return;
		} finally {
			clearTimeout(timer);
		}
	};

	const childObservation = context.observation?.child("coding_run_command");
	let startedRunningId: string | null = null;
	let startContent: { kind: string; value?: unknown };
	try {
		startContent = await operations.execute({
			operation: {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: key,
				arguments: { operationKey: key, command, timeoutMs },
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, effect) => {
				const started = checkedReceipt(
					await gateway.start(
						scope,
						{
							commandId: effect.receiptId,
							inputSha256: effect.inputSha256,
							command,
							timeoutMs,
						},
						effect.signal,
					),
					effect.receiptId,
					effect.inputSha256,
				);
				if (started.state === "running") startedRunningId = started.commandId;
				return { content: { kind: "json", value: started as unknown as JsonValue } };
			},
			signal: context.signal,
			...(childObservation ? { observation: childObservation } : {}),
		});
	} catch (error) {
		if (context.signal.aborted && startedRunningId !== null) await cancelOnAbort(startedRunningId);
		throw error;
	}
	if (startContent.kind !== "json") throw new Error("Coding command result differs");
	let current = parseCloudCodingCommandReceipt(startContent.value);

	const readReceipt = async (commandId: string, offset: number, limit: number): Promise<CloudCodingCommandReceipt> => {
		const parsed = parseCloudCodingCommandRead({ commandId, offset, limit });
		return checkedReceipt(
			await cloudToolRequest((requestSignal) => gateway.read(scope, parsed, requestSignal), context.signal),
			commandId,
		);
	};

	const deadline = Date.now() + timeoutMs + 5_000;
	let delay = pollMs;
	while (current.state === "running") {
		if (context.signal.aborted) {
			await cancelOnAbort(current.commandId);
			context.signal.throwIfAborted();
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			await cancelOnAbort(current.commandId);
			throw new CloudToolRefusal("INSPECT_SURFACE_TIMEOUT: rendering the Studio screenshot timed out.");
		}
		try {
			await cloudControlPause(Math.min(delay, remaining), context.signal);
		} catch (error) {
			if (context.signal.aborted) await cancelOnAbort(current.commandId);
			throw error;
		}
		delay = Math.min(1000, Math.max(pollMs, Math.round(delay * 1.5)));
		current = await readReceipt(current.commandId, current.log.totalBytes, 4);
	}

	if (
		current.log.limitReached ||
		current.log.gapBytes !== undefined ||
		current.log.totalBytes > MAX_BASE64_OUTPUT_BYTES
	) {
		throw new CloudToolRefusal("INSPECT_SURFACE_TOO_LARGE: screenshot exceeded the transfer bound.");
	}
	const chunks: string[] = [];
	let cursor = 0;
	if (current.log.offset === 0 && current.output.length > 0) {
		chunks.push(current.output);
		cursor = current.log.nextOffset;
	}
	const total = current.log.totalBytes;
	while (cursor < total) {
		context.signal.throwIfAborted();
		const page = await readReceipt(
			current.commandId,
			cursor,
			Math.max(4, Math.min(CLOUD_CODING_COMMAND_PAGE_BYTES, total - cursor)),
		);
		if (page.log.offset !== cursor || page.log.nextOffset <= cursor) break;
		chunks.push(page.output);
		cursor = page.log.nextOffset;
	}
	return { exitCode: current.exitCode, state: current.state, output: chunks.join("") };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createInspectSurfaceTool(options: InspectSurfaceToolOptions): CloudNativeTool {
	const pollMs = options.pollMs ?? 150;
	const parseArgs = (
		value: unknown,
	): {
		readonly tab?: string;
		readonly theme: InspectSurfaceTheme;
		readonly viewport: InspectSurfaceViewport;
		readonly fullPage: boolean;
		readonly scrollY: number;
	} => {
		const allowed = ["tab", "theme", "viewport", "fullPage", "scrollY"];
		if (
			value !== undefined &&
			value !== null &&
			(!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)))
		) {
			throw new CloudToolArgumentRefusal(
				"inspect_surface accepts optional tab, theme, viewport, fullPage, and scrollY",
			);
		}
		const rec = isPlainRecord(value) ? value : {};
		const tab =
			rec.tab === undefined
				? undefined
				: typeof rec.tab === "string" && rec.tab.trim().length > 0 && rec.tab.trim().length <= 64
					? rec.tab.trim()
					: null;
		if (tab === null) {
			throw new CloudToolArgumentRefusal("tab must be a non-empty tab ID string");
		}
		const theme =
			rec.theme === undefined ? "light" : rec.theme === "light" || rec.theme === "dark" ? rec.theme : null;
		if (theme === null) {
			throw new CloudToolArgumentRefusal('theme must be "light" or "dark"');
		}
		const viewport =
			rec.viewport === undefined
				? "desktop"
				: rec.viewport === "desktop" || rec.viewport === "mobile"
					? rec.viewport
					: null;
		if (viewport === null) {
			throw new CloudToolArgumentRefusal('viewport must be "desktop" or "mobile"');
		}
		const fullPage = rec.fullPage === undefined ? false : typeof rec.fullPage === "boolean" ? rec.fullPage : null;
		if (fullPage === null) {
			throw new CloudToolArgumentRefusal("fullPage must be a boolean");
		}
		const scrollY =
			rec.scrollY === undefined
				? 0
				: typeof rec.scrollY === "number" &&
						Number.isInteger(rec.scrollY) &&
						rec.scrollY >= 0 &&
						rec.scrollY <= MAX_SCROLL_Y
					? rec.scrollY
					: null;
		if (scrollY === null) {
			throw new CloudToolArgumentRefusal(`scrollY must be an integer between 0 and ${MAX_SCROLL_Y}`);
		}
		return { ...(tab ? { tab } : {}), theme, viewport, fullPage, scrollY };
	};

	return {
		name: "inspect_surface" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		images: true,
		description: [
			"Render this Studio surface (including active Preview changes and anything you have already staged in this turn) in headless Chromium and return a crisp 1:1 PNG screenshot inline so you can visually audit layout, charts, diagrams, dark/light contrast, spacing, and empty homes.",
			"Defaults to a readable viewport screenshot (1280x800 desktop or 390x844 mobile); pass scrollY to inspect lower bands of tall pages or fullPage: true to capture up to 1800px.",
		].join("\n"),
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				tab: {
					type: "string",
					maxLength: 64,
					description: "Optional tab ID to render (defaults to the first tab).",
				},
				theme: {
					type: "string",
					enum: ["light", "dark"],
					description: "Color theme to render (defaults to light).",
				},
				viewport: {
					type: "string",
					enum: ["desktop", "mobile"],
					description: "Viewport preset: desktop (1280x800) or mobile (390x844). Defaults to desktop.",
				},
				fullPage: {
					type: "boolean",
					description: "Capture up to 1800px tall (true) or crisp single viewport at scrollY (false, default).",
				},
				scrollY: {
					type: "integer",
					minimum: 0,
					maximum: MAX_SCROLL_Y,
					description: "Vertical scroll offset in CSS px when fullPage is false (default 0).",
				},
			},
		},
		parseArguments(value) {
			const args = parseArgs(value);
			return {
				...(args.tab ? { tab: args.tab } : {}),
				theme: args.theme,
				viewport: args.viewport,
				fullPage: args.fullPage,
				scrollY: args.scrollY,
			};
		},
		async execute(rawArgs, context: CloudToolContext) {
			const args = parseArgs(rawArgs);
			const snapshot = await options.loadSnapshot(context.signal);
			const rendered = renderStudioPreviewHtml({
				snapshot,
				...(args.tab ? { tabId: args.tab } : {}),
				theme: args.theme,
			});
			const htmlBytes = Buffer.from(rendered.html, "utf8");
			if (htmlBytes.byteLength > MAX_PREVIEW_HTML_BYTES) {
				throw new CloudToolRefusal("INSPECT_SURFACE_TOO_LARGE: rendered preview exceeded the size limit.");
			}
			const gzB64 = gzipSync(htmlBytes).toString("base64");
			const chunkCount = Math.ceil(gzB64.length / UPLOAD_CHUNK_BYTES);
			if (chunkCount > MAX_UPLOAD_CHUNKS) {
				throw new CloudToolRefusal("INSPECT_SURFACE_TOO_LARGE: compressed preview exceeded the upload bound.");
			}

			const tag = createHash("sha256")
				.update(
					`${options.machine.identity.runId}:${context.callId}:${rendered.activeTab.id}:${args.theme}:${args.viewport}:${args.scrollY}`,
				)
				.digest("hex")
				.slice(0, 20);
			const work = `${WORK_ROOT}-${tag}`;

			const init = await runMachineStep({
				machine: options.machine,
				key: `studio-inspect:${tag}:init`,
				command: `rm -rf ${work} && mkdir -p ${work}/site && cat > ${work}/capture.cjs <<'${SCRIPT_END}'\n${CAPTURE_SCRIPT_CJS}\n${SCRIPT_END}\n: > ${work}/site/index.html.gz.b64`,
				timeoutMs: SETUP_TIMEOUT_MS,
				context,
				pollMs,
			});
			if (init.state !== "succeeded") {
				throw new CloudToolRefusal(
					`INSPECT_SURFACE_UNAVAILABLE: could not prepare Studio preview on the coding machine (exit ${init.exitCode ?? init.state}).`,
				);
			}

			for (let offset = 0, part = 0; offset < gzB64.length; offset += UPLOAD_CHUNK_BYTES, part += 1) {
				const slice = gzB64.slice(offset, offset + UPLOAD_CHUNK_BYTES);
				const step = await runMachineStep({
					machine: options.machine,
					key: `studio-inspect:${tag}:chunk:${part}`,
					command: `printf '%s' '${slice}' >> ${work}/site/index.html.gz.b64`,
					timeoutMs: SETUP_TIMEOUT_MS,
					context,
					pollMs,
				});
				if (step.state !== "succeeded") {
					throw new CloudToolRefusal(
						`INSPECT_SURFACE_UNAVAILABLE: could not upload Studio preview chunk (exit ${step.exitCode ?? step.state}).`,
					);
				}
			}

			const dims =
				args.viewport === "mobile"
					? { width: 390, height: 844, mobile: "1" }
					: { width: 1280, height: 800, mobile: "0" };
			const folderArg = snapshot.folderRoot ? shellQuote(snapshot.folderRoot) : "''";
			const capture = await runMachineStep({
				machine: options.machine,
				key: `studio-inspect:${tag}:capture`,
				command: `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" ${work}/capture.cjs ${work} ${dims.width} ${dims.height} ${dims.mobile} ${args.fullPage ? "1" : "0"} ${args.scrollY} ${folderArg} 2>/dev/null`,
				timeoutMs: CAPTURE_TIMEOUT_MS,
				context,
				pollMs,
			});

			if (capture.state !== "succeeded") {
				throw new CloudToolRefusal(
					`INSPECT_SURFACE_UNAVAILABLE: could not render Studio screenshot on the coding machine (exit ${capture.exitCode ?? capture.state}).`,
				);
			}
			let outputText = capture.output.trim();
			let scrollHeight = dims.height;
			let effectiveScrollY = args.scrollY;
			if (outputText.startsWith("QORPERA_META:")) {
				const nl = outputText.indexOf("\n");
				if (nl > 0) {
					try {
						const meta = JSON.parse(outputText.slice("QORPERA_META:".length, nl)) as Record<string, unknown>;
						if (typeof meta.scrollHeight === "number" && Number.isFinite(meta.scrollHeight)) {
							scrollHeight = Math.max(dims.height, Math.round(meta.scrollHeight));
						}
						if (typeof meta.scrollY === "number" && Number.isFinite(meta.scrollY)) {
							effectiveScrollY = Math.max(0, Math.round(meta.scrollY));
						}
					} catch {}
					outputText = outputText.slice(nl + 1);
				}
			}
			const rawPng = decodeInspectImageOutput(outputText);
			if (!rawPng) {
				throw new CloudToolRefusal("INSPECT_SURFACE_UNREADABLE: rendered screenshot payload was invalid or empty.");
			}

			let view: FolderImageView;
			try {
				view = await oneImageAtATime(context.signal, async () => folderImageView(rawPng));
			} catch (error) {
				if (!(error instanceof FolderImageRefusal)) throw error;
				throw new CloudToolRefusal(`INSPECT_SURFACE_UNREADABLE: ${error.message}.`);
			}

			const hasMoreBelow = !args.fullPage && effectiveScrollY + dims.height < scrollHeight;
			const answer: Record<string, JsonValue> = {
				schema: STUDIO_INSPECT_SURFACE_SCHEMA,
				ok: true,
				kind: "surface_screenshot",
				tab: rendered.activeTab.id,
				tabTitle: rendered.activeTab.title,
				tabs: rendered.tabs.map((tab) => ({ id: tab.id, title: tab.title })),
				theme: args.theme,
				viewport: args.viewport,
				fullPage: args.fullPage,
				scrollY: effectiveScrollY,
				scrollHeight,
				hasMoreBelow,
				width: view.width,
				height: view.height,
				shownWidth: view.shownWidth,
				shownHeight: view.shownHeight,
				imageSha256: view.sha256,
				renderedBlocks: rendered.renderedBlocks.map((b) => ({
					type: b.type,
					heading: b.heading,
					filled: b.filled,
				})),
				warnings: [...rendered.warnings],
			};
			return {
				kind: "json",
				value: answer,
				image: { png: view.png, sha256: view.sha256 },
			};
		},
	};
}
