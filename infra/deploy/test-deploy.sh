#!/usr/bin/env bash
# Exercise release state and failure handling with fake Docker/curl, without containers or a server.
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/site/shared" "$test_root/site/releases"
printf 'DB_USER=test\nDB_PASSWORD=test-only\nDB_NAME=test\n' > "$test_root/site/shared/.env"
export TEST_DOCKER_LOG="$test_root/docker.log"
export PATH="$test_root/bin:$PATH"
cat > "$test_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$TEST_DOCKER_LOG"
if [[ "$*" == *' up '* && -n "${TEST_FAIL_VERSION:-}" && "$*" == *"/releases/$TEST_FAIL_VERSION/"* ]]; then
    exit 1
fi
MOCK
cat > "$test_root/bin/curl" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$test_root/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
[[ "${1:-}" == -n ]] && shift
exec "$@"
MOCK
chmod +x "$test_root/bin/"*

make_release() {
    local version="$1" directory="$test_root/site/releases/$1"
    mkdir -p "$directory"
    cp "$(dirname -- "${BASH_SOURCE[0]}")/deploy.sh" "$directory/deploy.sh"
    printf 'services: {}\n' > "$directory/compose.prod.yaml"
    printf 'BACKEND_IMAGE=test:%s\n' "$version" > "$directory/release.env"
    printf 'test image archive %s\n' "$version" > "$directory/images.tar"
    (cd "$directory" && sha256sum images.tar > images.tar.sha256)
}

assert_current() {
    [[ "$(cat "$test_root/site/current-release")" == "$1" ]]
}

make_release first
bash "$test_root/site/releases/first/deploy.sh"
assert_current first
[[ ! -e "$test_root/site/previous-release" ]]

make_release second
bash "$test_root/site/releases/second/deploy.sh"
assert_current second
[[ "$(cat "$test_root/site/previous-release")" == first ]]

make_release broken
export TEST_FAIL_VERSION=broken
if bash "$test_root/site/releases/broken/deploy.sh"; then
    echo 'Expected failing deployment to report failure.' >&2
    exit 1
fi
assert_current second
[[ "$(cat "$test_root/site/previous-release")" == first ]]
# Both the failed rollout and automatic restore must have been attempted.
grep -F '/releases/broken/compose.prod.yaml up ' "$TEST_DOCKER_LOG" >/dev/null
[[ "$(grep -Fc '/releases/second/compose.prod.yaml up ' "$TEST_DOCKER_LOG")" -eq 2 ]]
unset TEST_FAIL_VERSION

bash "$test_root/site/releases/second/deploy.sh" --rollback
assert_current first
[[ "$(cat "$test_root/site/previous-release")" == second ]]

make_release corrupt
printf 'changed\n' >> "$test_root/site/releases/corrupt/images.tar"
if bash "$test_root/site/releases/corrupt/deploy.sh"; then
    echo 'Expected corrupt transfer to be rejected.' >&2
    exit 1
fi
assert_current first
if grep -F '/releases/corrupt/images.tar' "$TEST_DOCKER_LOG" >/dev/null; then
    echo 'Corrupt image must not be loaded.' >&2
    exit 1
fi

echo 'PASS: first deploy, update, failed update restore, manual rollback, corrupt transfer rejection.'
