"""Select CI and delivery from Git history and actual successful deployments."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'parity'))
import ci_verification

SHA = re.compile(r"[0-9a-f]{40}")
NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
APP_COMMON = ["msa/deploy/package-app.sh", "msa/deploy/upload-app.sh",
              "msa/deploy/remote-app.sh", "msa/deploy/app-release.py", "msa/deploy/read-app-state.sh",
              "msa/deploy/ssh-common.sh", "msa/deploy/known_hosts",
              ":(glob)msa/shared/events/*.cjs", ":(glob)msa/shared/events/*.d.cts", "msa/shared/events/package.json",
              "msa/.dockerignore", "msa/services/package.json", "msa/services/package-lock.json"]
CI_COMMON = ["msa/.dockerignore", *ci_verification.POLICY_PATHS,
             ":(glob)msa/shared/events/*.cjs", ":(glob)msa/shared/events/*.d.cts",
             "msa/shared/events/package.json", "msa/services/package.json", "msa/services/package-lock.json"]
PARITY = Path(__file__).resolve().parents[1] / 'parity'
SUITE_DEPENDENCIES = {
    'operations': {'operations'}, 'customer': {'operations', 'customer'},
    'consultation': {'operations', 'customer', 'consultation', 'order'},
    'order': {'operations', 'customer', 'consultation', 'delivery', 'order'},
}
DB_PATHS = ci_verification.DB_PATHS


def changed(base, paths):
    if not SHA.fullmatch(base or ""):
        return True
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", base, "HEAD"], capture_output=True)
    if ancestor.returncode != 0:
        return True
    result = subprocess.run(["git", "diff", "--quiet", base, "HEAD", "--", *paths,
                             ":(glob,exclude)msa/services/**/README.md",
                             ":(glob,exclude)msa/shared/events/**/*.md"])
    if result.returncode not in (0, 1):
        raise RuntimeError("Cannot compare Git changes")
    return result.returncode == 1


def healthy(deployment):
    spec, status = deployment.get("spec", {}), deployment.get("status", {})
    replicas = spec.get("replicas", 1)
    return (replicas > 0 and status.get("observedGeneration", 0) >= deployment["metadata"].get("generation", 1)
            and status.get("updatedReplicas", 0) == replicas
            and status.get("replicas", 0) == replicas and status.get("availableReplicas", 0) == replicas
            and status.get("readyReplicas", 0) == replicas)


def deployed_commit(deployment, service):
    if not deployment:
        return ""
    value = deployment["metadata"].get("annotations", {}).get("dva.ssafy.io/deployed-commit")
    if value is not None:
        if not SHA.fullmatch(value):
            raise ValueError("Invalid deployed commit")
        return value
    # Bootstrap the already verified legacy deployment; never infer from an unfinished rollout.
    if healthy(deployment):
        containers = deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
        if len(containers) == 1:
            match = re.fullmatch(r"(?:docker.io/library/)?dva-" + re.escape(service) + r":([0-9a-f]{40})-[0-9]+", containers[0]["image"])
            if match:
                return match[1]
    return ""


def read_state(text):
    decoder = json.JSONDecoder()
    deployments, offset = decoder.raw_decode(text.lstrip())
    namespace, end = decoder.raw_decode(text.lstrip()[offset:].lstrip())
    remaining = text.lstrip()[offset:].lstrip()[end:]
    if remaining.strip() or namespace["metadata"]["name"] != "dva":
        raise ValueError("Invalid cluster state")
    return {d["metadata"]["name"]: d for d in deployments["items"]}, namespace["metadata"].get("annotations", {})


def plan(base, delivery, deployments, annotations):
    selected = []
    for directory in sorted(Path("msa/services").iterdir()):
        if not directory.is_dir():
            continue
        service = directory.name
        if not NAME.fullmatch(service):
            raise ValueError("Invalid service directory")
        old = deployments.get(service)
        app_base = deployed_commit(old, service) if delivery else base
        needs_build = changed(app_base, [str(directory).replace("\\", "/") + "/", *APP_COMMON])
        if delivery and (not old or not healthy(old)):
            needs_build = True
        if not needs_build:
            print(f"SKIP: {service}")
            continue
        if not (directory / "Dockerfile").is_file() or not (directory / "k8s.yaml").is_file():
            raise ValueError(f"Missing Dockerfile/k8s.yaml: {service}")
        selected.append(service)
        print(f"BUILD: {service} (baseline={app_base or 'unknown'})")
    # Deploy scope and shipment owners before order, which invokes their private handlers.
    first = ('operations', 'customer', 'consultation', 'delivery', 'order')
    return [s for s in first if s in selected] + [s for s in selected if s not in first]


def databases(base, delivery, annotations):
    selected = []
    for service in ('customer', 'operations', 'order', 'consultation', 'delivery'):
        baseline = annotations.get(f'dva.ssafy.io/db-{service}-commit', '') if delivery else base
        if changed(baseline, [f'msa/liquibase/changelog/{service}/']):
            selected.append(service)
    return selected


def verification(base, applications):
    # CI compares the last successful verification; delivery still uses actual rollout history.
    return [directory.name for directory in sorted(Path('msa/services').iterdir())
            if directory.is_dir() and (directory.name in applications or changed(base, [
                directory.as_posix() + '/', 'msa/liquibase/changelog/' + directory.name + '/',
                'msa/liquibase/changelog/shared/', *CI_COMMON]))]


def parity_suites(base, verified):
    dependencies = {}
    for suite in SUITE_DEPENDENCIES:
        driver = PARITY / ('verify-' + suite + '.py')
        source = driver.read_text()
        dependencies[suite] = ['msa/parity/' + path.name for path in PARITY.iterdir()
                               if path.is_file() and (path == driver or path.name in source)]
    known = {path for paths in dependencies.values() for path in paths}
    # The manual 052 diagnostic has its own cheap checker; it does not drive these suites.
    known.update('msa/parity/' + name for name in (
        'final-contract.test.cjs', 'final-parity.cjs', 'final-peer.cjs', 'inventory.cjs',
        'inventory.test.cjs', 'fixture-reset.test.cjs', 'initial-baseline.json', 'verify-final.py'))
    # Unknown/new helpers require the full matrix; a named suite test reruns its consumers.
    unknown = changed(base, ['msa/parity/', ':(glob,exclude)msa/parity/**/*.md',
                            *[':(exclude)' + path for path in sorted(known)]])
    return [suite for suite, services in SUITE_DEPENDENCIES.items()
            if unknown or services.intersection(verified) or changed(base, dependencies[suite])]


def main():
    out = Path("msa-release")
    out.mkdir(exist_ok=True)
    delivery = os.environ.get("DELIVER_APPS") == "true"
    deployments, annotations = read_state((out / "cluster-state.json").read_text()) if delivery else ({}, {})
    base = os.environ.get("MSA_BASE_COMMIT", "")
    services = plan(base, delivery, deployments, annotations)
    db_services = databases(base, delivery, annotations)
    cutover = annotations.get('dva.ssafy.io/parcel-drafts-schema') != '055' or any(
        not deployments.get(service) or not healthy(deployments[service]) for service in ('order', 'consultation'))
    if cutover and {'order', 'consultation'}.intersection(db_services):
        # Both source DBs and their compatible apps belong to one 055 cutover.
        for service in ('consultation', 'order'):
            if service not in db_services:
                db_services.append(service)
            if service not in services:
                services.append(service)
    # A pending rollout is not evidence that an already-passed regression must run again.
    suites = []
    origins = {scope: ci_verification.previous(scope, base, Path.cwd()) for scope in ci_verification.SCOPES}
    for suite in SUITE_DEPENDENCIES:
        baseline = origins[suite]['commit']
        if suite in parity_suites(baseline, verification(baseline, [])):
            suites.append(suite)
    db = ci_verification.database_changed(origins['database']['commit'], Path.cwd())
    events = changed(origins['events']['commit'], ci_verification.EVENT_PATHS)
    deployment_ci = changed(origins['deployment']['commit'], ci_verification.DEPLOY_PATHS)
    (out / "services.txt").write_text("".join(s + "\n" for s in services))
    (out / "databases.txt").write_text("".join(s + "\n" for s in db_services))
    (out / "database-ci.txt").write_text(str(db).lower())
    (out / 'parity-suites.txt').write_text(''.join(s + '\n' for s in suites))
    (out / 'event-ci.txt').write_text(str(events).lower())
    (out / 'deployment-ci.txt').write_text(str(deployment_ci).lower())
    (out / 'verification-plan.json').write_text(json.dumps({
        'origins': origins, 'database': db, 'events': events, 'deployment': deployment_ci,
        'paritySuites': suites}, indent=2) + '\n')
    print(f"Database CI: {db}; apps: {services}; databases: {db_services}")
    print(f'Parity suites: {suites}')


if __name__ == "__main__":
    main()
