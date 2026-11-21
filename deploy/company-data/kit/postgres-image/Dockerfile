FROM docker.io/library/postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3

RUN apt-get update \
	&& apt-get install -y --no-install-recommends postgresql-17-pgvector \
	&& rm -rf /var/lib/apt/lists/*
