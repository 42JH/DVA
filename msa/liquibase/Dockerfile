FROM liquibase/liquibase:5.0.4@sha256:060f96efff4811ccf03957ff3160f21ea04139b89940640f8ad54a065cdc6906
# Short-lived CLI commands on the one-CPU builder benefit from C1 startup compilation.
ENV JAVA_OPTS="-XX:TieredStopAtLevel=1"
RUN wget -q https://repo.maven.apache.org/maven2/org/postgresql/postgresql/42.7.14/postgresql-42.7.14.jar -O /liquibase/lib/postgresql-42.7.14.jar \
 && echo "73914527305a40cce504b0d3d90b23caf565136912d607ae8ae7c5895512332c  /liquibase/lib/postgresql-42.7.14.jar" | sha256sum -c -
COPY --chown=liquibase:liquibase changelog/ /liquibase/changelog/
COPY --chown=liquibase:liquibase ci-command.sh /liquibase/ci-command.sh
