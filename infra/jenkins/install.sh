#!/usr/bin/env bash
# Restore a stopped controller backup into a NEW, isolated server directory.
set -euo pipefail
umask 077
settings_archive="${1:?Settings archive required}"
keys_archive="${2:?Controller key archive required}"
root="${3:-/home/ubuntu/dva-jenkins}"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$root" == /home/ubuntu/dva-jenkins ]] || { echo 'Unexpected installation root' >&2; exit 1; }
[[ -f "$settings_archive" && -f "$keys_archive" ]] || exit 1
[[ ! -e "$root/home" ]] || { echo 'Existing Jenkins home; refusing to overwrite' >&2; exit 1; }
install -d -m 700 "$root/home" "$root/bootstrap-output"
chmod 600 "$settings_archive" "$keys_archive"
tar -tzf "$settings_archive" > /dev/null
tar -tzf "$keys_archive" > /dev/null
tar -xzf "$settings_archive" -C "$root/home"
tar -xzf "$keys_archive" -C "$root/home"
install -d -m 700 "$root/home/init.groovy.d"
install -m 600 "$source_dir/bootstrap.groovy" "$root/home/init.groovy.d/lightsail-migration.groovy"
cp "$source_dir/compose.yaml" "$source_dir/agent.Dockerfile" "$source_dir/.dockerignore" "$source_dir/admin.py" "$root/"
python3 - "$root/home" <<'PY'
from pathlib import Path
import re
import sys
home=Path(sys.argv[1])
config=home/'config.xml'
text=config.read_text()
assert '<useSecurity>true</useSecurity>' in text
text=re.sub(r'<numExecutors>\d+</numExecutors>','<numExecutors>0</numExecutors>',text)
text=re.sub(r'<slaveAgentPort>-?\d+</slaveAgentPort>','<slaveAgentPort>-1</slaveAgentPort>',text)
config.write_text(text)
for job in (home/'jobs').glob('*/config.xml'):
    text=job.read_text()
    if '<flow-definition' in text:
        text=text.replace('<disabled>false</disabled>','<disabled>true</disabled>')
        job.write_text(text)
PY
chown -R 1000:1000 "$root/home" "$root/bootstrap-output"
cd "$root"
docker compose config --quiet
# Agent is started separately after bootstrap writes its secret file.
docker compose up -d controller docker
echo 'Controller restore started. Verify bootstrap completion before starting the agent or exposing HTTPS.'
