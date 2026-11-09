"""Apply one app release; restore its previous resources if rollout/probes fail."""
import copy
import base64
import json
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time
import urllib.request

KUBE = ["sudo", "-n", "k3s", "kubectl"]
KINDS = {"Deployment": "deployment", "Service": "service", "Ingress": "ingress"}


def run(args, data=None, timeout=360):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def kube(*args, data=None):
    return run([*KUBE, *args], data)


def items(document):
    return document.get("items", []) if document.get("kind") == "List" else [document]


def parse_resources(text):
    resources = []
    decoder = json.JSONDecoder()
    while text.strip():
        value, end = decoder.raw_decode(text.lstrip())
        resources.extend(items(value))
        text = text.lstrip()[end:]
    return resources


def clean(resource):
    value = copy.deepcopy(resource)
    value.pop("status", None)
    for key in ("uid", "resourceVersion", "generation", "creationTimestamp", "managedFields", "selfLink"):
        value["metadata"].pop(key, None)
    value["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
    return value


def ready(deployment):
    status = deployment.get("status", {})
    replicas = deployment.get("spec", {}).get("replicas", 1)
    return (replicas > 0 and status.get("observedGeneration", 0) >= deployment["metadata"].get("generation", 1)
            and status.get("updatedReplicas", 0) == replicas and status.get("replicas", 0) == replicas
            and status.get("availableReplicas", 0) == replicas and status.get("readyReplicas", 0) == replicas)


def parcel_contract(deployment):
    return deployment.get('spec', {}).get('template', {}).get('metadata', {}).get('annotations', {}).get('dva.ssafy.io/parcel-drafts-contract') == '055'


def stopped(deployment):
    return deployment.get('spec', {}).get('replicas', 1) == 0 and deployment.get('status', {}).get('replicas', 0) == 0


def parcel_cutover(service, desired, previous):
    if service not in ('order', 'consultation'):
        return False
    namespace = json.loads(kube('get', 'namespace', 'dva', '-o', 'json'))
    upgraded = namespace.get('metadata', {}).get('annotations', {}).get('dva.ssafy.io/parcel-drafts-schema') == '055' or bool(previous and parcel_contract(previous))
    if upgraded and not parcel_contract(desired):
        raise RuntimeError('055 schema refuses a pre-parcel-draft app; use a compatible release')
    return upgraded and parcel_contract(desired) and bool(previous and stopped(previous))


def verify_digest(table, image, expected):
    rows = [line.split() for line in table.splitlines() if line.split() and line.split()[0] == image]
    if len(rows) != 1 or len(rows[0]) < 3 or rows[0][2] != expected:
        raise RuntimeError("Imported image digest does not match the CI image")


def validate_resources(resources, service, image):
    keys = []
    for resource in resources:
        meta = resource["metadata"]
        kind = resource["kind"]
        if kind not in KINDS or meta["name"] != service or meta.get("namespace") != "dva":
            raise RuntimeError("Package may manage only this service's Deployment/Service/Ingress in dva")
        keys.append(kind)
    if len(keys) != len(set(keys)) or not {"Deployment", "Service"}.issubset(keys):
        raise RuntimeError("Expected one Deployment and one Service")
    dep = next(r for r in resources if r["kind"] == "Deployment")
    containers = dep["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1 or containers[0]["name"] != service or containers[0]["image"] != image:
        raise RuntimeError("Unexpected deployment image/container")
    strategy = dep["spec"].get("strategy", {})
    rolling = strategy.get("rollingUpdate", {})
    if strategy.get("type") != "RollingUpdate" or rolling.get("maxUnavailable") != 0 or rolling.get("maxSurge") != 1:
        raise RuntimeError("Expected RollingUpdate with maxUnavailable=0, maxSurge=1")
    return dep


def probe(service, resources):
    dep = next(r for r in resources if r["kind"] == "Deployment")
    container = dep["spec"]["template"]["spec"]["containers"][0]
    path = container["readinessProbe"]["httpGet"]["path"]
    svc = next(r for r in resources if r["kind"] == "Service")
    port = next(p["port"] for p in svc["spec"]["ports"] if p.get("name") == "http")
    health = f"http://{service}:{port}{path}"
    docs = f"http://{service}:{port}/{service}/docs-json"
    js = """(async()=>{for(const url of process.argv.slice(1)){
const r=await fetch(url,{signal:AbortSignal.timeout(5000)});
if(!r.ok)throw Error(url+' HTTP '+r.status);
const body=await r.json();
if(url===process.argv[1]?body.status!=='ok':!body.openapi)throw Error('Invalid response '+url);
console.log('OK '+url)}})().catch(e=>{console.error(e);process.exit(1)})"""
    kube("-n", "dva", "exec", f"deployment/{service}", "--", "node", "-e", js, health, docs)
    for resource in resources:
        if resource["kind"] != "Ingress":
            continue
        for rule in resource["spec"]["rules"]:
            host = rule["host"]
            if not re.fullmatch(r"[a-zA-Z0-9.-]+", host):
                raise RuntimeError("Invalid ingress host")
            for suffix in (path, f"/{service}/docs", f"/{service}/docs-json"):
                url = f"https://{host}{suffix}"
                for attempt in range(6):
                    try:
                        with urllib.request.urlopen(url, timeout=10) as response:
                            body = response.read()
                            if response.status != 200:
                                raise RuntimeError(f"HTTP {response.status}: {url}")
                            if suffix == path and json.loads(body).get("status") != "ok":
                                raise RuntimeError("Invalid public health response")
                            if suffix.endswith("/docs-json") and not json.loads(body).get("openapi"):
                                raise RuntimeError("Invalid public OpenAPI response")
                        break
                    except Exception:
                        if attempt == 5:
                            raise
                        time.sleep(2)


def rollout(service):
    kube("-n", "dva", "rollout", "status", f"deployment/{service}", "--timeout=240s")


def ensure_service_auth_secret(service):
    if service not in ('customer', 'consultation', 'security-logs'):
        raise ValueError('Unsupported service authentication secret')
    name = 'msa-security-logs' if service == 'security-logs' else f'msa-{service}-auth'
    key = 'hmac-key' if service == 'security-logs' else f'{service}-token'
    pattern = r'[a-fA-F0-9]{64}' if service == 'security-logs' else r'[\x21-\x7e]{32,256}'
    try:
        existing = kube('-n', 'dva', 'get', 'secret', name, '--ignore-not-found', '-o', 'json')
        if existing.strip():
            value = json.loads(existing)
            token = base64.b64decode(value['data'][key], validate=True).decode('ascii')
            if value['metadata']['name'] != name or value['metadata']['namespace'] != 'dva' or not re.fullmatch(pattern, token):
                raise ValueError('Invalid existing service authentication secret')
            return
        kube('create', '-f', '-', data=json.dumps({
            'apiVersion': 'v1', 'kind': 'Secret', 'type': 'Opaque',
            'metadata': {'name': name, 'namespace': 'dva'},
            'stringData': {key: secrets.token_hex(32) if service == 'security-logs' else secrets.token_urlsafe(48)},
        }))
    except Exception:
        raise RuntimeError(f'{service.capitalize()} authentication secret is unavailable; existing values were not replaced') from None


def apply_release(service, release, image):
    desired = parse_resources(kube("apply", "--dry-run=server", "-f", "k8s.yaml", "-o", "json"))
    desired_dep = validate_resources(desired, service, image)
    container = next(r for r in desired if r['kind'] == 'Deployment')['spec']['template']['spec']['containers'][0]
    for peer in ('customer', 'consultation', 'security-logs'):
        secret_name = 'msa-security-logs' if peer == 'security-logs' else f'msa-{peer}-auth'
        if any(e.get('valueFrom', {}).get('secretKeyRef', {}).get('name') == secret_name for e in container.get('env', [])):
            ensure_service_auth_secret(peer)
    previous = []
    for resource in desired:
        value = kube("-n", "dva", "get", KINDS[resource["kind"]], service, "--ignore-not-found", "-o", "json")
        if value.strip():
            previous.append(json.loads(value))
    old_dep = next((r for r in previous if r["kind"] == "Deployment"), None)
    paused_cutover = parcel_cutover(service, desired_dep, old_dep)
    if old_dep and not ready(old_dep) and not paused_cutover:
        raise RuntimeError("Existing deployment is not stable; inspect it before starting another rollout")
    snapshot = {"apiVersion": "v1", "kind": "List", "items": [clean(r) for r in previous]}
    Path("previous-resources.json").write_text(json.dumps(snapshot, indent=2))
    started = False
    try:
        started = True
        kube("apply", "-f", "k8s.yaml")
        rollout(service)
        actual = json.loads(kube("-n", "dva", "get", "deployment", service, "-o", "json"))
        if actual["spec"]["template"]["spec"]["containers"][0]["image"] != image:
            raise RuntimeError("Deployment image changed unexpectedly")
        probe(service, desired)
        kube("-n", "dva", "annotate", "deployment", service,
             f"dva.ssafy.io/deployed-commit={release.rsplit('-', 1)[0]}",
             f"dva.ssafy.io/deployed-release={release}", "--overwrite")
    except Exception as failure:
        print(f"Deployment failed: {failure}", file=sys.stderr)
        if started and old_dep:
            try:
                if service in ('order', 'consultation') and parcel_contract(desired_dep) and not parcel_contract(old_dep):
                    raise RuntimeError('055 schema refuses automatic rollback to an incompatible app; keep writes stopped and deploy a compatible release')
                # A recovery must not overwrite a different operator's newer image.
                current = json.loads(kube("-n", "dva", "get", "deployment", service, "-o", "json"))
                old_image = old_dep["spec"]["template"]["spec"]["containers"][0]["image"]
                if current["spec"]["template"]["spec"]["containers"][0]["image"] not in (image, old_image):
                    raise RuntimeError("Another deployment changed the image; refusing automatic rollback")
                kube("apply", "-f", "previous-resources.json")
                old_kinds = {r["kind"] for r in previous}
                for resource in desired:
                    if resource["kind"] not in old_kinds:
                        kube("-n", "dva", "delete", KINDS[resource["kind"]], service, "--ignore-not-found")
                rollout(service)
                probe(service, previous)
                print(f"DVA_APP_ROLLBACK_COMPLETE={service}")
            except Exception as recovery:
                print(f"ROLLBACK FAILED: {recovery}", file=sys.stderr)
        else:
            print("No previous deployment; retain failed resources for diagnosis.", file=sys.stderr)
        raise
    print(f"DVA_APP_ROLLOUT_COMPLETE={service}")


def main():
    service, release = sys.argv[1:3]
    action = sys.argv[3] if len(sys.argv) == 4 else 'deploy'
    if action not in ('prepare', 'apply', 'deploy') or len(sys.argv) not in (3, 4):
        raise ValueError('Invalid app delivery action')
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", service) or not re.fullmatch(r"[0-9a-f]{40}-[0-9]+", release):
        raise ValueError("Invalid release arguments")
    image = Path("image-name.txt").read_text().strip()
    digest = Path("image-id.txt").read_text().strip()
    if image != f"docker.io/library/dva-{service}:{release}" or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Invalid image identity")
    nodes = json.loads(kube("get", "nodes", "-o", "json"))["items"]
    if len(nodes) != 1:
        raise RuntimeError("Expected exactly one k3s node")
    node = nodes[0]
    info = node["status"]["nodeInfo"]
    if (info["architecture"] != "amd64" or info["operatingSystem"] != "linux"
        or node.get("spec", {}).get("unschedulable")
        or not any(c["type"] == "Ready" and c["status"] == "True" for c in node["status"]["conditions"])):
        raise RuntimeError("Expected a schedulable Ready linux/amd64 node")
    kube("get", "namespace", "dva", "-o", "name")
    if action != 'apply':
        run(["sudo", "-n", "k3s", "ctr", "-n", "k8s.io", "images", "import", str(Path("image.tar").resolve())])
    verify_digest(run(["sudo", "-n", "k3s", "ctr", "-n", "k8s.io", "images", "ls"]), image, digest)
    if action == 'prepare':
        desired = parse_resources(kube('apply', '--dry-run=server', '-f', 'k8s.yaml', '-o', 'json'))
        deployment = validate_resources(desired, service, image)
        Path('prepared-image.json').write_text(json.dumps({
            'release': release, 'image': image, 'digest': digest,
            'parcelDraftsContract': '055' if parcel_contract(deployment) else None,
        }))
        print(f'DVA_APP_IMAGE_PREPARED={service}')
        return
    if action == 'apply':
        prepared = json.loads(Path('prepared-image.json').read_text())
        if (prepared.get('release'), prepared.get('image'), prepared.get('digest')) != (release, image, digest):
            raise RuntimeError('Application preparation does not match this release/image')
    apply_release(service, release, image)


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise RuntimeError(f"Deployment interrupted by signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main()
