# The run box proof's image (scripts/test-run-box-systemd.mjs): the systemd suites' image
# (systemd-test-image.Dockerfile, same base and packages) plus the run box's tools exactly as the runner image installs
# them (deploy/lxd-runner-guest/install-image-contract.sh). Build it on the test machine under its own tag and pass the
# ID it prints as QORPERA_OFFICE_SYSTEMD_TEST_IMAGE:
#   docker build -q -t qorpera-run-box-test:<commit> - < scripts/fixtures/run-box-toolbox-image.Dockerfile
FROM docker.io/library/ubuntu:26.04@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		systemd dbus nodejs util-linux mount e2fsprogs procps passwd openssl \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		fd-find file fonts-dejavu-core imagemagick jq libreoffice-nogui pandoc poppler-utils python3 python3-docx \
		python3-openpyxl python3-pandas python3-pypdf ripgrep sqlite3 unzip zip \
	&& ln -sfn /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*
