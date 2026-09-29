/** Shared by the disposable systemd containers of scripts/*-systemd.mjs. Each container also has
 * --cap-drop ALL with its own capability set, --network none, --cgroupns private and resource limits.
 *
 * Docker's default AppArmor profile (docker-default, on Ubuntu hosts) denies every mount, so the cgroup
 * remount below fails and systemd never starts. Allowing only that remount is not enough: systemd's
 * generator step is then refused a propagation mount on / (tested on the node 2 test machine), and
 * unit sandboxing (ProtectSystem=, PrivateTmp=) and the fixtures' loop and tmpfs mounts need more. A
 * profile allowing bind and remount at any path would let the root fixture re-bind /proc or /sys and
 * step around docker-default's path rules. LXC-style profiles that refuse /proc, /sys and /dev sources
 * sit in between, but like any profile they must be loaded as root on every host.
 *
 * What unconfined gives up: with CAP_SYS_ADMIN and no profile, root in the container can remount
 * /proc/sys or /proc/sysrq-trigger writable and change the host kernel. Run these suites on the test
 * machine or a developer's Docker, never on a node that hosts companies. Whoever starts them already
 * controls the Docker daemon, which is root on that host; the profile only guarded against this
 * checkout's own test code. Docker Desktop has no AppArmor and ignores the option. */
export const SYSTEMD_CONTAINER_SECURITY = ["--security-opt", "no-new-privileges", "--security-opt", "apparmor=unconfined"];

/** Container command: optional root setup, then systemd as PID 1. The container cannot load kernel
 * AppArmor profiles (no securityfs, no CAP_MAC_ADMIN), so on an AppArmor host everything inside sees
 * the module as disabled, as on Docker Desktop: the office image installer then only compiles its
 * profile, systemd skips AppArmor units, and the runtime's browser gate would take its non-AppArmor
 * branch (no suite starts the real browser). */
export function systemdContainerBoot(setup = "") {
	return `${setup ? `${setup} && ` : ""}if [ -e /sys/module/apparmor/parameters/enabled ]; then echo N >/run/fixture-apparmor-enabled && mount --bind -o ro /run/fixture-apparmor-enabled /sys/module/apparmor/parameters/enabled; fi && mount -o remount,bind,rw /sys/fs/cgroup && exec /lib/systemd/systemd --log-target=console`;
}
