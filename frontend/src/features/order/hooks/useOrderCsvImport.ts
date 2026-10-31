import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useSession } from '@/shared/auth/useSession'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { createOrders, orderQueries, type OrderInput } from '@/features/order/api/orderApi'
import { ORDER_CSV_COLUMNS, ORDER_CSV_EXAMPLE, parseOrderCsv } from '@/features/order/api/orderCsv'

const MAX_BYTES = 2 * 1024 * 1024 // 2MB — 주문 500줄은 이보다 훨씬 작음

/** 03 CSV로 주문 추가 창 훅 — 파일을 고르면 바로 읽고 검사(서버에 보내기 전에), 통과하면 [등록]으로 한 번에 넣음
 * 한 줄이라도 틀리면 전부 안 넣음 (일부만 들어가면 어느 줄이 들어갔는지 다시 맞추기 어려움) */
export function useOrderCsvImport(onDone: () => void) {
  const qc = useQueryClient()
  const { me } = useSession()
  const [file, setFile] = useState<File | null>(null)
  const [orders, setOrders] = useState<OrderInput[]>([])
  const [checkError, setCheckError] = useState<string | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID()) // 파일 하나에 멱등키 하나
  const latest = useRef<File | null>(null) // 빨리 두 번 고르면 마지막 파일의 검사 결과만 씀

  const mutation = useMutation({
    mutationFn: () => createOrders(orders, key, me?.loginId ?? ''),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orderQueries.all() })
      onDone()
    },
  })

  const reset = () => {
    latest.current = null
    setFile(null)
    setOrders([])
    setCheckError(null)
    setKey(crypto.randomUUID())
    mutation.reset()
  }

  const pick = async (f: File) => {
    reset()
    setFile(f)
    latest.current = f
    if (!f.name.toLowerCase().endsWith('.csv'))
      return setCheckError('CSV 파일(.csv)만 넣을 수 있습니다.')
    if (f.size > MAX_BYTES) return setCheckError('파일이 너무 큽니다. (2MB까지)')
    const result = parseOrderCsv(await f.text()) // 엑셀 'CSV UTF-8'로 저장한 파일 기준
    if (latest.current !== f) return
    if (!result.ok) return setCheckError(result.error)
    setOrders(result.orders)
  }

  return {
    file,
    pick: (f: File) => void pick(f),
    remove: reset,
    error: checkError ?? mutation.error?.message ?? undefined,
    summary: orders.length ? `주문 ${orders.length.toLocaleString('ko-KR')}건을 추가합니다.` : null,
    downloadTemplate: () =>
      downloadCsv(
        '주문_추가_양식.csv',
        toCsv([...ORDER_CSV_COLUMNS], [ORDER_CSV_COLUMNS.map((c) => ORDER_CSV_EXAMPLE[c])]),
      ),
    canSubmit: orders.length > 0 && !mutation.isPending,
    isSubmitting: mutation.isPending,
    submit: () => mutation.mutate(),
  }
}
