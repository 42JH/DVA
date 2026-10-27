"""키·원문·평가 파일 없이 GPU 서버에 필요한 파일만 묶는다."""
import argparse
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    'app/__init__.py', 'app/rag/__init__.py', 'app/rag/gpu.py', 'app/rag/qwen.py',
    'gpu/Dockerfile', 'gpu/Dockerfile.dockerignore', 'gpu/requirements-container.txt',
    'deploy/gcp/bootstrap.sh', 'deploy/gcp/install.sh', 'deploy/gcp/proxy.sh',
    'deploy/gcp/dvr-reranker.service', 'deploy/gcp/dvr-reranker-proxy.service',
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'data/private/gcp/deploy.tar.gz')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(args.output, 'w:gz') as archive:
        for name in FILES:
            archive.add(ROOT/name, arcname=name, recursive=False)
    print(f'배포 파일 {len(FILES)}개 / {args.output.stat().st_size}바이트')


if __name__ == '__main__':
    main()
