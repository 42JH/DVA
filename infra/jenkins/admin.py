"""Localhost-only migration helper. Credentials are read from a private file, never printed."""
import argparse
import base64
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['status', 'groovy', 'lint'])
parser.add_argument('--root', default='/home/ubuntu/dva-jenkins')
parser.add_argument('--file')
args = parser.parse_args()
root = Path(args.root)
user, token = (root / 'bootstrap-output/migration-auth').read_text().splitlines()
authorization = 'Basic ' + base64.b64encode(f'{user}:{token}'.encode()).decode()
base = 'http://127.0.0.1:8080/jenkins/'

def request(path, data=None, content_type=None):
    req = urllib.request.Request(base + path, data=data)
    req.add_header('Authorization', authorization)
    if content_type:
        req.add_header('Content-Type', content_type)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return response.read().decode()
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Jenkins request failed: HTTP {error.code}') from None

if args.action == 'status':
    print(request('api/json?tree=useSecurity,numExecutors,jobs[name,color]'))
    print(request('computer/api/json?tree=computer[displayName,offline,numExecutors]'))
elif args.action == 'groovy':
    script = Path(args.file).read_text()
    print(request('scriptText', urllib.parse.urlencode({'script': script}).encode(), 'application/x-www-form-urlencoded'))
else:
    body = urllib.parse.urlencode({'jenkinsfile': Path(args.file).read_text()}).encode()
    result = request('pipeline-model-converter/validate', body, 'application/x-www-form-urlencoded')
    print(result)
    if 'Jenkinsfile successfully validated' not in result:
        raise SystemExit('Pipeline syntax validation failed')
