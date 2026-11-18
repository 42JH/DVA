#!/usr/bin/env bash
# Sourced by Jenkins-side scripts. The private key is never part of a release.
identity_file=$(realpath -- "${identity_file:?Specify SSH private key}")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
known_hosts="$script_dir/known_hosts"
[[ -f "$identity_file" && -f "$known_hosts" ]] || { echo 'SSH files missing.' >&2; exit 1; }
server='ubuntu@k15d109.p.ssafy.io'
remote_root='/home/ubuntu/msa-deploy/releases'
ssh_options=(-i "$identity_file" -o BatchMode=yes -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts"
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
