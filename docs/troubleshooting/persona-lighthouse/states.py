# 받아 적은 응답(record.cjs)에서 시험 상태만 바꾼 사본을 만듦 — 고친 내용(상담가 1번 v7)을 시험하는 중 / 끝났는데 실패가 있음
# 실행: python states.py fx-default.json → fx-running.json · fx-review.json (같은 폴더)
import base64, copy, io, json, os, sys

src = sys.argv[1]
fx = json.load(io.open(src, encoding='utf-8'))
KEY = 'GET /api/persona-check/runs'
runs = json.loads(base64.b64decode(fx[KEY]['body']).decode('utf-8'))
seed = next(r for r in runs if r['tag'] == '1:6')


def variant(name, status, done, fail=()):
    run = copy.deepcopy(seed)
    run.update(runId='run-1-7', tag='1:7', createdAt='2026-11-13T20:30:00.000', status=status, finished=done)
    for n, item in enumerate(run['items']):
        if n < done:
            item.update(status='done', passed=item['scenario'] not in fail)
        else:
            item.update(status='running' if n == done and status == 'running' else 'queued', passed=None, liveSeconds=None)
    out = copy.deepcopy(fx)
    out[KEY]['body'] = base64.b64encode(json.dumps(runs + [run], ensure_ascii=False).encode('utf-8')).decode()
    path = os.path.join(os.path.dirname(src), f'fx-{name}.json')
    io.open(path, 'w', encoding='utf-8').write(json.dumps(out, indent=1))
    print(path)


variant('running', 'running', 3)
variant('review', 'done', 10, fail=('A4', 'B3'))
