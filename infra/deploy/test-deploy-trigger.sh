#!/usr/bin/env bash
set -euo pipefail
checker="$(dirname -- "${BASH_SOURCE[0]}")/should-deploy.sh"
export SOURCE_BRANCH=origin/develop-backend
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
echo 'PASS: protected-branch push auto deploy, manual selection, other events/projects/branches excluded.'
