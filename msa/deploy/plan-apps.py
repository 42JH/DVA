"""Select CI and delivery from Git history and actual successful deployments."""
import json
import os
from pathlib import Path
import re
import subprocess

SHA = re.compile(r"[0-9a-f]{40}")
NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
APP_COMMON = ["msa/Jenkinsfile", "msa/deploy/package-app.sh", "msa/deploy/upload-app.sh",
              "msa/deploy/remote-app.sh", "msa/deploy/app-release.py", "msa/deploy/read-app-state.sh",
              "msa/deploy/plan-apps.py", "msa/deploy/ssh-common.sh", "msa/deploy/known_hosts",
              "msa/shared/", "msa/parity/", "msa/.dockerignore", "msa/services/package.json", "msa/services/package-lock.json"]
DB_PATHS = ["msa/liquibase/", "msa/Jenkinsfile", "msa/deploy/package.sh", "msa/deploy/upload.sh",
            "msa/deploy/remote.sh", "msa/deploy/run-remote.sh", "msa/deploy/ssh-common.sh",
            "msa/deploy/known_hosts", "msa/deploy/has-msa-changes.sh", "msa/deploy/deliver-databases.sh", "msa/deploy/plan-apps.py",
            "msa/deploy/tests/test_changes.py", "msa/deploy/tests/test_deploy.py"]


def changed(base, paths):
    if not SHA.fullmatch(base or ""):
        return True
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", base, "HEAD"], capture_output=True)
    if ancestor.returncode != 0:
        return True
    result = subprocess.run(["git", "diff", "--quiet", base, "HEAD", "--", *paths])
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


def main():
    out = Path("msa-release")
    out.mkdir(exist_ok=True)
    delivery = os.environ.get("DELIVER_APPS") == "true"
    deployments, annotations = read_state((out / "cluster-state.json").read_text()) if delivery else ({}, {})
    base = os.environ.get("MSA_BASE_COMMIT", "")
    services = plan(base, delivery, deployments, annotations)
    db_services = databases(base, delivery, annotations)
    db = bool(db_services) or changed(base, DB_PATHS)
    (out / "services.txt").write_text("".join(s + "\n" for s in services))
    (out / "databases.txt").write_text("".join(s + "\n" for s in db_services))
    (out / "database-ci.txt").write_text(str(db).lower())
    print(f"Database CI: {db}; apps: {services}; databases: {db_services}")


if __name__ == "__main__":
    main()
