import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { findKo } from '@/shared/lib/search'
import { MARK } from './Highlight'

// 마크다운 글 (11/01 사용자: FAQ 답변의 | 표 |가 글자 그대로 보임) — 표 · 목록 · 굵게 · 링크만 쓰는 정도
// HTML 태그는 해석하지 않음(react-markdown 기본). 줄바꿈 한 번 = 줄바꿈(remark-breaks) — 답변을 textarea 에 쓰던 그대로 보이게
// 09 FAQ 답변 띠에서 씀. 글꼴 · 색은 바깥 className 으로
// ~ 하나는 취소선 아님(singleTilde: false) — '09:00~18:00 … 2~3일'처럼 범위가 두 번 나오면 그 사이가 취소선이 됨 (11/03). ~~ 두 개는 그대로 취소선
// highlight = 검색어 (09 FAQ 검색으로 들어온 상세, 11/04) — 표 · 목록 · 굵게 안 글자도 맞은 자리만 <mark>. 코드는 그대로
type HNode = {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}
const markHits = (q: string) => (tree: HNode) => {
  const walk = (node: HNode) => {
    if (!node.children || node.tagName === 'code' || node.tagName === 'pre') return
    node.children = node.children.flatMap((c) => {
      if (c.type !== 'text') {
        walk(c)
        return [c]
      }
      const v = c.value ?? ''
      const out: HNode[] = []
      let at = 0
      for (const [s, e] of findKo(v, q)) {
        if (s > at) out.push({ type: 'text', value: v.slice(at, s) })
        out.push({
          type: 'element',
          tagName: 'mark',
          properties: { className: MARK.split(' ') },
          children: [{ type: 'text', value: v.slice(s, e) }],
        })
        at = e
      }
      if (!out.length) return [c]
      if (at < v.length) out.push({ type: 'text', value: v.slice(at) })
      return out
    })
  }
  walk(tree)
}

export function Markdown({
  text,
  className = '',
  highlight,
}: {
  text: string
  className?: string
  highlight?: string
}) {
  return (
    <div className={`min-w-0 break-words [&>*+*]:mt-2 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkBreaks]}
        rehypePlugins={highlight?.trim() ? [[markHits, highlight]] : []}
        components={{
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="border-collapse text-label">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-bg px-3 py-1.5 text-left font-semibold whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-line px-3 py-1.5 align-top">{children}</td>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-action underline"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-bg px-1 py-0.5 font-mono text-caption">{children}</code>
          ),
          // 들여쓴 줄 · ``` 은 <pre> — 기본 white-space: pre 라 긴 줄이 카드 밖으로 뻗음 → 줄바꿈 (11/02)
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded bg-bg p-3 whitespace-pre-wrap">{children}</pre>
          ),
          img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="h-auto max-w-full" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
