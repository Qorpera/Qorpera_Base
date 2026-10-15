#!/bin/bash
# Build the coding machine image on an LXD node (run as root).
#
#   build-coding-image.sh <build-project> <build-network> <storage-pool> [coding-project ...] > image-build.json
#
# One image for every member's coding machine (RUNTIME-FOLDER-CODING-MACHINES.md, 5f): Ubuntu 26.04 with the
# common toolchains (C and C++, Python, Go, Rust, Java, Node), the pinned git as its only git, tmux, Chromium,
# rootful Docker for root and a rootless Docker daemon per session (started on first use), NOPASSWD sudo for the
# group every session's user joins, and the guest agent's place (/opt/qorpera-guest, filled by 5g). apt's and
# snapd's self-updates are gone, and so is cloud-init: a coding machine has no /dev/lxd (security.devlxd=false), so
# its network, hostname and root size come from the image. coding-image.json pins Node, git and Chromium by version
# and sha-256. README.md says what each installed file is for.
#
# The builder runs as build-machine-image.sh's does: in the node's declared image build space, as a build machine
# (no profiles, its own root disk, the isolation NIC, never autostarting, the builder marker), deleted on every
# exit path. It needs 4 CPUs and 4 GiB of the space, so build when the space is empty. The image goes into the
# store of every coding project named (default: coding), exported and imported where that store is not the build
# space's. QORPERA_BUILDER_NIC=plain leaves the NIC's filters off, for a test machine whose own nft rules and
# kernel modules must not change (test/prove-coding-image.sh); a node's observer refuses such a builder. On a test
# machine, whose bridge forwards nothing, QORPERA_BUILD_PROXY=http://<address>:<port> sends the builder's downloads
# through that proxy; nothing of it stays in the image.
set -euo pipefail
PROJECT=${1:?the build space project, for example qorpera-build}
NETWORK=${2:?the build space network, for example qorpera0}
POOL=${3:?the storage pool for the builder root, for example qorpera-vm}
shift 3
CODING=("$@")
(( ${#CODING[@]} > 0 )) || CODING=(coding)
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# Only the build record goes to stdout (> image-build.json); the builder's own output goes to stderr.
exec 3>&1 1>&2
HERE=$(cd "$(dirname "$0")" && pwd)
PINS=$HERE/coding-image.json
pin() { jq -er "$1" "$PINS"; }
[[ $(pin .schema) == qorpera.coding-image-pins/v1 && $(pin .base) == ubuntu:26.04 ]] || { echo "unexpected $PINS" >&2; exit 1; }
for tool in node git chromium; do
	[[ $(pin ".$tool.version") =~ ^[0-9]+(\.[0-9]+)+$ ]] || { echo "invalid $tool version" >&2; exit 1; }
	[[ $(pin ".$tool.url") =~ ^https://[A-Za-z0-9./_~%+-]+$ ]] || { echo "invalid $tool url" >&2; exit 1; }
	[[ $(pin ".$tool.sha256") =~ ^[0-9a-f]{64}$ ]] || { echo "invalid $tool sha-256" >&2; exit 1; }
done
NODE_VERSION=$(pin .node.version)
GIT_VERSION=$(pin .git.version)
CHROMIUM_VERSION=$(pin .chromium.version)
case ${QORPERA_BUILDER_NIC:-filtered} in
	filtered) NIC=(-d eth0,security.mac_filtering=true -d eth0,security.ipv4_filtering=true
		-d eth0,security.ipv6_filtering=true -d eth0,security.port_isolation=true) ;;
	plain) NIC=() ;;
	*) echo "QORPERA_BUILDER_NIC is filtered (the default) or plain" >&2; exit 1 ;;
esac
PROXY=${QORPERA_BUILD_PROXY:-}
[[ -z $PROXY || $PROXY =~ ^http://[0-9.]+:[0-9]+$ ]] || { echo "QORPERA_BUILD_PROXY is http://<IPv4 address>:<port>" >&2; exit 1; }
# What the image gets from this directory: source, destination, mode. The bootstrap digest covers each of them.
FILES=(
	"qorpera-dockerd.service /etc/systemd/user/qorpera-dockerd.service 0644"
	"qorpera-docker.socket /etc/systemd/user/qorpera-docker.socket 0644"
	"qorpera-docker-proxy.service /etc/systemd/user/qorpera-docker-proxy.service 0644"
	"qorpera-user-delegate.conf /etc/systemd/system/user@.service.d/qorpera-delegate.conf 0644"
	"qorpera-coding.sudoers /etc/sudoers.d/qorpera-coding 0440"
	"60-qorpera-coding.conf /etc/sysctl.d/60-qorpera-coding.conf 0644"
	"10-qorpera-coding.yaml /etc/netplan/10-qorpera-coding.yaml 0600"
	"qorpera-coding.tmpfiles /etc/tmpfiles.d/qorpera-coding.conf 0644"
	"qorpera-grow-root.service /etc/systemd/system/qorpera-grow-root.service 0644"
	"qorpera-grow-root /usr/local/libexec/qorpera-coding/qorpera-grow-root 0755"
	"../coding-worker/qorpera-coding.slice /etc/systemd/system/qorpera-coding.slice 0644"
)
for entry in "${FILES[@]}"; do
	read -r source _ _ <<<"$entry"
	[[ -f $HERE/$source ]] || { echo "missing $source" >&2; exit 1; }
done

STAMP=$(date -u +%Y%m%d%H%M%S)
BUILDER="qorpera-coding-build-$STAMP-$$"
ALIAS="qorpera-coding-$STAMP"
lx() { lxc --project "$PROJECT" "$@"; }
# A project without its own images uses the default project's store.
store() { if [[ $(lxc project get "$1" features.images) == true ]]; then echo "$1"; else echo default; fi; }
[[ $PROJECT != default ]] || { echo "the builder must run in the node's build space, not in $PROJECT" >&2; exit 1; }
for project in "${CODING[@]}"; do
	[[ $project != "$PROJECT" ]] || { echo "the builder must not run in the coding project $project" >&2; exit 1; }
	lxc project show "$project" >/dev/null || { echo "no project $project" >&2; exit 1; }
done
IN_SPACE=$(lx list -f csv -c n)
[[ -z $IN_SPACE ]] || { echo "the build space $PROJECT is in use: build when it is empty" >&2; exit 1; }
EXPORT=
cleanup() {
	lx delete --force "$BUILDER" >/dev/null 2>&1 || true
	[[ -z $EXPORT ]] || rm -rf -- "$EXPORT"
}
trap cleanup EXIT

# Made whole in one request (stdin closed: lxc init reads configuration from a stdin that is not a terminal). Its
# root is 16 GiB, the smallest coding machine disk: a machine's root can never be smaller than its image.
lx init ubuntu:26.04 "$BUILDER" --vm --no-profiles --storage "$POOL" -d root,size=16GiB -n "$NETWORK" "${NIC[@]}" \
	-c limits.cpu=4 -c limits.memory=4GiB -c boot.mode=uefi-secureboot -c boot.autostart=false \
	-c user.qorpera.image_builder=true -c user.qorpera.purpose=coding-image </dev/null
lx start "$BUILDER"
for _ in $(seq 1 90); do lx exec "$BUILDER" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$BUILDER" -- cloud-init status --wait >/dev/null
lx exec "$BUILDER" -- env \
	NODE_VERSION="$NODE_VERSION" NODE_URL="$(pin .node.url)" NODE_SHA256="$(pin .node.sha256)" \
	GIT_VERSION="$GIT_VERSION" GIT_URL="$(pin .git.url)" GIT_SHA256="$(pin .git.sha256)" \
	CHROMIUM_URL="$(pin .chromium.url)" CHROMIUM_SHA256="$(pin .chromium.sha256)" PROXY="$PROXY" bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	# A test machine'"'"'s proxy, given only in apt'"'"'s options and this environment, so the image keeps neither. It takes one
	# request per connection.
	APT=()
	if [[ -n $PROXY ]]; then
		export http_proxy=$PROXY https_proxy=$PROXY
		APT=(-o "Acquire::http::Proxy=$PROXY" -o "Acquire::https::Proxy=$PROXY" -o Acquire::http::Pipeline-Depth=0)
	fi
	apt-get "${APT[@]}" update
	# git is not among them: the pinned git, built below, is the only one. Its build libraries stay for agents.
	apt-get "${APT[@]}" install -y --no-install-recommends \
		ca-certificates curl gnupg jq unzip zip xz-utils zstd rsync less file patch procps psmisc lsof strace \
		iproute2 nftables iputils-ping bind9-dnsutils netcat-openbsd openssh-client tmux ripgrep fd-find tree sqlite3 \
		make cmake pkg-config build-essential autoconf automake libtool \
		python3 python3-venv python3-pip python3-dev python-is-python3 pipx golang-go rustc cargo default-jdk-headless \
		docker.io docker-compose-v2 docker-buildx rootlesskit slirp4netns passt uidmap dbus-user-session socat \
		fuse3 cloud-guest-utils \
		libcurl4-openssl-dev libexpat1-dev libpcre2-dev zlib1g-dev libssl-dev gettext \
		libnss3 libnspr4 libasound2t64 libgbm1 libcups2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
		libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 libx11-6 libxcb1 libpango-1.0-0 \
		libcairo2 libdbus-1-3 libexpat1 libglib2.0-0t64 libdrm2 libudev1 fonts-liberation fonts-noto-color-emoji
	curl -fsSLo /tmp/node.tar.xz "$NODE_URL"
	echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum -c -
	tar -xJf /tmp/node.tar.xz -C /opt
	ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node
	for tool in node npm npx corepack; do ln -sf "/opt/node/bin/$tool" "/usr/local/bin/$tool"; done
	ln -sf /opt/node/bin/node /usr/bin/node
	curl -fsSLo /tmp/git.tar.xz "$GIT_URL"
	echo "$GIT_SHA256  /tmp/git.tar.xz" | sha256sum -c -
	tar -xJf /tmp/git.tar.xz -C /tmp
	# /etc/gitconfig is the system configuration, as with Ubuntu'"'"'s git. With git'"'"'s Rust parts, built by the cargo
	# above (git'"'"'s default, which NO_RUST turns off; Git 3.0 needs them); their crate has no dependencies to fetch.
	GITMAKE=(prefix=/usr/local sysconfdir=/etc NO_TCLTK=YesPlease USE_LIBPCRE2=YesPlease)
	make -C "/tmp/git-$GIT_VERSION" -j"$(nproc)" "${GITMAKE[@]}" all >/tmp/git-build.log 2>&1 ||
		{ tail -n 60 /tmp/git-build.log; exit 1; }
	make -C "/tmp/git-$GIT_VERSION" "${GITMAKE[@]}" install >/tmp/git-build.log 2>&1 ||
		{ tail -n 60 /tmp/git-build.log; exit 1; }
	curl -fsSLo /tmp/chromium.zip "$CHROMIUM_URL"
	echo "$CHROMIUM_SHA256  /tmp/chromium.zip" | sha256sum -c -
	unzip -q /tmp/chromium.zip -d /tmp/chromium
	mv /tmp/chromium/chrome-linux64 /usr/lib/qorpera-chromium
	ln -sf /usr/lib/qorpera-chromium/chrome /usr/local/bin/chromium
	ln -sf /usr/bin/fdfind /usr/local/bin/fd
	rm -rf /tmp/node.tar.xz /tmp/git.tar.xz "/tmp/git-$GIT_VERSION" /tmp/git-build.log /tmp/chromium.zip /tmp/chromium
	install -d -o root -g root -m 0755 /company /opt/qorpera-guest /usr/local/libexec/qorpera-coding \
		/etc/systemd/system/user@.service.d
'
for entry in "${FILES[@]}"; do
	read -r source destination mode <<<"$entry"
	lx file push "$HERE/$source" "$BUILDER$destination" --uid 0 --gid 0 --mode "$mode"
done
lx exec "$BUILDER" -- env NODE_VERSION="$NODE_VERSION" GIT_VERSION="$GIT_VERSION" CHROMIUM_VERSION="$CHROMIUM_VERSION" \
	bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	refuse() { echo "check failed: $*" >&2; exit 1; }
	installed() { [[ $(dpkg-query -W -f="\${db:Status-Status}" "$1" 2>/dev/null) == installed ]]; }
	# A version line; sed reads to the end, so the tool never writes into a closed pipe.
	first() { "$@" 2>&1 | sed -n 1p; }
	systemctl daemon-reload
	groupadd --system qorpera-coding
	systemctl enable docker.service containerd.service qorpera-grow-root.service
	systemctl --global enable qorpera-docker.socket
	# No self-update: the image stays what was reviewed; agents update what they need inside their own machine.
	systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
	# snapd refreshes itself, nothing reaches a coding machine over SSH (the executor uses LXD exec), and the cloud
	# image'"'"'s own git would be a second one beside the pinned git. No autoremove: a metapackage that goes with them
	# would take everything it pulled in.
	for package in snapd openssh-server git git-man; do if installed "$package"; then apt-get purge -y "$package"; fi; done
	# The cloud image'"'"'s own account; every session has its own user (5g).
	if getent passwd ubuntu >/dev/null; then userdel -r ubuntu; fi
	rm -f /etc/sudoers.d/90-cloud-init-users
	# No cloud-init: it would wait for /dev/lxd at every boot. The network, the hostname and the root size are the image'"'"'s.
	rm -f /etc/netplan/50-cloud-init.yaml
	echo qorpera-coding >/etc/hostname
	printf "%s\n" "127.0.0.1 localhost" "127.0.1.1 qorpera-coding" "::1 localhost ip6-localhost ip6-loopback" \
		"ff02::1 ip6-allnodes" "ff02::2 ip6-allrouters" >/etc/hosts
	touch /etc/cloud/cloud-init.disabled
	netplan generate
	# Checks the reviewed image must pass.
	[[ $(command -v git) == /usr/local/bin/git && $(git --version) == "git version $GIT_VERSION" ]] || refuse "git is not $GIT_VERSION"
	if installed git; then refuse "a second git is installed"; fi
	[[ $(node --version) == "v$NODE_VERSION" ]] || refuse "node is not $NODE_VERSION"
	[[ $(chromium --version) == *" $CHROMIUM_VERSION"* ]] || refuse "chromium is not $CHROMIUM_VERSION"
	LIBRARIES=$(ldd /usr/lib/qorpera-chromium/chrome)
	[[ $LIBRARIES != *"not found"* ]] || refuse "chromium misses libraries: $LIBRARIES"
	DOM=$(timeout 60 chromium --headless --no-sandbox --disable-gpu --dump-dom "data:text/html,<p>qorpera-coding-image</p>" 2>/dev/null) ||
		refuse "chromium does not start"
	[[ $DOM == *qorpera-coding-image* ]] || refuse "chromium does not render"
	python3 --version && go version && rustc --version && cargo --version && first java -version
	first gcc --version && first cmake --version && tmux -V && first rg --version && fd --version && jq --version
	docker --version && docker compose version && docker buildx version
	rootlesskit --version && first slirp4netns --version && command -v pasta newuidmap newgidmap
	first sudo --version
	# Each session'"'"'s network namespace (5g) needs ip netns and nft; the folder program needs fuse3.
	ip -V && nft --version && first fusermount3 --version
	[[ $(systemctl is-enabled nftables.service 2>/dev/null || true) != enabled ]] || refuse "nftables.service loads rules at boot"
	# qorpera-docker-proxy.service takes its listening socket from systemd (ACCEPT-FD).
	SOCAT=$(socat -h)
	[[ $SOCAT == *"ACCEPT-FD:<fdnum>"* ]] || refuse "socat has no ACCEPT-FD"
	# qorpera-dockerd.service starts it, and rootlesskit runs it again by its path inside the namespaces.
	[[ -x /usr/share/docker.io/contrib/dockerd-rootless.sh ]] || refuse "dockerd-rootless.sh is not executable"
	for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service; do
		[[ $(readlink "/etc/systemd/system/$unit") == /dev/null ]] || refuse "$unit is not masked"
	done
	visudo -cf /etc/sudoers.d/qorpera-coding
	getent group qorpera-coding >/dev/null || refuse "no group qorpera-coding"
	# Sessions'"'"' users are plain /etc/passwd users (5g), with sub-ids only where 5g gives them.
	[[ ! -s /etc/subuid && ! -s /etc/subgid ]] || refuse "the image has sub-ids: $(cat /etc/subuid /etc/subgid)"
	systemd-analyze verify /etc/systemd/system/qorpera-grow-root.service /etc/systemd/system/qorpera-coding.slice
	for unit in docker.service containerd.service qorpera-grow-root.service; do
		[[ $(systemctl is-enabled "$unit") == enabled ]] || refuse "$unit is not enabled"
	done
	[[ $(systemctl --global is-enabled qorpera-docker.socket) == enabled ]] || refuse "qorpera-docker.socket is not enabled"
	# The executor reaches the machine only through LXD exec (test/prove-coding-image.sh shows it without cloud-init).
	echo "lxd-agent.service: $(systemctl is-enabled lxd-agent.service 2>&1 || true)"
	if installed openssh-server || installed snapd; then refuse "openssh-server or snapd is installed"; fi
	if getent passwd ubuntu >/dev/null; then refuse "the ubuntu account is there"; fi
	# Nothing of this build stays: logs, keys, caches, the machine id.
	apt-get clean
	rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.npm /root/.cargo
	cloud-init clean --logs --machine-id
	rm -f /etc/ssh/ssh_host_*
	journalctl --rotate --vacuum-time=1s >/dev/null 2>&1 || true
	fstrim -v / || true
	sync
'
lx stop "$BUILDER"
# The cloud image's metadata templates (/etc/hostname, /etc/hosts, cloud-init's seed) would be written into every
# machine made from this image when LXD creates it, naming each after its instance. The image keeps none.
{ lx config metadata show "$BUILDER" | awk '/^templates:/ {skip = 1; next} /^[^ ]/ {skip = 0} !skip'; echo "templates: {}"; } |
	lx config metadata edit "$BUILDER"
lx config template list "$BUILDER" --format csv | while read -r template; do
	lx config template delete "$BUILDER" "$template" </dev/null
done
TEMPLATES=$(lx config metadata show "$BUILDER" | awk '/^templates:/ {print; skip = 1; next} /^[^ ]/ {skip = 0} skip')
[[ $TEMPLATES == "templates: {}" && -z $(lx config template list "$BUILDER" --format csv) ]] ||
	{ echo "the builder keeps metadata templates: $TEMPLATES" >&2; exit 1; }
lx publish "$BUILDER" --alias "$ALIAS" --compression zstd \
	description="Qorpera coding machine $STAMP (Ubuntu 26.04, git $GIT_VERSION, Node $NODE_VERSION, Chromium $CHROMIUM_VERSION)"
FINGERPRINT=$(lx image info "$ALIAS" | awk '/^Fingerprint:/ {print $2}')
[[ $FINGERPRINT =~ ^[0-9a-f]{64}$ ]] || { echo "no image fingerprint" >&2; exit 1; }
echo "published $FINGERPRINT (delete it by hand if this build fails from here)" >&2
# Machines are made from the store their project uses. Export and import keep the fingerprint (copying between
# projects would need LXD to listen on the network), once per store.
declare -A HAS=(["$(store "$PROJECT")"]=1)
KEEP=
for project in "${CODING[@]}"; do
	target=$(store "$project")
	if [[ ${HAS[$target]:-} ]]; then [[ $target != "$(store "$PROJECT")" ]] || KEEP=1; continue; fi
	if [[ -z $EXPORT ]]; then
		EXPORT=$(mktemp -d)
		lx image export "$FINGERPRINT" "$EXPORT/image" >/dev/null
		# One file (a published image) or two (metadata and image.root).
		shopt -s nullglob
		PARTS=("$EXPORT"/*)
		if [[ -f $EXPORT/image.root ]]; then
			(( ${#PARTS[@]} == 2 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
			for part in "${PARTS[@]}"; do [[ $part == "$EXPORT/image.root" ]] || META=$part; done
			PARTS=("$META" "$EXPORT/image.root")
		else
			(( ${#PARTS[@]} == 1 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
		fi
	fi
	lxc --project "$project" image import "${PARTS[@]}" --alias "$ALIAS" >/dev/null
	HAS[$target]=1
done
[[ -z $EXPORT ]] || { rm -rf -- "$EXPORT"; EXPORT=; }
if [[ -z $KEEP ]]; then
	lx image delete "$FINGERPRINT" || echo "the build space still holds $FINGERPRINT: delete it by hand" >&2
fi
for project in "${CODING[@]}"; do
	[[ $(lxc --project "$project" image info "$FINGERPRINT" | awk '/^Fingerprint:/ {print $2}') == "$FINGERPRINT" ]] ||
		{ echo "the image is not in the store of project $project" >&2; exit 1; }
done
# The bootstrap digest pins exactly what was installed: this script, the pins and every file pushed.
SOURCES=()
for entry in "${FILES[@]}"; do read -r source _ _ <<<"$entry"; SOURCES+=("$HERE/$source"); done
BOOTSTRAP=$(cat "$0" "$PINS" "${SOURCES[@]}" | sha256sum | cut -d' ' -f1)
jq -n --arg imageFingerprint "$FINGERPRINT" --arg bootstrapSha256 "$BOOTSTRAP" --arg alias "$ALIAS" \
	--arg git "$GIT_VERSION" --arg node "$NODE_VERSION" --arg chromium "$CHROMIUM_VERSION" \
	--args '{schema: "qorpera.coding-image-build/v1", alias: $alias, imageFingerprint: $imageFingerprint,
	  bootstrapSha256: $bootstrapSha256, projects: $ARGS.positional, git: $git, node: $node, chromium: $chromium,
	  rootDiskBytes: 17179869184}' "${CODING[@]}" >&3
