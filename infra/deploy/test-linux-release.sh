#!/usr/bin/env bash
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mkdir -p "$test_root/repo/infra/deploy" "$test_root/repo/infra/nginx" "$test_root/repo/infra/database" "$test_root/repo/backend/migrations" "$test_root/bin"
cp "$repo_root/infra/deploy/"{package.sh,upload.sh,deploy.sh,known_hosts} "$test_root/repo/infra/deploy/"
cp "$repo_root/compose.prod.yaml" "$test_root/repo/"
cp "$repo_root/infra/nginx/default.prod.conf" "$test_root/repo/infra/nginx/"
cp "$repo_root/infra/database/"{migrate.sh,verify.sql} "$test_root/repo/infra/database/"
cp "$repo_root/backend/migrations/"[0-9][0-9][0-9]-*.sql "$test_root/repo/backend/migrations/"
export TEST_COMMAND_LOG="$test_root/commands.log"
export PATH="$test_root/bin:$PATH"
export LIGHTSAIL_SSH_HOST=deploy.example.test
cat > "$test_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf 'docker %s\n' "$*" >> "$TEST_COMMAND_LOG"
if [[ "${TEST_BUILD_FAIL:-}" == 1 && "$1" == build ]]; then exit 1; fi
if [[ "$1 ${2:-}" == 'image inspect' ]]; then
 [[ "${TEST_IMAGE_MISSING:-}" != 1 ]] || exit 1
 printf '%s\n' "${TEST_IMAGE_PLATFORM:-linux/amd64}"
fi
if [[ "$1 ${2:-}" == 'image save' ]]; then
 while [[ "$1" != --output ]]; do shift; done
 printf 'test image archive\n' > "$2"
fi
MOCK
cat > "$test_root/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
set -eu
[[ "$*" == *StrictHostKeyChecking=yes* ]]
[[ "$*" == *UserKnownHostsFile=* ]]
[[ "$*" == *HostKeyAlias=dva-monolith-deploy* && "$*" == *ubuntu@deploy.example.test* ]]
[[ "$1" == -i && "$(stat -c '%a' "$2")" == 600 ]]
printf 'ssh %s\n' "${!#}" >> "$TEST_COMMAND_LOG"
cat >/dev/null
MOCK
cat > "$test_root/bin/scp" <<'MOCK'
#!/usr/bin/env bash
set -eu
[[ "$*" == *StrictHostKeyChecking=yes* ]]
[[ "$*" == *HostKeyAlias=dva-monolith-deploy* && "$*" == *ubuntu@deploy.example.test* ]]
printf 'scp invoked\n' >> "$TEST_COMMAND_LOG"
MOCK
chmod +x "$test_root/bin/"*
printf 'test-only identity\n' > "$test_root/identity"
bash "$test_root/repo/infra/deploy/package.sh" test-one
release="$test_root/repo/.deploy/test-one"
(cd "$release" && sha256sum --check --status images.tar.sha256)
(cd "$release" && sha256sum --check --status release-files.sha256)
cmp "$repo_root/backend/migrations/001-pbx-call-ended.sql" "$release/backend/migrations/001-pbx-call-ended.sql"
test -f "$release/backend/migrations/004-organization-creation-requests.sql"
cmp "$repo_root/backend/migrations/009-membership-write-requests.sql" "$release/backend/migrations/009-membership-write-requests.sql"
test -f "$release/backend/migrations/010-remove-membership-write-requests.sql"
grep -F 'backend/migrations/010-remove-membership-write-requests.sql' "$release/release-files.sha256" >/dev/null
test "$(grep -c '_IMAGE=' "$release/release.env")" = 3
if grep -E 'dva-ai|AI_IMAGE' "$TEST_COMMAND_LOG" "$release/release.env"; then
 echo 'Backend release must not package AI' >&2; exit 1
