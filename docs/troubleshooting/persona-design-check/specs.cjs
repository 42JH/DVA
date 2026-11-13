// 시안(after.html)과 실제 화면에서 같은 것을 재는 표 — [이름, 시안 쪽 찾기, 화면 쪽 찾기]
// 찾기: 'css' | { t: '정확한 글', in?: css } | { re: '정규식', in?: css, n? } | { all: css, n } | { up: css, n } | { sel: css, tn: true }(글자만)
const BAND = 'article > header + div'
const PB = 'article h3 + div'
const head = [
  ['ct(바깥 여백)', '.ct', { up: 'article', n: 1 }],
  ['탭 줄', '.tabs', { up: '[aria-label="상담가"]', n: 1 }],
  ['탭(고른 것)', '.tab.on', '[aria-label="상담가"] [aria-selected="true"]'],
  ['탭(안 고른 것)', '.tab:not(.on)', '[aria-label="상담가"] [aria-selected="false"]'],
  ['탭 안 사용 중 뱃지', '.tab.on .bd', '[aria-label="상담가"] [aria-selected="true"] span'],
  ['[상담가 등록]', '.addp', { t: '상담가 등록' }],
  ['카드', '.card', 'article'],
  ['머리 줄', '.ch', 'article > header'],
  ['이름 글자', { sel: '.nm', tn: true }, { sel: 'article header h2', tn: true }],
  ['연필 단추', '.pen', 'button[aria-label="이름 바꾸기"]'],
  ['연필 그림', '.pen svg', 'button[aria-label="이름 바꾸기"] svg'],
  ['목소리 칸', '.vsel', 'article header .h-7'],
  ['저장 시각', '.vo > span:nth-child(2)', { re: '저장', in: 'article header' }],
  ['수정 기록 보기', '.tl', { t: '수정 기록 보기' }],
]
const body = [
  ['프롬프트 바깥', '.fdoc', { up: 'article h3', n: 1 }],
  ['프롬프트 제목', '.fdoc h3', 'article h3'],
  ['프롬프트 상자', '.pbox', PB],
  ['회색 제목 줄', '.pbox .ph', { t: '역할', in: PB }],
]
const bandBase = [
  ['띠', '.band', BAND],
  ['띠 뱃지', '.band .bd', BAND + ' > span:first-child'],
]
const seg = [
  ['토글 줄', '.seg', BAND + ' + div'],
  ['토글 받침', '.seg .sg', { up: '[aria-label="보는 내용"]', n: 0 }],
  ['토글(고른 것)', '.sg .on', '[aria-label="보는 내용"] [aria-selected="true"]'],
  ['토글(안 고른 것)', '.sg span:not(.on)', '[aria-label="보는 내용"] [aria-selected="false"]'],
]
exports.STATES = {
  live: {
    design: 'A',
    probes: [
      ...head,
      ['통화에 사용 중 뱃지', '.nm .bd', { t: '통화에 사용 중', in: 'article header' }],
      ['[시나리오 시험]', '.ch > .b', { t: '시나리오 시험', in: 'article header' }],
      ...body,
      ['프롬프트 글', '.pbox .pc', PB + ' textarea'],
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  unapplied: {
    design: 'B',
    probes: [
      ...bandBase,
      ['띠 제목', '.band b', { t: '고친 내용', in: BAND }],
      ['띠 흐린 글', '.band .dim', { re: '저장', in: BAND }],
      ['[통화에 반영]', '.band .b', { t: '통화에 반영' }],
      ...seg,
      ['프롬프트 제목', '.fdoc h3', 'article h3'],
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  editing: {
    design: 'E',
    probes: [
      ['[취소]', { t: '취소', in: '.ch' }, { t: '취소', in: 'article header' }],
      ['[저장]', { t: '저장', in: '.ch' }, { t: '저장', in: 'article header' }],
      ['프롬프트 상자(초점)', '.pbox', PB],
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  testing: {
    design: 'K',
    probes: [
      ...bandBase,
      ['띠 제목', '.band b', { t: '통화에 반영하기 전 시험', in: BAND }],
      ['띠 진행 글', '.band .dim', { re: '^시나리오 \\d+ / \\d+$', in: BAND }],
      ['진행 막대', '.band .bar', BAND + ' progress'],
      ['통과 n', { all: '.band .dim', n: 1 }, { re: '^통과 \\d+$', in: BAND }],
      ['실패 n', '.band .stop', { re: '^실패 \\d+$', in: BAND }],
      ['[진행 보기]', { t: '진행 보기' }, { t: '진행 보기' }],
      ['[시험 중단]', { t: '시험 중단', in: '.band' }, { t: '시험 중단', in: BAND }],
      ['목소리 칸(막힘)', '.vsel', 'article header .h-7'],
      ['수정 기록 보기(막힘)', '.tl', { t: '수정 기록 보기' }],
      ['프롬프트 상자(막힘)', '.pbox', PB],
      ['프롬프트 글(막힘)', '.pbox .pc', PB + ' p'],
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  applying: {
    design: 'I',
    probes: [
      ...bandBase,
      ['띠 제목', '.band b', { t: '고친 내용', in: BAND }],
      ['띠 흐린 글 1', '.band .dim', { re: '저장', in: BAND }],
    ],
    counts: [['띠 흐린 글 수', '.band .dim', BAND + ' .text-ops-sub']],
  },
  review: {
    design: 'M',
    probes: [
      ...bandBase,
      ['띠 제목', '.band b', { re: '^시나리오 \\d+개 실패$', in: BAND }],
      ['띠 흐린 글', '.band .dim', { re: '시험$', in: BAND }],
      ['[실패한 시나리오 보기]', { t: '실패한 시나리오 보기' }, { t: '실패한 시나리오 보기' }],
      ['[확인하고 반영]', { t: '확인하고 반영' }, { t: '확인하고 반영' }],
      ...seg,
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  stopped: {
    design: 'O',
    probes: [
      ...bandBase,
      ['띠 제목', '.band b', { re: '에서 멈춤$', in: BAND }],
      ['[지금까지 결과 보기]', { t: '지금까지 결과 보기' }, { t: '지금까지 결과 보기' }],
      ['[다시 시험하고 반영]', { t: '다시 시험하고 반영' }, { t: '다시 시험하고 반영' }],
      ...seg,
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  unused: {
    design: 'D',
    probes: [
      ['[삭제]', { t: '삭제', in: '.ch' }, { t: '삭제', in: 'article header' }],
      ['[시나리오 시험]', { t: '시나리오 시험', in: '.ch' }, { t: '시나리오 시험', in: 'article header' }],
      ['[통화에 사용하기]', { t: '통화에 사용하기', in: '.ch' }, { t: '통화에 사용하기', in: 'article header' }],
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  testing2: {
    design: 'K2',
    probes: [['띠 제목', '.band b', { t: '통화에 쓰기 전 시험', in: BAND }]],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  passed: {
    design: 'Q',
    probes: [
      ...bandBase,
      ['띠 제목', '.band b', { re: '모두 통과$', in: BAND }],
      ['띠 흐린 글', '.band .dim', { re: '시험$', in: BAND }],
      ['[결과 보기]', { t: '결과 보기' }, { t: '결과 보기' }],
      ['띠 [통화에 사용하기]', { t: '통화에 사용하기', in: '.band' }, { t: '통화에 사용하기', in: BAND }],
    ],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  applying2: {
    design: 'I2',
    probes: [...bandBase, ['띠 제목', '.band b', { t: '통화에 들어가는 중', in: BAND }], ['띠 흐린 글', '.band .dim', { re: '^AI 확인', in: BAND }]],
    counts: [['머리 줄 단추 수', '.ch > .b', 'article > header > span:last-child button']],
  },
  renaming: {
    design: 'S',
    probes: [['이름 입력 칸', '.nmin', 'input[aria-label="상담가 이름"]'], ['목소리 칸', '.vsel', 'article header .h-7'], ['프롬프트 제목', '.fdoc h3', 'article h3']],
  },
  add: {
    design: 'F',
    probes: [
      ['머리 줄', '.ch', 'form > header'],
      ['제목 글자', { sel: '.nm', tn: true }, { sel: 'form h2', tn: true }],
      ['[취소]', { t: '취소', in: '.ch' }, { t: '취소', in: 'form header' }],
      ['[등록]', { t: '등록', in: '.ch' }, { t: '등록', in: 'form header' }],
      ['이름 · 목소리 줄', '.row2', 'form > header + div'],
      ['이름표', '.row2 label', { t: '이름', in: 'form > header + div' }],
      ['이름 칸', '.row2 .in', 'form input'],
      ['목소리 칸', '.row2 .in.sel', 'form select'],
      ['프롬프트 제목', '.fdoc section.one h3', 'form h3'],
      ['프롬프트 상자', '.pbox', 'form h3 + div'],
      ['회색 제목 줄', '.pbox .ph', { t: '역할', in: 'form h3 + div' }],
      ['프롬프트 글', '.pbox .pc', 'form h3 + div textarea'],
    ],
  },
  history: {
    design: 'C',
    probes: [
      ['창', '.modal', '[role=dialog]'],
      ['창 머리', '.mh', '[role=dialog] > div:first-child'],
      ['창 제목', '.mh h2', '[role=dialog] h2'],
      ['목록', '.list', '[role=dialog] ol'],
      ['목록 줄', '.list li', '[role=dialog] ol button'],
      ['목록 줄(고른 것)', '.list li.on', '[role=dialog] ol button[aria-current]'],
      ['목록 날짜', '.list li b', '[role=dialog] ol button > span:first-child'],
      ['목록 사람', '.list li > span:not(.bd)', '[role=dialog] ol button > span:nth-child(2)'],
      ['오른쪽 칸', '.pv', '[role=dialog] section'],
      ['오른쪽 제목', '.pvh', '[role=dialog] section h3'],
      ['오른쪽 흐린 글', '.pvh .dim', '[role=dialog] section h3 span'],
      ['항목 제목', '.pv section h3', '[role=dialog] section h4'],
      ['항목 글', '.pv section p', '[role=dialog] section h4 + span'],
      ['뺀 말', '.pv del', '[role=dialog] del'],
      ['더한 말', '.pv ins', '[role=dialog] ins'],
      ['아래 줄', '.mf', '[role=dialog] [data-foot]'],
      ['[취소]', { t: '취소', in: '.mf' }, { t: '취소', in: '[data-foot]' }],
      ['[이 내용 불러오기]', { t: '이 내용 불러오기' }, { t: '이 내용 불러오기' }],
    ],
  },
  result: {
    design: 'P5',
    probes: [
      ['바깥 여백', '.ct', { up: 'main article', n: 1 }],
      ['숫자 줄', '.lh', { up: 'main dl', n: 1 }],
      ['숫자 이름', '.st span', 'main dt'],
      ['숫자', '.st b', 'main dd'],
      ['통과 숫자', '.st b.okc', { all: 'main dd', n: 1 }],
      ['[남은 n개 시험]', { re: '^남은 \\d+개 시험$' }, { re: '^남은 \\d+개 시험$' }],
      ['[전체 n개 시험]', { re: '^전체 \\d+개 시험$' }, { re: '^전체 \\d+개 시험$' }],
      ['표 상자', '.box', 'main article'],
      ['표 머리 칸', '.tb th', 'main thead th'],
      ['표 머리 칸 2', { all: '.tb th', n: 1 }, { all: 'main thead th', n: 1 }],
      ['표 머리 칸 3', { all: '.tb th', n: 2 }, { all: 'main thead th', n: 2 }],
      ['표 머리 칸 5', { all: '.tb th', n: 4 }, { all: 'main thead th', n: 4 }],
      ['표 머리 날짜', '.tb th span', 'main thead th span'],
      ['표 칸(업무)', '.tb td', 'main tbody td'],
      ['표 칸(시나리오)', { all: '.tb td', n: 1 }, { all: 'main tbody td', n: 1 }],
      ['표 칸(결과)', { all: '.tb td', n: 2 }, { all: 'main tbody td', n: 2 }],
      ['결과 뱃지', '.tb .bd', 'main tbody td span.inline-flex'],
      ['표 둘째 줄', { all: '.tb tbody tr', n: 1 }, { all: 'main tbody tr', n: 1 }],
    ],
  },
  running: {
    design: 'P5b',
    probes: [
      ['진행 이름', '.st span', 'main dt'],
      ['진행 숫자', '.st b', 'main dd'],
      ['진행 막대', '.bar.big', 'main progress'],
      ['통과 n', '.lh > .dim', { re: '^통과 \\d+$', in: 'main' }],
      ['실패 n', '.lh > .stop', { re: '^실패 \\d+$', in: 'main' }],
      ['[시험 중단]', { t: '시험 중단' }, { t: '시험 중단', in: 'main' }],
    ],
  },
  detail: {
    design: 'P7',
    probes: [
      ['바깥 여백', '.ct', { up: 'main article', n: 1 }],
      ['카드', '.card', 'main article'],
      ['탭 줄', '.seg', 'main article > div:first-child'],
      ['탭 받침', '.sg', { up: '[aria-label="보는 결과"]', n: 1 }],
      ['탭(고른 것)', '.sg > .on', '[aria-label="보는 결과"] [aria-selected="true"]'],
      ['탭(안 고른 것)', '.sg > span:not(.on)', '[aria-label="보는 결과"] [aria-selected="false"]'],
      ['탭 날짜', '.sg em', '[aria-label="보는 결과"] [aria-selected="true"] span'],
      ['시험 시각', '.seg > .dim', 'main article > div:first-child > span:last-child'],
      ['대화 칸', '.tr', '[aria-label="통화 대화"]'],
      ['결과표 칸', '.rs', '[aria-label="결과표"]'],
      ['결과표 제목', '.rh b', { sel: '[aria-label="결과표"] h2', tn: true }],
      ['결과표 흐린 글', '.rh .dim', '[aria-label="결과표"] h2 span'],
      ['결과표 머리 칸', '.tb.sm th', '[aria-label="결과표"] th'],
      ['결과표 칸', '.tb.sm td', '[aria-label="결과표"] td'],
      ['판정 뱃지', '.tb.sm .bd', '[aria-label="결과표"] td span.inline-flex'],
      ['재생 줄', '.pl', { up: 'main audio', n: 1 }],
    ],
  },
}

// 페이지 안에서 도는 재기 함수 (문자열로 넣음)
exports.MEASURE = function (rootSel, specs, counts, side) {
  const root = rootSel ? document.querySelector(rootSel) : document.body
  if (!root) return { error: 'no root ' + rootSel }
  const base = rootSel ? root.getBoundingClientRect() : { x: 0, y: 0 }
  const txt = (e) => e.textContent.replace(/\s+/g, ' ').trim()
  const find = (s) => {
    if (typeof s === 'string') return root.querySelector(s)
    if (s.sel) return root.querySelector(s.sel)
    if (s.all) return root.querySelectorAll(s.all)[s.n || 0] || null
    if (s.up) {
      let e = root.querySelector(s.up)
      for (let i = 0; e && i < (s.n || 0); i++) e = e.parentElement
      return e
    }
    const scope = s.in ? root.querySelector(s.in) : root
    if (!scope) return null
    const els = [...scope.querySelectorAll('*')].filter((e) => !e.closest('svg') && e.getClientRects().length)
    if (s.t) {
      const m = els.filter((e) => txt(e) === s.t)
      // 가장 안쪽 것 (같은 글을 가진 자식이 없는 것)
      return m.filter((e) => ![...e.children].some((c) => txt(c) === s.t))[s.n || 0] || null
    }
    if (s.re) {
      const r = new RegExp(s.re)
      return els.filter((e) => r.test(txt(e)) && ![...e.children].some((c) => r.test(txt(c))))[s.n || 0] || null
    }
    return null
  }
  const out = {}
  for (const [label, d, a] of specs) {
    const spec = side === 'design' ? d : a
    const el = find(spec)
    if (!el) {
      out[label] = null
      continue
    }
    let r = el.getBoundingClientRect()
    if (spec.tn) {
      const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())
      if (tn) {
        const g = document.createRange()
        g.selectNodeContents(tn)
        r = g.getBoundingClientRect()
      }
    }
    const cs = getComputedStyle(el)
    const px = (v) => Math.round(parseFloat(v) * 10) / 10
    const bw = (side_) => (parseFloat(cs['border' + side_ + 'Width']) > 0 && cs['border' + side_ + 'Style'] !== 'none' ? px(cs['border' + side_ + 'Width']) + ' ' + cs['border' + side_ + 'Style'] + ' ' + cs['border' + side_ + 'Color'] : '-')
    out[label] = {
      text: txt(el).slice(0, 40),
      x: Math.round(r.x - base.x),
      y: Math.round(r.y - base.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(1440 - (r.right - base.x)),
      fs: px(cs.fontSize),
      fw: cs.fontWeight,
      lh: cs.lineHeight === 'normal' ? 'normal' : px(cs.lineHeight),
      color: cs.color,
      bg: cs.backgroundColor,
      bT: bw('Top'),
      bB: bw('Bottom'),
      bL: bw('Left'),
      radius: px(cs.borderTopLeftRadius),
      pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px).join(' '),
      gap: cs.columnGap === 'normal' ? '-' : px(cs.columnGap),
      op: cs.opacity,
      shadow: cs.boxShadow === 'none' ? '-' : cs.boxShadow.replace(/\s+/g, ' ').slice(0, 60),
      deco: cs.textDecorationLine,
    }
  }
  const n = {}
  for (const [label, d, a] of counts || []) n[label] = root.querySelectorAll(side === 'design' ? d : a).length
  return { probes: out, counts: n }
}
