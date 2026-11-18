# 아무도 넘기지 않는 부품 옵션 찾기 — 부품의 받는 값 이름과, 그 부품을 쓰는 JSX 태그의 속성 이름을 대조
import io, os, re, sys
sys.stdout.reconfigure(encoding='utf-8')
root = sys.argv[1]
files = {}
for d, _, fs in os.walk(os.path.join(root, 'src')):
    for f in fs:
        if f.endswith(('.tsx', '.ts')) and not f.endswith('.test.ts'):
            p = os.path.join(d, f).replace(os.sep, '/')
            files[p] = io.open(p, encoding='utf-8').read()
allsrc = '\n'.join(files.values())

def block(s, i, open_ch, close_ch):
    depth = 0
    for j in range(i, len(s)):
        if s[j] == open_ch: depth += 1
        elif s[j] == close_ch:
            depth -= 1
            if depth == 0: return s[i:j + 1]
    return ''

def top_names(pattern):
    # '{ a, b = 1, c: d, ...rest }' → 이름들 (중첩 무시)
    inner, depth, cur, out = pattern[1:-1], 0, '', []
    for ch in inner:
        if ch in '{[(<': depth += 1
        if ch in '}])>': depth -= 1
        if ch == ',' and depth == 0:
            out.append(cur); cur = ''
        else: cur += ch
    out.append(cur)
    names = []
    for part in out:
        part = re.sub(r'//.*', '', part).strip()
        if not part: continue
        if part.startswith('...'): names.append('...'); continue
        m = re.match(r'([A-Za-z_$][\w$]*)', part)
        if m: names.append(m.group(1))
    return names

def tags(name):
    # <Name ...> 여는 태그들의 글 (여러 줄)
    out = []
    for m in re.finditer(r'<' + re.escape(name) + r'(?=[\s/>])', allsrc):
        i, depth, j = m.end(), 0, m.end()
        quote = None
        while j < len(allsrc):
            c = allsrc[j]
            if quote:
                if c == quote: quote = None
            elif c in '"\'`': quote = c
            elif c == '{': depth += 1
            elif c == '}': depth -= 1
            elif c == '>' and depth == 0 and allsrc[j - 1] != '=': break
            j += 1
        out.append(allsrc[i:j])
    return out

def attrs(tag):
    names, depth, quote, i = set(), 0, None, 0
    clean = ''
    for c in tag:  # 중괄호 · 따옴표 안은 지움
        if quote:
            if c == quote: quote = None
            continue
        if c in '"\'`' and depth == 0: quote = c; continue
        if c == '{': depth += 1; clean += ' {} ' if depth == 1 else ''; continue
        if c == '}': depth -= 1; continue
        if depth == 0: clean += c
    spread = '{...' in tag
    for m in re.finditer(r'([A-Za-z_][\w-]*)\s*(?==|\s|/|$)', clean):
        names.add(m.group(1))
    return names, spread

for p, s in sorted(files.items()):
    for m in re.finditer(r'(?:export\s+)?function\s+([A-Z]\w*)\s*(?:<[^(]*>)?\(\s*\{', s):
        name = m.group(1)
        pat = block(s, m.end() - 1, '{', '}')
        props = [n for n in top_names(pat) if n not in ('children', '...')]
        if not props: continue
        used, any_spread, uses = set(), False, tags(name)
        if not uses: continue
        for t in uses:
            a, sp = attrs(t)
            used |= a; any_spread |= sp
        dead = [x for x in props if x not in used]
        if dead: print(f'{p.split("/src/")[1]}  {name} (쓰는 곳 {len(uses)})  안 넘기는 값: {", ".join(dead)}{"  ※ 펼쳐 넘기는 곳 있음" if any_spread else ""}')