fi
grep -F 'docker build --platform linux/amd64 -t dva-backend:test-one ./backend' "$TEST_COMMAND_LOG"
grep -F 'docker image save --output' "$TEST_COMMAND_LOG" | grep -F 'dva-backend:test-one dva-postgres:test-one dva-nginx:test-one'
test ! -e "$release/.env"
if bash "$test_root/repo/infra/deploy/package.sh" test-one; then echo 'Duplicate release accepted' >&2; exit 1; fi
if bash "$test_root/repo/infra/deploy/package.sh" '../escape'; then echo 'Invalid version accepted' >&2; exit 1; fi
if TEST_BUILD_FAIL=1 bash "$test_root/repo/infra/deploy/package.sh" test-fail; then echo 'Build failure accepted' >&2; exit 1; fi
test ! -e "$test_root/repo/.deploy/test-fail"
TEST_BUILD_FAIL=1 bash "$test_root/repo/infra/deploy/package.sh" test-reuse dva-backend:test-reuse
grep -F 'docker image inspect dva-backend:test-reuse' "$TEST_COMMAND_LOG"
if grep -F 'docker build --platform linux/amd64 -t dva-backend:test-reuse ' "$TEST_COMMAND_LOG"; then
 echo 'Verified backend image was rebuilt' >&2; exit 1
fi
(cd "$test_root/repo/.deploy/test-reuse" && sha256sum --check --status release-files.sha256 && sha256sum --check --status images.tar.sha256)
before_reject="$(wc -l < "$TEST_COMMAND_LOG")"
if bash "$test_root/repo/infra/deploy/package.sh" test-wrong dva-backend:another; then echo 'Foreign verified image accepted' >&2; exit 1; fi
test "$(wc -l < "$TEST_COMMAND_LOG")" = "$before_reject"
if TEST_IMAGE_MISSING=1 TEST_BUILD_FAIL=1 bash "$test_root/repo/infra/deploy/package.sh" test-missing dva-backend:test-missing; then echo 'Missing verified image accepted' >&2; exit 1; fi
if TEST_IMAGE_PLATFORM=linux/arm64 TEST_BUILD_FAIL=1 bash "$test_root/repo/infra/deploy/package.sh" test-arm dva-backend:test-arm; then echo 'Wrong verified platform accepted' >&2; exit 1; fi
for failed in test-wrong test-missing test-arm; do
 test ! -e "$test_root/repo/.deploy/$failed"
 if grep -F "docker build --platform linux/amd64 -t dva-backend:$failed " "$TEST_COMMAND_LOG"; then echo 'Invalid verified image fell back to a build' >&2; exit 1; fi
done
before_verify="$(wc -l < "$TEST_COMMAND_LOG")"
if env -u LIGHTSAIL_SSH_HOST -u BUILD_URL bash "$test_root/repo/infra/deploy/upload.sh" test-one "$test_root/identity"; then
 echo 'Missing deployment address accepted' >&2; exit 1
fi
test "$(wc -l < "$TEST_COMMAND_LOG")" = "$before_verify"
env -u LIGHTSAIL_SSH_HOST BUILD_URL=https://deploy.example.test/jenkins/job/dva-ci-linux-validation/42/ \
 bash "$test_root/repo/infra/deploy/upload.sh" test-one "$test_root/identity" ubuntu --verify-only
test "$(($(wc -l < "$TEST_COMMAND_LOG") - before_verify))" = 1
test "$(grep -c 'scp invoked' "$TEST_COMMAND_LOG" || true)" = 0
bash "$test_root/repo/infra/deploy/upload.sh" test-one "$test_root/identity"
grep -q 'scp invoked' "$TEST_COMMAND_LOG"
grep -q '/releases/test-one/deploy.sh' "$TEST_COMMAND_LOG"
before="$(wc -l < "$TEST_COMMAND_LOG")"
printf '\n-- tampered SQL\n' >> "$release/backend/migrations/004-organization-creation-requests.sql"
if bash "$test_root/repo/infra/deploy/upload.sh" test-one "$test_root/identity"; then echo 'Tampered SQL accepted' >&2; exit 1; fi
test "$(wc -l < "$TEST_COMMAND_LOG")" = "$before"
cp "$repo_root/backend/migrations/004-organization-creation-requests.sql" "$release/backend/migrations/"
before="$(wc -l < "$TEST_COMMAND_LOG")"
printf 'tampered\n' >> "$release/images.tar"
if bash "$test_root/repo/infra/deploy/upload.sh" test-one "$test_root/identity"; then echo 'Tampered release accepted' >&2; exit 1; fi
test "$(wc -l < "$TEST_COMMAND_LOG")" = "$before"
echo 'PASS: Linux build/verified-image reuse with fail-closed version/platform checks, exact SQL bytes, pinned SSH and image/SQL transfer integrity.'
