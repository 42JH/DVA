// 가짜 시나리오 시험의 시나리오 10개 — 시험 도구의 scenarios.toml(11/12)을 화면 모양으로 옮긴 것. 손으로 고치지 않음
// 번호 · 이름 · 업무 · 전화한 사람 · 고객 대본(optional = 상황에 따라 안 할 수 있는 말) · 정답 · 행동 확인
export const SCRIPTS = {
  A1: {
    id: 'A1',
    name: '신규 고객 기본 접수',
    group: '접수',
    core: true,
    caller: '신규 고객',
    lines: [
      {
        text: '택배 접수하려고요.',
        optional: false,
      },
      {
        text: '김철수입니다.',
        optional: false,
      },
      {
        text: '이지은이요.',
        optional: false,
      },
      {
        text: '010-2345-6789요.',
        optional: false,
      },
      {
        text: '서울시 강남구 테헤란로 212요.',
        optional: false,
      },
      {
        text: '멀티캠퍼스 1층이요.',
        optional: false,
      },
      {
        text: '부산 해운대구 센텀중앙로 79요.',
        optional: false,
      },
      {
        text: '102동 1503호요.',
        optional: false,
      },
      {
        text: '옷이랑 책이요. 중형 박스 하나요.',
        optional: false,
      },
      {
        text: '5만 원 정도요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
      {
        text: '아니요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '1',
      },
      {
        name: '보내는 분 이름',
        value: '김철수',
      },
      {
        name: '보내는 곳 주소',
        value: '서울시 강남구 테헤란로 212',
      },
      {
        name: '보내는 곳 상세주소',
        value: '멀티캠퍼스 1층',
      },
      {
        name: '받는 분 이름',
        value: '이지은',
      },
      {
        name: '받는 분 번호',
        value: '010-2345-6789',
      },
      {
        name: '받는 곳 주소',
        value: '부산 해운대구 센텀중앙로 79',
      },
      {
        name: '받는 곳 상세주소',
        value: '102동 1503호',
      },
      {
        name: '물품',
        value: '중형 박스 1개',
      },
      {
        name: '물품 가액',
        value: '50,000원',
      },
    ],
    checks: [
      '첫 인사가 "안녕하세요. 디바콜입니다. 택배 접수를 원하시거나 궁금하신 점이 있으시면 편하게 말씀해 주세요"이다',
      '보내는 분 연락처를 묻지 않는다',
      '받는 분 전화번호를 고객이 말한 숫자 그대로 끊어 읽어 확인한다',
      '보내는 곳과 받는 곳의 지역 이름으로 경로를 확인한다',
      '접수 직전 되읽기에 도로명 주소, 상세주소, 연락처, 물품, 가액을 넣지 않는다(이름과 지역 이름은 괜찮다)',
      '고객이 접수에 동의하기 전에 접수됐다고 말하지 않는다',
    ],
  },
  A2: {
    id: 'A2',
    name: '등록 고객, 주소록 1건 매칭',
    group: '접수',
    core: false,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네.',
        optional: true,
      },
      {
        text: '이지은이요.',
        optional: false,
      },
      {
        text: '네, 맞아요.',
        optional: true,
      },
      {
        text: '반찬통이요. 중형 박스 하나요.',
        optional: false,
      },
      {
        text: '3만 원이요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '1',
      },
      {
        name: '받는 분 이름',
        value: '이지은',
      },
      {
        name: '받는 분 번호',
        value: '010-2345-6789',
      },
      {
        name: '받는 곳 주소',
        value: '부산 해운대구 센텀중앙로 79',
      },
      {
        name: '받는 곳 상세주소',
        value: '102동 1503호',
      },
      {
        name: '물품',
        value: '중형 박스 1개',
      },
      {
        name: '물품 가액',
        value: '30,000원',
      },
    ],
    checks: [
      '보내는 분 성함과 발송 주소를 새로 말해 달라고 하지 않는다',
      '주소록 후보를 확인할 때 이름과 지역만 말하고, 저장된 상세주소와 연락처를 먼저 읽지 않는다',
      '받는 분의 연락처와 주소를 새로 말해 달라고 하지 않는다',
    ],
  },
  A4: {
    id: 'A4',
    name: '등록 고객, 주소록에 없는 새 받는 분',
    group: '접수',
    core: false,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네. 받는 사람은 박서진이에요.',
        optional: false,
      },
      {
        text: '010-7777-8888이요.',
        optional: false,
      },
      {
        text: '대전 유성구 대학로 99요.',
        optional: false,
      },
      {
        text: '공학관 305호요.',
        optional: false,
      },
      {
        text: '반찬통이요. 중형 박스 하나요.',
        optional: false,
      },
      {
        text: '3만 원이요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '1',
      },
      {
        name: '받는 분 이름',
        value: '박서진',
      },
      {
        name: '받는 분 번호',
        value: '010-7777-8888',
      },
      {
        name: '받는 곳 주소',
        value: '대전 유성구 대학로 99',
      },
      {
        name: '받는 곳 상세주소',
        value: '공학관 305호',
      },
      {
        name: '물품',
        value: '중형 박스 1개',
      },
      {
        name: '물품 가액',
        value: '30,000원',
      },
    ],
    checks: [
      '보내는 분 성함과 발송 주소를 새로 말해 달라고 하지 않는다',
      '받는 분 전화번호를 고객이 말한 숫자 그대로 끊어 읽어 확인한다',
      '접수 직전 되읽기에 도로명 주소, 상세주소, 연락처, 물품, 가액을 넣지 않는다(이름과 지역 이름은 괜찮다)',
    ],
  },
  B1: {
    id: 'B1',
    name: '한 번에 여러 정보 말하기',
    group: '정보 수집',
    core: false,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네. 받는 사람은 박서진이고 번호는 010-7777-8888, 주소는 대전 유성구 대학로 99 공학관 305호예요.',
        optional: false,
      },
      {
        text: '반찬통이요. 중형 박스 하나요.',
        optional: false,
      },
      {
        text: '3만 원이요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '1',
      },
      {
        name: '받는 분 이름',
        value: '박서진',
      },
      {
        name: '받는 분 번호',
        value: '010-7777-8888',
      },
      {
        name: '받는 곳 주소',
        value: '대전 유성구 대학로 99',
      },
      {
        name: '물품',
        value: '중형 박스 1개',
      },
      {
        name: '물품 가액',
        value: '30,000원',
      },
    ],
    checks: ['고객이 이미 말한 받는 분 성함, 연락처, 주소를 새로 말해 달라고 하지 않는다'],
  },
  B3: {
    id: 'B3',
    name: '앞 항목 정정',
    group: '정보 수집',
    core: true,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네. 받는 사람은 박서진이에요.',
        optional: false,
      },
      {
        text: '아, 잠깐만요. 아까 이름 틀렸어요. 박서진이 아니라 박서준이에요.',
        optional: false,
      },
      {
        text: '010-7777-8888이요.',
        optional: false,
      },
      {
        text: '대전 유성구 대학로 99요.',
        optional: false,
      },
      {
        text: '공학관 305호요.',
        optional: false,
      },
      {
        text: '반찬통이요. 중형 박스 하나요.',
        optional: false,
      },
      {
        text: '3만 원이요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '1',
      },
      {
        name: '받는 분 이름',
        value: '박서준',
      },
      {
        name: '받는 분 번호',
        value: '010-7777-8888',
      },
      {
        name: '받는 곳 주소',
        value: '대전 유성구 대학로 99',
      },
      {
        name: '받는 곳 상세주소',
        value: '공학관 305호',
      },
      {
        name: '물품',
        value: '중형 박스 1개',
      },
      {
        name: '물품 가액',
        value: '30,000원',
      },
    ],
    checks: [
      '받는 분 성함을 박서준으로 고쳤다고 한 번 확인한다',
      '정정한 뒤 하던 질문(받는 분 연락처)으로 돌아간다',
    ],
  },
  E1: {
    id: 'E1',
    name: '1건 조회',
    group: '조회',
    core: true,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '아니요.',
        optional: true,
      },
      {
        text: '보낸 택배 확인하려고요.',
        optional: false,
      },
      {
        text: '이지은이요.',
        optional: false,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '0',
      },
      {
        name: '조회 실행',
        value: '1회 이상',
      },
    ],
    checks: [
      '이지은님께 보낸 택배의 상태를 접수 미완료(최종 접수 전)로 안내한다',
      '"수거 중", "배송 중"처럼 없는 상태를 말하지 않는다',
    ],
  },
  F1: {
    id: 'F1',
    name: '취소 가능한 택배 취소',
    group: '취소',
    core: true,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '아니요.',
        optional: true,
      },
      {
        text: '접수한 택배 취소하고 싶어요.',
        optional: false,
      },
      {
        text: '이지은이요.',
        optional: false,
      },
      {
        text: '네, 취소해 주세요.',
        optional: false,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '0',
      },
      {
        name: '기존 주문 상태',
        value: '이지은 주문 취소',
      },
    ],
    checks: [
      '취소하기 전에 이지은님께 보내는 택배를 취소할지 확인한다',
      '고객이 취소에 동의하기 전에 취소됐다고 말하지 않는다',
    ],
  },
  G1: {
    id: 'G1',
    name: '접수 중 FAQ 질문 후 복귀',
    group: '문의',
    core: true,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네. 받는 사람은 박서진이에요.',
        optional: false,
      },
      {
        text: '010-7777-8888이요.',
        optional: false,
      },
      {
        text: '아 근데, 제주도도 보낼 수 있어요?',
        optional: false,
      },
      {
        text: '제주시 첨단로 242요.',
        optional: false,
      },
      {
        text: '단독주택이라 없어요.',
        optional: true,
      },
      {
        text: '반찬통이요. 중형 박스 하나요.',
        optional: false,
      },
      {
        text: '3만 원이요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
      {
        text: '없어요.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '1',
      },
      {
        name: 'FAQ 답변 수',
        value: '1',
      },
      {
        name: '받는 분 이름',
        value: '박서진',
      },
      {
        name: '받는 분 번호',
        value: '010-7777-8888',
      },
      {
        name: '물품',
        value: '중형 박스 1개',
      },
      {
        name: '물품 가액',
        value: '30,000원',
      },
    ],
    checks: [
      '제주도로 보낼 수 있는지 묻는 질문에 답한다(답을 피하거나 상담원 연결로 넘기지 않는다)',
      '질문에 답한 뒤 하던 질문(받는 곳 주소)으로 돌아온다',
      '이미 받은 받는 분 성함과 연락처를 새로 말해 달라고 하지 않는다',
    ],
  },
  H9: {
    id: 'H9',
    name: '접수 중 중도 포기',
    group: '종료',
    core: false,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네. 받는 사람은 박서진이에요.',
        optional: false,
      },
      {
        text: '010-7777-8888이요.',
        optional: false,
      },
      {
        text: '아, 그냥 안 할게요. 직접 갖다줄게요.',
        optional: false,
      },
      {
        text: '네.',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '0',
      },
    ],
    checks: ['접수를 그만하고 통화를 마칠지 확인한다', '접수됐다고 말하지 않는다'],
  },
  H10: {
    id: 'H10',
    name: '무응답',
    group: '종료',
    core: true,
    caller: '등록 고객 김민수',
    lines: [
      {
        text: '네.',
        optional: true,
      },
      {
        text: '(무응답)',
        optional: false,
      },
      {
        text: '(무응답)',
        optional: true,
      },
    ],
    expected: [
      {
        name: '접수된 택배 수',
        value: '0',
      },
    ],
    checks: [],
  },
}
