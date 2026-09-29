# Disposable image for the scripts/*-systemd.mjs suites (QORPERA_OFFICE_SYSTEMD_TEST_IMAGE).
# Build with no context and pass the printed image ID. On the test machine reuse the tagged image
# instead; a rebuild deletes the one other sessions use (deploy/test-machine/README.md):
#   docker build -q -t qorpera-systemd-test:local - < scripts/fixtures/systemd-test-image.Dockerfile
# Ubuntu 26.04 as on the nodes and office guests. Its nodejs package was 22.22.1 when written, the
# version production pins (deploy/first-node/bootstrap-azure-step2-pilot-lxd.sh). Package versions
# follow the archive at build time and every build gets a new image ID; the suites run the exact ID
# they are given.
FROM docker.io/library/ubuntu:26.04@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78
# systemd as PID 1, util-linux/mount/e2fsprogs for the loop filesystem and mount probes, openssl for
# the boot fixtures' loopback certificates, and the executables the office image installer measures
# (OFFICE_IMAGE_EXECUTABLES).
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		systemd dbus nodejs util-linux mount e2fsprogs procps passwd openssl \
		bubblewrap tini apparmor tigervnc-standalone-server xfce4-session xfwm4 xfconf dbus-bin \
		x11-xserver-utils x11-utils xdotool scrot \
	&& rm -rf /var/lib/apt/lists/*
# The installer only measures the private browser tree; no systemd suite starts the browser.
RUN install -d -m 0755 /usr/lib/qorpera-chromium \
	&& printf '#!/bin/sh\necho "synthetic test browser" >&2\nexit 1\n' >/usr/lib/qorpera-chromium/chrome \
	&& chmod 0755 /usr/lib/qorpera-chromium/chrome
