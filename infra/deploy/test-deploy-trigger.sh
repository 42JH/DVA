#!/usr/bin/env bash
set -euo pipefail
checker="$(dirname -- "${BASH_SOURCE[0]}")/should-deploy.sh"
export SOURCE_BRANCH=origin/develop-backend CI_DOCUMENTATION_ONLY=false
export monolith_event=push monolith_project=1462697 monolith_ref=refs/heads/develop-backend
bash "$checker" false
for assignment in 'monolith_event=merge_request' 'monolith_project=other' 'monolith_ref=refs/heads/develop-ai' 'SOURCE_BRANCH=origin/feature/test'; do
    if env "$assignment" bash "$checker" false; then echo "Unexpected auto deploy: $assignment" >&2; exit 1; fi
done
env -u monolith_event -u monolith_project -u monolith_ref bash "$checker" true
if env -u monolith_event -u monolith_project -u monolith_ref bash "$checker" false; then
    echo 'Manual CI-only build unexpectedly deployed.' >&2; exit 1
fi
if SOURCE_BRANCH=origin/feature/test bash "$checker" true; then
    echo 'A feature branch unexpectedly deployed.' >&2; exit 1
fi

if CI_DOCUMENTATION_ONLY=true bash "$checker" false; then
    echo 'Documentation-only push unexpectedly deployed.' >&2; exit 1
fi
CI_DOCUMENTATION_ONLY=true bash "$checker" true
if CI_DOCUMENTATION_ONLY=true SOURCE_BRANCH=origin/feature/test bash "$checker" true; then
    echo 'Documentation override bypassed protected-branch checks.' >&2; exit 1
fi
pipeline="$(dirname -- "${BASH_SOURCE[0]}")/../../Jenkinsfile"
regressions="$(sed 's/\r$//' "$pipeline" | sed -n '/if \[ "\$CHECK_DEPLOY_REGRESSIONS"/,/^[[:space:]]*fi$/p')"
[[ -n "$regressions" ]]
for enabled in false true; do
    actual="$(CHECK_DEPLOY_REGRESSIONS="$enabled" bash -c '
        bash() { printf "%s\n" "$*"; }
        eval "$1"
    ' _ "$regressions")"
    if [[ "$enabled" == false ]]; then
        [[ -z "$actual" ]]
    else
        [[ "$actual" == $'infra/deploy/test-deploy-trigger.sh\ninfra/deploy/test-deploy.sh\ninfra/deploy/test-linux-release.sh' ]]
    fi
done

echo 'PASS: protected-branch push auto deploy, manual selection, other events/projects/branches excluded.'
echo 'PASS: Jenkins runs every deployment regression only when selected.'
