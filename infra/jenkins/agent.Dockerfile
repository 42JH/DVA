FROM node:24-bookworm-slim AS node
FROM docker:29-cli AS docker
FROM jenkins/inbound-agent:jdk21
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
USER jenkins
