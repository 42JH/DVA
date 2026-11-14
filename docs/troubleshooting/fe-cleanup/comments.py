# 주석 검수 — src 전체에서 주석을 떼어 (1) 주석 처리된 코드 (2) 코드에 없는 이름을 가리키는 주석을 찾음
# 실행: python comments.py <frontend 폴더> [stale|code|stats]
import io, os, re, sys, collections
sys.stdout.reconfigure(encoding='utf-8')
root = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'stats'
files = []
for d, _, fs in os.walk(os.path.join(root, 'src')):
    for f in fs:
        if f.endswith(('.ts', '.tsx', '.css')):
            files.append(os.path.join(d, f).replace(os.sep, '/'))

def split(src):
    """(코드만 남긴 글, [(줄 번호, 주석 글)])  — 문자열 · 템플릿 안의 // 는 주석이 아님"""
    code, comments = [], []
    i, n, line = 0, len(src), 1
    state = None  # None | "'" | '"' | '`'
    while i < n:
        c = src[i]
        two = src[i:i + 2]
        if state:
            if c == chr(92):
                code.append(src[i:i + 2]); i += 2; continue
            if c == state:
                state = None
            if c == '\n': line += 1
            code.append(c); i += 1; continue
        if two == '//' and (i == 0 or src[i - 1] != ':'):
            j = src.find('\n', i)
            j = n if j < 0 else j
            comments.append((line, src[i + 2:j].strip()))
            i = j; continue
        if two == '/*':
            j = src.find('*/', i + 2)
            j = n if j < 0 else j
            body = src[i + 2:j]
            comments.append((line, ' '.join(l.strip().lstrip('*').strip() for l in body.split('\n')).strip()))
            line += body.count('\n')
            i = j + 2; continue
        if c in '\'"`':
            state = c
        if c == '\n': line += 1
        code.append(c); i += 1
    return ''.join(code), comments

ident = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*')
code_words, per_file = set(), {}
for p in files:
    src = io.open(p, encoding='utf-8').read()
    code, comments = split(src)
    per_file[p] = (code, comments, src.count('\n') + 1)
    code_words.update(ident.findall(code))
names = {os.path.basename(p) for p in files} | {os.path.splitext(os.path.basename(p))[0] for p in files}
for extra in ('package.json', 'index.html', 'vite.config.ts', 'eslint.config.js', 'tsconfig.app.json'):
    try: code_words.update(ident.findall(io.open(os.path.join(root, extra), encoding='utf-8').read()))
    except OSError: pass

rel = lambda p: p.split('/frontend/')[-1]
if mode == 'stats':
    tot_c = sum(len(c) for _, c, _ in per_file.values())
    print(len(files), '파일,', sum(n for _, _, n in per_file.values()), '줄, 주석', tot_c, '개')
    dens = sorted(((sum(len(t) for _, t in c), len(c), n, rel(p)) for p, (_, c, n) in per_file.items()), reverse=True)[:15]
    for chars, cnt, n, p in dens: print(f'  주석 {cnt:>3}개 {chars:>5}자 / {n:>4}줄  {p}')
elif mode == 'code':
    pat = re.compile(r'^(const |let |var |import |export |return\b|if \(|for \(|while \(|await |<[A-Za-z]|\}|[a-zA-Z_.]+\(.*\);?$|[a-zA-Z_.]+ = .+;?$)')
    for p, (_, comments, _) in sorted(per_file.items()):
        for ln, t in comments:
            if pat.search(t) and not re.search(r'[가-힣]', t[:40]) and not t.startswith(('eslint', '@ts-', 'prettier')):
                print(f'{rel(p)}:{ln}  {t[:130]}')
elif mode == 'stale':
    tick = re.compile(r'`([^`]+)`')
    camel = re.compile(r'(?<![A-Za-z0-9_./@-])(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)(?![A-Za-z0-9_-])')
    fname = re.compile(r'[A-Za-z][A-Za-z0-9_-]*\.(?:tsx?|css|cjs|mjs)\b')
    seen = collections.defaultdict(list)
    for p, (_, comments, _) in sorted(per_file.items()):
        for ln, t in comments:
            cands = set(camel.findall(t)) | set(fname.findall(t))
            for inner in tick.findall(t):
                cands.update(w for w in ident.findall(inner) if len(w) > 3)
            for w in cands:
                base = w.split('.')[0]
                if w in names or base in names or w in code_words or base in code_words: continue
                seen[w].append(f'{rel(p)}:{ln}')
    for w, where in sorted(seen.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        print(f'{w}  ×{len(where)}  {" ".join(where[:4])}')

if mode == 'words':
    # 낡았을 수 있는 주석 — '아직 · 임시 · 나중에 · 예정 · 옛 …' 같은 말이 든 것
    pat = re.compile(sys.argv[3])
    for p, (_, comments, _) in sorted(per_file.items()):
        for ln, t in comments:
            if pat.search(t):
                print(f'{rel(p)}:{ln}  {t[:int(sys.argv[4]) if len(sys.argv) > 4 else 170]}')

if mode == 'dups':
    seen = collections.defaultdict(list)
    for p, (_, comments, _) in sorted(per_file.items()):
        for ln, t in comments:
            if len(t) >= 12 and not t.startswith(('eslint', '----')): seen[t].append(f'{rel(p).replace("frontend/src/", "")}:{ln}')
    for t, where in sorted(seen.items(), key=lambda kv: -len(kv[1])):
        if len(where) > 1: print(f'×{len(where)}  {t[:110]}  ← {" ".join(where[:3])}')
if mode == 'long':
    rows = sorted(((len(t), rel(p).replace('frontend/src/', ''), ln) for p, (_, comments, _) in per_file.items() for ln, t in comments), reverse=True)
    buckets = collections.Counter('500+' if n >= 500 else '300+' if n >= 300 else '200+' if n >= 200 else '100+' if n >= 100 else '~99' for n, _, _ in rows)
    print(dict(buckets))
    for n, p, ln in rows[:25]: print(f'  {n:>4}자 {p}:{ln}')

if mode == 'short':
    rows = [(t, rel(p).replace('frontend/src/', ''), ln) for p, (_, comments, _) in sorted(per_file.items()) for ln, t in comments if 0 < len(t) <= int(sys.argv[3]) and not t.startswith(('eslint', '@ts', '---'))]
    print(len(rows))
    for t, p, ln in rows: print(f'{p}:{ln}  {t}')
