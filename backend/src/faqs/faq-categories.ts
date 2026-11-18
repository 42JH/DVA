export const FAQ_CATEGORIES = [
  '접수',
  '수거 일정',
  '물품·박스',
  '포장·파손',
  '배송·운송장',
  '주소',
  '변경·취소',
  '요금·결제',
  '이용 안내',
  '기타',
] as const;

export type FaqCategory = (typeof FAQ_CATEGORIES)[number];
