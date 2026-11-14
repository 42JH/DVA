# 훅이 돌려주는 값 중 아무 데서도 읽지 않는 것 찾기 — 보수적으로: 다른 파일 어디에도 '.이름' · '{ 이름' · '이름:' · '이름,' 이 없을 때만
# 실행: python vmkeys.py <frontend 폴더>
import io, os, re, sys

sys.stdout.reconfigure(encoding='utf-8')
root = sys.argv[1]
files = {}
for d, _, fs in os.walk(os.path.join(root, 'src')):
    for f in fs:
        if f.endswith(('.tsx', '.ts')) and not f.endswith('.test.ts') and '/mocks/' not in d.replace(os.sep, '/') + '/':
            p = os.path.join(d, f).replace(os.sep, '/')
            files[p] = io.open(p, encoding='utf-8').read()


def strip_comments(s):
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    return re.sub(r'(?m)(?<!:)//.*$', '', s)


def block(s, i):
    depth, quote = 0, None
    for j in range(i, len(s)):
        c = s[j]
        if quote:
            if c == quote and s[j - 1] != '\\':
                quote = None
            continue
        if c in '"\'`':
            quote = c
        elif c in '{[(':
            depth += 1
        elif c in '}])':
            depth -= 1
            if depth == 0:
                return s[i : j + 1]
    return ''


def keys(obj):
    inner, depth, quote, cur, out = obj[1:-1], 0, None, '', []
    for i, c in enumerate(inner):
        if quote:
            if c == quote and inner[i - 1] != '\\':
                quote = None
            cur += c
            continue
        if c in '"\'`':
            quote = c
        if c in '{[(':
            depth += 1
        if c in '}])':
            depth -= 1
        if c == ',' and depth == 0:
            out.append(cur)
            cur = ''
        else:
            cur += c
    out.append(cur)
    names = []
    for part in out:
        part = part.strip()
        if not part or part.startswith('...'):
            continue
        m = re.match(r'([A-Za-z_$][\w$]*)\s*(?::|$|\()', part)
        if m:
            names.append(m.group(1))
    return names


clean = {p: strip_comments(s) for p, s in files.items()}
for p, s in sorted(clean.items()):
    for m in re.finditer(r'export function (use[A-Z]\w*)', s):
        name = m.group(1)
        body_start = s.find('{', s.find(')', m.end()))
        # 함수 몸: 여는 중괄호를 찾기 어렵다(인자 타입에 중괄호) → 함수 이름 뒤 첫 '\n  return {' (들여쓰기 2칸 = 함수 맨 바깥)
        nxt = re.search(r'\nexport |\nfunction |\nconst [A-Za-z]+ = \(', s[m.end() :])
        end = m.end() + (nxt.start() if nxt else len(s) - m.end())
        seg = s[m.end() : end]
        rets = [x for x in re.finditer(r'\n  return \{', seg)]
        if not rets:
            continue
        obj = block(seg, rets[-1].end() - 1)
        dead = []
        for k in keys(obj):
            pat = re.compile(r'(?:\.|\b)' + re.escape(k) + r'\b')
            used_elsewhere = any(pat.search(t) for q, t in clean.items() if q != p)
            # 같은 파일 안에서 돌려주는 자리 말고 또 쓰는지 (다른 훅이 받아 씀)
            inside = len(re.findall(r'\.' + re.escape(k) + r'\b', s))
            if not used_elsewhere and inside == 0:
                dead.append(k)
        if dead:
            print(f'{p.split("/src/")[1]}  {name}: {", ".join(dead)}')
