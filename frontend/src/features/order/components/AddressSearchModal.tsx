import { KakaoPostcodeEmbed, type Address } from 'react-daum-postcode'
import { Button, FormModal } from '@/shared/ui'

// 주소 검색 창 — 카카오 우편번호 서비스 화면을 창 안에 띄움 (키 · 서버 없이 브라우저에서 바로). 한 줄을 고르면 그 주소로
// 주문 추가 창 대신 떴다가 고르면 돌아감 (두 창이 겹치면 Esc가 둘 다 닫아서)
export function AddressSearchModal({
  title,
  onPick,
  onClose,
}: {
  title: string
  onPick: (address: Address) => void
  onClose: () => void
}) {
  return (
    <FormModal
      title={title}
      width={600}
      onClose={onClose}
      footer={<Button onClick={onClose}>취소</Button>}
    >
      <KakaoPostcodeEmbed
        onComplete={onPick}
        style={{ height: 460 }}
        errorMessage={
          <p className="py-10 text-center text-body text-muted">
            주소 검색을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.
          </p>
        }
      />
    </FormModal>
  )
}
