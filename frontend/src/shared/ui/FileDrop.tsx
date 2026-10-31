import { useRef, useState } from 'react'
import { Button } from './Button'

// 파일 고르기 칸 (와이어프레임 08 CSV 기업 등록 · 03 CSV로 주문 추가) — 점선 칸에 끌어다 놓기 또는 [파일 선택]
// 고르면 아래에 파일 이름 줄 + ✕(빼기). 오류면 그 줄이 빨간 선 + 아래 빨간 글. 파일을 읽고 검사하는 건 훅이 함
export function FileDrop({
  file,
  accept,
  error,
  onPick,
  onRemove,
}: {
  file: File | null
  accept: string // '.csv'
  error?: string
  onPick: (file: File) => void
  onRemove: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false) // 파일을 끌고 칸 위에 있는 동안 남색

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault() // 기본 동작(브라우저가 파일을 여는 것) 막기
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) onPick(f)
        }}
        className={`flex flex-col items-center gap-2 rounded-lg border-[1.5px] border-dashed px-4 py-4 ${
          over ? 'border-action bg-action-soft' : 'border-muted bg-bg'
        }`}
      >
        <svg
          viewBox="0 0 20 20"
          className="size-5 stroke-sub"
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M10 13V3M6 7l4-4 4 4M3 13v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
        </svg>
        <p className="text-label text-sub">파일을 여기로 끌어다 놓거나</p>
        <Button small onClick={() => input.current?.click()}>
          파일 선택
        </Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPick(f)
            e.target.value = '' // 같은 파일을 다시 골라도 onChange가 오게
          }}
        />
      </div>
      {file && (
        <div
          className={`flex h-11 items-center justify-between rounded-lg px-3.5 ring-inset ${
            error ? 'ring-[1.5px] ring-danger' : 'ring-1 ring-line'
          }`}
        >
          <span className="truncate text-body">{file.name}</span>
          <button
            type="button"
            onClick={onRemove}
            aria-label="파일 빼기"
            className="grid size-7 shrink-0 place-items-center rounded text-sub hover:bg-bg"
          >
            <svg
              viewBox="0 0 16 16"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-label whitespace-pre-line text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
