// v2 주소 검색 — 창을 하나 더 띄우지 않고 지금 칸 자리에 카카오 우편번호 화면을 펼침. 고르거나 [취소]하면 칸으로 돌아감 (적던 내용 그대로)
import { KakaoPostcodeEmbed } from 'react-daum-postcode'
import type { SearchedAddress } from '@/shared/ui/AddressSearchModal'
import { Btn } from './index'

export function AddressPicker({
  title,
  onPick,
  onClose,
}: {
  title: string
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
      <div className="overflow-hidden rounded-md ring-1 ring-ops-line ring-inset">
        <KakaoPostcodeEmbed
          onComplete={(a) =>
            onPick({
              roadAddress: a.roadAddress || a.address, // 지번을 고르면 도로명이 빌 수 있음
              jibunAddress: a.jibunAddress || a.autoJibunAddress,
              dongName: a.bname,
              postalCode: a.zonecode,
            })
          }
          style={{ height: 440 }}
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
