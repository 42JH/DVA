#!/usr/bin/env bash
set -euo pipefail
identity_file=${1:?Specify SSH private key}
source "$(dirname -- "${BASH_SOURCE[0]}")/ssh-common.sh"
# Both reads must succeed. An unavailable cluster is not an empty deployment history.
ssh -n "${ssh_options[@]}" "$server" 'set -e; sudo -n k3s kubectl -n dva get deployments -o json; sudo -n k3s kubectl get namespace dva -o json'
