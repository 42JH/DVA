// 주소 검색 — 창을 하나 더 띄우지 않고 지금 칸 자리에 카카오 우편번호 화면을 펼침. 고르거나 [취소]하면 칸으로 돌아감 (적던 내용 그대로)
import { KakaoPostcodeEmbed } from 'react-daum-postcode'
import type { SearchedAddress } from './AddressSearchModal'
import { Btn } from './controls'

export function AddressPicker({
  title,
  query,
  onPick,
  onClose,
}: {
  title: string
  query?: string // 열자마자 이 말로 검색 (이미 고른 주소를 다시 고를 때)
  onPick: (a: SearchedAddress) => void
  onClose: () => void
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        <Btn className="ml-auto" onClick={onClose}>
          취소
        </Btn>
      </div>
      {/* 테두리는 border로 — 안쪽 ring(inset)은 iframe에 가려 안 보였음 (11/13 사용자: 테두리 · 회색 빈 칸) */}
      {/* 카카오 글자가 화면 글자(14)보다 커서(약 17) 틀째 0.9배로 — iframe 안은 글꼴 · 크기를 못 바꿈 (11/13 사용자: 폰트 · 크기 아쉬움)
          높이 620 × 0.9 = 보이는 높이 약 560 */}
      <div className="[zoom:0.9] overflow-hidden rounded-md border border-ops-line">
        <KakaoPostcodeEmbed
          defaultQuery={query || undefined}
          onComplete={(a) =>
            onPick({
              roadAddress: a.roadAddress || a.address, // 지번을 고르면 도로명이 빌 수 있음
              jibunAddress: a.jibunAddress || a.autoJibunAddress,
              dongName: a.bname,
              postalCode: a.zonecode,
            })
          }
          style={{ height: 620 }}
          // 카카오 기본 회색(진함) → 화면 바탕색(ops-paper) · 결과 상자 · 번호 줄은 흰색 (11/13 팀: 흰 패널에 흰 바탕은 밋밋). 선은 화면 선 색. 지도 · 영문 버튼은 관리 화면에 안 씀
          theme={{ bgColor: '#f5f6f8', pageBgColor: '#FFFFFF', outlineColor: '#e3e6eb' }}
          hideMapBtn
          hideEngBtn
          errorMessage={
            <p className="py-10 text-center text-[14px] text-ops-sub">
              주소 검색을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.
            </p>
          }
        />
      </div>
    </section>
  )
}
