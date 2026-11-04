import { useContext } from 'react'
import { KakaoPostcodeEmbed } from 'react-daum-postcode'
import { Button } from './Button'
import { TextField } from './FormField'
import { Dialog, FormModal } from './Modal'
import { NewLook } from './newLook'

// 주소 검색 — 03 주문(보내는 분 · 받는 분) · 08 사원 주소 공용 (11/01 shared로 옮김)
// 카카오 우편번호 서비스 화면을 창 안에 띄움 (키 · 서버 없이 브라우저에서 바로). 한 줄을 고르면 서버 주소 칸 모양으로 돌려줌
// 폼 창 대신 떴다가 고르면 돌아감 (두 창이 겹치면 Esc가 둘 다 닫아서). big = 새 디자인 창(Dialog)으로 (03 주문, 11/04)
// 초성 · 최근 검색은 안 붙임: 검색칸이 카카오 화면 안(iframe)이고, 주소는 개인정보라 최근 목록에 남기지 않음 (recentSearches 규칙)

/** 고른 주소 — 서버 주소의 필수 칸(위도 · 경도 빼고). 좌표는 쓰는 쪽에서 */
export interface SearchedAddress {
  roadAddress: string
  jibunAddress: string
  dongName: string
  postalCode: string // 5자리 문자열 (앞 0 보존)
}

export function AddressSearchModal({
  title,
  big,
  onPick,
  onClose,
}: {
  title: string
  big?: boolean
  onPick: (address: SearchedAddress) => void
  onClose: () => void
}) {
  const search = (
    <KakaoPostcodeEmbed
      onComplete={(a) =>
        onPick({
          roadAddress: a.roadAddress || a.address, // 지번 주소를 골랐으면 도로명이 빌 수 있어 그땐 고른 주소 그대로
          jibunAddress: a.jibunAddress || a.autoJibunAddress, // 도로명을 고르면 지번이 비고 auto에 있음
          dongName: a.bname,
          postalCode: a.zonecode,
        })
      }
      style={{ height: 460 }}
      errorMessage={
        <p className="py-10 text-center text-body text-muted">
          주소 검색을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.
        </p>
      }
    />
  )
  return big ? (
    <Dialog
      label={title}
      title={title}
      width={600}
      onClose={onClose}
      footer={
        <Button big className="ml-auto" onClick={onClose}>
          취소
        </Button>
      }
    >
      {search}
    </Dialog>
  ) : (
    <FormModal
      title={title}
      width={600}
      onClose={onClose}
      footer={<Button onClick={onClose}>취소</Button>}
    >
      {search}
    </FormModal>
  )
}

/** 주소 칸 — 직접 칠 수 없고 칸이나 돋보기를 누르면 검색 (오타 주소 방지). 03 주문 · 08 사원 공용 */
export function AddressField({
  label = '주소',
  value,
  error,
  onSearch,
  searchLabel,
}: {
  label?: string
  value: string
  error?: string
  onSearch: () => void
  searchLabel: string // 돋보기 버튼 이름 '보내는 분 주소 검색'
}) {
  const fresh = useContext(NewLook) // 새 디자인 창 안: 칸은 흰 바탕, 돋보기는 파랑 선
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <TextField
          label={label}
          inline
          readOnly
          placeholder="검색으로 고르기"
          value={value}
          error={error}
          onClick={onSearch}
          className={fresh ? 'cursor-pointer' : 'cursor-pointer bg-bg!'}
        />
      </div>
      <Button
        kind={fresh ? 'brandLine' : 'normal'}
        className={fresh ? 'h-9! w-9 px-0!' : 'h-10! w-10 px-0!'}
        onClick={onSearch}
        aria-label={searchLabel}
      >
        <svg
          viewBox="0 0 20 20"
          className={`mx-auto size-5 ${fresh ? 'stroke-current' : 'stroke-ink'}`}
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
        >
          <circle cx="8.5" cy="8.5" r="6" />
          <path d="M13 13l4.5 4.5" />
        </svg>
      </Button>
    </div>
  )
}
