# 테스트만 쓰는 export 찾기 — 앱 코드(테스트 · mock 제외) 어디에서도 안 쓰고, 자기 파일 안에서도 정의 말고는 안 쓰는 것
# 실행: python testonly.py <frontend 폴더>
import io, os, re, sys

sys.stdout.reconfigure(encoding='utf-8')
root = sys.argv[1]
app, tests = {}, {}
for d, _, fs in os.walk(os.path.join(root, 'src')):
    for f in fs:
        if not f.endswith(('.ts', '.tsx')):
            continue
        p = os.path.join(d, f).replace(os.sep, '/')
        s = io.open(p, encoding='utf-8').read()
        s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
        s = re.sub(r'(?m)(?<!:)//.*$', '', s)
        (tests if f.endswith('.test.ts') else app)[p] = s

for p, s in sorted(app.items()):
    if '/mocks/' in p:
        continue
    for m in re.finditer(r'(?m)^export (?:async )?(?:function\*?|const|let|class|type|interface|enum) ([A-Za-z_$][\w$]*)', s):
        name = m.group(1)
        pat = re.compile(r'(?<![\w$.])' + re.escape(name) + r'(?![\w$])')
        elsewhere = [q for q, t in app.items() if q != p and pat.search(t)]
        if elsewhere:
            continue
        own = len(pat.findall(s)) - 1
        in_tests = [q.split('/src/')[1] for q, t in tests.items() if pat.search(t)]
        if own == 0:
            print(f'{p.split("/src/")[1]}  {name}  — 앱에서 안 씀' + (f' (테스트만: {", ".join(in_tests)})' if in_tests else ' (어디서도)'))
