import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

// 마크다운 글 (11/01 사용자: FAQ 답변의 | 표 |가 글자 그대로 보임) — 표 · 목록 · 굵게 · 링크만 쓰는 정도
// HTML 태그는 해석하지 않음(react-markdown 기본). 줄바꿈 한 번 = 줄바꿈(remark-breaks) — 답변을 textarea 에 쓰던 그대로 보이게
// 09 FAQ 답변 띠에서 씀. 글꼴 · 색은 바깥 className 으로
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`min-w-0 break-words [&>*+*]:mt-2 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
