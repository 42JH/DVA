import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

// 마크다운 글 (FAQ 답변의 | 표 |가 글자 그대로 보임) — 표 · 목록 · 굵게 · 링크만 쓰는 정도
// HTML 태그는 해석하지 않음(react-markdown 기본). 줄바꿈 한 번 = 줄바꿈(remark-breaks) — 답변을 textarea 에 쓰던 그대로 보이게
// 09 FAQ 답변 띠에서 씀. 글꼴 · 색은 바깥 className 으로
// ~ 하나는 취소선 아님(singleTilde: false) — '09:00~18:00 … 2~3일'처럼 범위가 두 번 나오면 그 사이가 취소선이 됨. ~~ 두 개는 그대로 취소선
// 플러그인 · 부품 표는 모듈 상수 — 그릴 때마다 새로 만들지 않음
const PLUGINS = [[remarkGfm, { singleTilde: false }], remarkBreaks] satisfies Parameters<
  typeof ReactMarkdown
>[0]['remarkPlugins']

const COMPONENTS: Components = {
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
  td: ({ children }) => <td className="border border-line px-3 py-1.5 align-top">{children}</td>,
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  // start: '3.'부터 쓴 목록이 1부터로 보이지 않게 (프롬프트 보기 — 쓴 번호와 보이는 번호가 달랐음)
  ol: ({ children, start }) => (
    <ol start={start} className="list-decimal pl-5">
      {children}
    </ol>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-action underline">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-bg px-1 py-0.5 font-mono text-caption">{children}</code>
  ),
  // 들여쓴 줄 · ``` 은 <pre> — 기본 white-space: pre 라 긴 줄이 카드 밖으로 뻗음 → 줄바꿈
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded bg-bg p-3 whitespace-pre-wrap">{children}</pre>
  ),
  img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="h-auto max-w-full" />,
}

// 같은 글이면 다시 해석하지 않음 — 목록 검색 · 탭 이동처럼 부모만 다시 그릴 때 마크다운 해석이 반복되던 것
export const Markdown = memo(function Markdown({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  return (
    <div className={`min-w-0 break-words [&>*+*]:mt-2 ${className}`}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
