"""compare 로그에서 '뜻 있는' 차이만 셈 — 글자 크기 · 굵기 · 색 · 바탕 · 테두리 · 모서리 · 여백 · 투명도 + 6px 넘는 자리 차이.
같은 부품이 여러 상태에 되풀이되면 그만큼 셈. 인자: 로그 파일들"""
import re, sys

sys.stdout.reconfigure(encoding="utf-8")
STYLE = ("fs", "fw", "color", "bg", "radius", "pad", "op", "deco", "bT", "bB", "bL")
NOISE = [
    r"^b[TBL] 1 solid #\w+→-$",  # 공용 단추: 테두리 대신 안쪽 ring
    r"^b[TBL] 1 solid none→-$",
    r"^bg none→#ffffff$",  # 흰 카드 위 흰 바탕
    r"^bB 1 solid #eef0f3→-$",  # 시안 CSS의 section 선이 번진 것
    r"^radius \d+→33554400$",  # rounded-full
]
for path in sys.argv[1:]:
    style = geo = 0
    for line in open(path, encoding="utf-8-sig"):
        m = re.match(r"^\s+(.+?) \[.*?\]: (.*)$", line)
        if not m:
            continue
        for d in m.group(2).split(", "):
            d = d.strip()
            if any(re.match(n, d) for n in NOISE):
                continue
            k = d.split(" ")[0]
            if k in STYLE:
                style += 1
            elif k in ("x", "y", "w", "h", "right"):
                a, b = re.findall(r"-?\d+", d)[-2:]
                if abs(int(a) - int(b)) > 6:
                    geo += 1
    print(path.split("\\")[-1], "모양 차이", style, "| 6px 넘는 자리 차이", geo)
