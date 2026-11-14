# ESLint 결과(json) 요약 — 복잡도 15 초과 함수 · 120줄 초과 함수 · 400줄 초과 파일 · 겹친 삼항
# 실행: npx eslint -c eslint.metrics.mjs src -f json > m.json ; python metrics.py m.json [자세히]
import collections
import json
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
d = json.load(open(sys.argv[1], encoding='utf-8'))
full = len(sys.argv) > 2
cx, long_fn, long_file, tern = [], [], [], collections.Counter()
for f in d:
    p = f['filePath'].replace(chr(92), '/').split('/frontend/src/')[1]
    for m in f['messages']:
        r = m['ruleId']
        num = re.search(r'(\d+)', m['message'].split('has', 1)[-1])
        if r == 'complexity':
            name = re.search(r"'([^']+)'", m['message'])
            cx.append((int(num.group(1)), name.group(1) if name else '(이름 없는 함수)', p, m['line']))
        elif r == 'max-lines-per-function':
            name = re.search(r"'([^']+)'", m['message'])
            long_fn.append((int(num.group(1)), name.group(1) if name else '(이름 없는 함수)', p, m['line']))
        elif r == 'max-lines':
            long_file.append((int(num.group(1)), p))
        elif r == 'no-nested-ternary':
            tern[p] += 1
cx.sort(reverse=True)
long_fn.sort(reverse=True)
long_file.sort(reverse=True)
print(
    f'복잡도 15 초과 함수 {len(cx)}개 · 120줄 초과 함수 {len(long_fn)}개 · 400줄 초과 파일 {len(long_file)}개 · 겹친 삼항 {sum(tern.values())}곳'
)
for n, name, p, l in cx if full else cx[:16]:
    print(f'{n:4}  {name}  {p}:{l}')
if full:
    print('--- 120줄 초과 함수')
    for n, name, p, l in long_fn:
        print(f'{n:4}  {name}  {p}:{l}')
    print('--- 400줄 초과 파일')
    for n, p in long_file:
        print(f'{n:4}  {p}')
    print('--- 겹친 삼항 (파일별)')
    for p, c in tern.most_common():
        print(f'{c:4}  {p}')
