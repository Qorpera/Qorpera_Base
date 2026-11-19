#!/bin/bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
IMAGE_SCRIPT=$REPO/deploy/machine/build-machine-image.sh
pin() { sed -n "s/^$1=//p" "$IMAGE_SCRIPT"; }
CHROMIUM_URL=$(pin CHROMIUM_URL)
CHROMIUM_SHA256=$(pin CHROMIUM_SHA256)
NODE_VERSION=${NODE_VERSION:-24.21.0}
NODE_SHA256=${NODE_SHA256:-fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6}
VM=qorpera-fill-probe-$(date -u +%H%M%S)-$$
WORK=$(mktemp -d)
L() { lxc "$@" </dev/null; }
X() { lxc exec "$VM" -- "$@" </dev/null; }
PROXY_PID=
cleanup() {
	[[ -z $PROXY_PID ]] || kill "$PROXY_PID" 2>/dev/null || true
	lxc delete --force "$VM" </dev/null >/dev/null 2>&1 || true
	rm -rf -- "$WORK"
}
trap cleanup EXIT
awk '/^\t# fill_company_account \(20260930781000\)/ { on = 1 } on { sub(/^\t/, ""); print } on && /^JS$/ { exit }' \
	"$IMAGE_SCRIPT" >"$WORK/fill-check.sh"
[[ $(head -1 "$WORK/fill-check.sh") == "# fill_company_account (20260930781000)"* && $(tail -1 "$WORK/fill-check.sh") == JS ]] ||
	{ echo "the image script's fill check was not found" >&2; exit 1; }
echo "desktop stop" >>"$WORK/fill-check.sh"
(cd "$REPO" && node -e '
	const { build } = require("esbuild");
	build({ absWorkingDir: process.cwd(), bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none",
		logLevel: "silent", entryPoints: ["packages/runtime/src/cloud-machine-account-fill-main.ts"], outfile: process.argv[1] })
		.catch((error) => { console.error(error.message); process.exit(1); });
' "$WORK/cloud-machine-account-fill.mjs")
BRIDGE=$(lxc network get lxdbr0 ipv4.address </dev/null)
BRIDGE=${BRIDGE%/*}
node -e '
	const http = require("node:http");
	const net = require("node:net");
	const server = http.createServer((request, reply) => {
		const target = new URL(request.url);
		const upstream = http.request({ host: target.hostname, port: target.port || 80, path: target.pathname + target.search,
			method: request.method, headers: request.headers }, (answer) => { reply.writeHead(answer.statusCode, answer.headers); answer.pipe(reply); });
		upstream.on("error", () => reply.destroy());
		request.pipe(upstream);
	});
	server.on("connect", (request, client, head) => {
		const [host, port] = request.url.split(":");
		const upstream = net.connect(Number(port), host, () => { client.write("HTTP/1.1 200 OK\r\n\r\n"); upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
	});
	server.listen(3128, process.argv[1]);
' "$BRIDGE" &
PROXY_PID=$!
L init nested-probe-image "$VM" --vm -c limits.cpu=4 -c limits.memory=6GiB -d root,size=16GiB -c boot.autostart=false >/dev/null
L start "$VM"
for _ in $(seq 1 300); do X systemctl is-active --quiet basic.target 2>/dev/null && break; sleep 1; done
X systemctl is-system-running --wait >/dev/null 2>&1 || true
X env http_proxy="http://$BRIDGE:3128" https_proxy="http://$BRIDGE:3128" NODE_VERSION="$NODE_VERSION" NODE_SHA256="$NODE_SHA256" CHROMIUM_URL="$CHROMIUM_URL" CHROMIUM_SHA256="$CHROMIUM_SHA256" \
	bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	echo "Acquire::http::Proxy \"$http_proxy\";" >/etc/apt/apt.conf.d/90proxy
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends ca-certificates curl unzip xz-utils openssl iproute2 procps \
		tigervnc-standalone-server xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal xfconf thunar dbus-x11 \
		adwaita-icon-theme x11-utils x11-xserver-utils xdotool wmctrl scrot xsel apparmor \
		libnss3 libnspr4 libasound2t64 libgbm1 libcups2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
		libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 libx11-6 libxcb1 libpango-1.0-0 \
		libcairo2 libdbus-1-3 libexpat1 libglib2.0-0t64 libdrm2 libudev1 fonts-dejavu-core >/dev/null
	curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
	echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - >/dev/null
	tar -xJf /tmp/node.tar.xz -C /opt
	ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node
	ln -sf /opt/node/bin/node /usr/bin/node
	curl -fsSLo /tmp/chromium.zip "$CHROMIUM_URL"
	echo "${CHROMIUM_SHA256}  /tmp/chromium.zip" | sha256sum -c - >/dev/null
	unzip -q /tmp/chromium.zip -d /tmp/chromium
	mv /tmp/chromium/chrome-linux64 /usr/lib/qorpera-chromium
	rm -rf /tmp/chromium.zip /tmp/chromium /tmp/node.tar.xz
	rm -f /etc/apt/apt.conf.d/90proxy
	useradd --create-home --shell /bin/bash --user-group desktop
	install -d -o root -g root -m 0755 /opt/qorpera-machine /etc/qorpera-machine /usr/share/qorpera-desktop \
		/etc/opt/chrome_for_testing/policies/managed
'
M=$REPO/deploy/machine
push() { L file push "$1" "$VM$2" --uid 0 --gid 0 --mode "$3"; }
push "$WORK/cloud-machine-account-fill.mjs" /opt/qorpera-machine/cloud-machine-account-fill.mjs 0444
push "$M/desktop-session" /opt/qorpera-machine/desktop-session 0555
push "$M/desktop" /usr/local/bin/desktop 0555
push "$M/qorpera-chromium.apparmor" /etc/apparmor.d/qorpera-chromium 0644
push "$M/chromium" /usr/local/bin/chromium 0555
push "$M/qorpera-chromium-policy.json" /etc/opt/chrome_for_testing/policies/managed/qorpera.json 0644
push "$M/desktop-look" /opt/qorpera-machine/desktop-look 0555
push "$M/desktop-dock-open" /opt/qorpera-machine/desktop-dock-open 0555
push "$M/desktop-files" /opt/qorpera-machine/desktop-files 0555
push "$M/qorpera-machine-desktop.tmpfiles" /etc/tmpfiles.d/qorpera-machine-desktop.conf 0644
for unit in qorpera-machine.slice qorpera-machine-desktop.service qorpera-machine-desktop-dock.path \
	qorpera-machine-desktop-dock.service; do
	push "$M/$unit" "/etc/systemd/system/$unit" 0644
done
push "$WORK/fill-check.sh" /root/fill-check.sh 0500
X bash -euo pipefail -c '
	systemctl daemon-reload
	systemd-tmpfiles --create /etc/tmpfiles.d/qorpera-machine-desktop.conf
	apparmor_parser -r /etc/apparmor.d/qorpera-chromium
	echo "profile: $(grep -c "^qorpera-chromium " /sys/kernel/security/apparmor/profiles) loaded; userns restricted: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo -)"
	echo "node $(node --version), $(/usr/lib/qorpera-chromium/chrome --version)"
'
status=0
X bash -euo pipefail /root/fill-check.sh || status=$?
if (( status != 0 )); then
	X bash -c '
		desktop start >/dev/null 2>&1 || true
		desktop run chromium --user-data-dir=/home/desktop/.config/qorpera-chromium --remote-debugging-port=0 --no-first-run about:blank >/dev/null
		sleep 4
		for pid in $(pgrep -f "^/usr/lib/qorpera-chromium/chrome" || true); do
			echo "pid $pid exe=$(readlink /proc/$pid/exe 2>&1) uid=$(awk "/^Uid:/ {print \$2}" /proc/$pid/status) label=$(cat /proc/$pid/attr/current 2>&1)"
			echo "  cmdline: $(tr "\0" "|" </proc/$pid/cmdline | cut -c1-300)"
			echo "  fds: $(ls /proc/$pid/fd 2>&1 | wc -l) stat22=$(awk "{print \$22}" /proc/$pid/stat 2>&1)"
		done
		journalctl -k --no-pager | grep -i "apparmor=\"DENIED\"" | tail -5 || true
		desktop stop >/dev/null 2>&1 || true
	' || true
	echo "FILL CHECK FAILED (exit $status)"
	exit "$status"
fi
echo "FILL CHECK PASSED"
