const fs = require('fs');
const IP = {"home":"M3 10.5 12 3l9 7.5V21H3V10.5ZM9 21v-6h6v6","box":"M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8","phone":"M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z","inbox":"M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7l3.5-7Z","book":"M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5","users":"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8","building":"M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M9 11h1M9 15h1M14 7h1M14 11h1M14 15h1","bot":"M12 8V4H8M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4ZM9 13v2M15 13v2","chart":"M3 3v18h18M7 16v-4M12 16V8M17 16v-7","gear":"M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"};
const MAP = {"홈":"home","주문":"box","통화":"phone","미답변 문의":"inbox","FAQ":"book","고객":"users","기업":"building","AI 상담가":"bot","통계":"chart","관리자":"users","내 정보":"gear"};
const icn = (m) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${IP[MAP[m]]}"/></svg>`;
const ic = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
const menu = (a) => `<aside class="side"><div class="logo"><b style="color:#2ea3ff;font-size:18px">DVA</b><span>운영 콘솔</span></div>
<div class="grp">운영</div>${['홈', '주문', '통화', '미답변 문의'].map((m) => `<div class="mi">${icn(m)}<span>${m}</span>${m === '통화' ? '<em>2</em>' : m === '미답변 문의' ? '<em>26</em>' : ''}</div>`).join('')}
<div class="grp">관리</div>${['FAQ', '고객', '기업', 'AI 상담가', '통계'].map((m) => `<div class="mi ${m === a ? 'on' : ''}">${icn(m)}<span>${m}</span></div>`).join('')}
<div class="grp">설정</div>${['관리자', '내 정보'].map((m) => `<div class="mi">${icn(m)}<span>${m}</span></div>`).join('')}
<div class="me">김관리</div></aside>`;
const top = `<header class="top"><h1>AI 상담가</h1><div class="sp"></div><span class="live"><i></i>빠른 접수형 AI 상담가</span><span class="live2">통화 중 2건</span></header>`;
const tabs = (sel) => `<div class="tabs">${[['빠른 접수형', '통화에 사용 중'], ['친절형', ''], ['정중형', '']].map(([n, s]) => `<div class="tab ${n === sel ? 'on' : ''}">${n}${s ? '<span class="bd ok">사용 중</span>' : ''}</div>`).join('')}<button class="b line ico addp"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>상담가 등록</button></div>`;

// 실제처럼 긴 프롬프트 (예전 프롬프트의 업무 규칙이 역할에 들어감)
const P = {
  역할: (d) => `<p>택배 접수 서비스의 AI 전화 상담사입니다. 고객의 택배 접수, 수거 일정 확인, 접수 변경과 취소, 요금 안내를 돕습니다.</p>
<h4>업무 범위</h4><ul><li>접수: 보내는 분 이름, 연락처, 수거 주소, 받는 분 이름, 연락처, 배송 주소, 물품 종류, 박스 크기를 차례로 확인합니다.</li>
<li>수거 일정: 접수 번호나 보내는 분 연락처로 조회하고, 오늘 수거는 ${d ? '<del>오후 6시</del><ins>오후 7시</ins>' : '오후 6시'}까지 접수한 건만 가능하다고 안내합니다.</li>
<li>변경과 취소: 수거 기사가 출발하기 전까지만 가능합니다. 출발한 뒤에는 상담원 연결을 안내합니다.</li>
<li>요금: 박스 크기와 지역으로 안내하고, 제주와 도서 지역은 추가 요금을 함께 말합니다.</li></ul>
<h4>지켜야 할 규칙</h4><ul><li>주소는 도로명 기준으로 한 번 되풀이해 확인합니다.</li><li>고객이 개인정보 제공을 거절하면 접수를 진행하지 않고 이유를 짧게 설명합니다.</li>
<li>파손과 분실 보상 문의는 직접 판단하지 않고 담당 부서로 연결합니다.</li><li>FAQ에 없는 질문은 추측하지 않고 상담원 연결을 제안합니다.</li></ul>`,
  성격: () => `<p>친절하고 차분합니다. 고객이 급하거나 화가 나 있어도 같은 속도와 말투를 유지합니다. 고객의 말을 끊지 않고 끝까지 듣습니다.</p>`,
  '발화 톤': () => `<ul><li>존댓말로, 한 번에 한 가지만 묻습니다.</li><li>문장은 짧고 분명하게 말합니다.</li><li>전문 용어 대신 고객이 쓰는 말로 바꿔 말합니다.</li></ul>`,
  '발화 속도': (d) => `<p>${d ? '<del>보통 속도로</del><ins>조금 빠르게,</ins>' : '보통 속도로'} 또박또박 말합니다. 주소와 전화번호는 한 글자씩 천천히 되풀이합니다.</p>`,
  맞장구: (d) => `<p>고객이 길게 설명할 때 "네", "${d ? '<del>알겠습니다</del><ins>확인했습니다</ins>' : '알겠습니다'}"처럼 짧게만 반응합니다.</p>`,
  끼어들기: () => `<p>고객이 말을 시작하면 바로 멈추고 듣습니다. 고객이 "잠깐만요"라고 하면 기다린다고 말한 뒤 조용히 기다립니다.</p>`,
};
const keys = Object.keys(P);
const NAV = ['전체', ...keys];
const doc = (d, changed = [], editing = false) => `<div class="doc"><nav>${NAV.map((k, i) => `<a class="${i === 0 ? 'on' : ''}">${k}${changed.includes(k) ? '<span class="bd rt">바뀜</span>' : ''}</a>`).join('')}</nav>
<div class="body">${editing && '역할' === '역할' ? `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b plain">취소</button><button class="b line">저장</button></div><div class="in ta big">${roleEdit}</div></section>` : `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b edit">수정</button></div>${P['역할'](d)}</section>`}${editing && '성격' === '역할' ? `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b plain">취소</button><button class="b line">저장</button></div><div class="in ta big">${roleEdit}</div></section>` : `<section><div class="sh"><h3>성격</h3><div class="sp"></div><button class="b edit">수정</button></div>${P['성격'](d)}</section>`}${editing && '발화 톤' === '역할' ? `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b plain">취소</button><button class="b line">저장</button></div><div class="in ta big">${roleEdit}</div></section>` : `<section><div class="sh"><h3>발화 톤</h3><div class="sp"></div><button class="b edit">수정</button></div>${P['발화 톤'](d)}</section>`}${editing && '발화 속도' === '역할' ? `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b plain">취소</button><button class="b line">저장</button></div><div class="in ta big">${roleEdit}</div></section>` : `<section><div class="sh"><h3>발화 속도</h3><div class="sp"></div><button class="b edit">수정</button></div>${P['발화 속도'](d)}</section>`}${editing && '맞장구' === '역할' ? `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b plain">취소</button><button class="b line">저장</button></div><div class="in ta big">${roleEdit}</div></section>` : `<section><div class="sh"><h3>맞장구</h3><div class="sp"></div><button class="b edit">수정</button></div>${P['맞장구'](d)}</section>`}${editing && '끼어들기' === '역할' ? `<section><div class="sh"><h3>역할</h3><div class="sp"></div><button class="b plain">취소</button><button class="b line">저장</button></div><div class="in ta big">${roleEdit}</div></section>` : `<section><div class="sh"><h3>끼어들기</h3><div class="sp"></div><button class="b edit">수정</button></div>${P['끼어들기'](d)}</section>`}</div></div>`;
const roleEdit = '택배 접수 서비스의 AI 전화 상담사입니다. 고객의 택배 접수, 수거 일정 확인, 접수 변경과 취소, 요금 안내를 돕습니다.<br><br>업무 범위<br>- 접수: 보내는 분 이름, 연락처, 수거 주소, 받는 분 이름, 연락처, 배송 주소, 물품 종류, 박스 크기를 차례로 확인합니다.<br>- 수거 일정: 접수 번호나 보내는 분 연락처로 조회하고, 오늘 수거는 오후 7시까지 접수한 건만 가능하다고 안내합니다.|<br>- 변경과 취소: 수거 기사가 출발하기 전까지만 가능합니다. 출발한 뒤에는 상담원 연결을 안내합니다.<br>- 요금: 박스 크기와 지역으로 안내하고, 제주와 도서 지역은 추가 요금을 함께 말합니다.<br><br>지켜야 할 규칙<br>- 주소는 도로명 기준으로 한 번 되풀이해 확인합니다.<br>- 고객이 개인정보 제공을 거절하면 접수를 진행하지 않고 이유를 짧게 설명합니다.<br>- 파손과 분실 보상 문의는 직접 판단하지 않고 담당 부서로 연결합니다.<br>- FAQ에 없는 질문은 추측하지 않고 상담원 연결을 제안합니다.';
const head = (name, live, btns) => `<div class="ch"><div><div class="nm">${name}${live ? '<span class="bd ok">통화에 사용 중</span>' : ''}</div><div class="vo"><span>기본 음성</span><span>10월 29일 오전 10:00 저장</span><a class="tl">수정 기록 보기</a></div></div><div class="sp"></div>${btns}</div>`;
const band = `<div class="band"><span class="bd wait">반영 전</span><b>고친 내용</b><span class="dim">11월 12일 오후 3:20 저장</span><span class="dim">김관리</span><div class="sp"></div><button class="b line">통화에 반영</button></div>
<div class="seg"><div class="sg"><span class="on">고친 내용</span><span>통화에 쓰는 내용</span></div></div>`;
const scr = (name, sel, body, extra = '') => `<div class="screen" data-name="${name}">${menu('AI 상담가')}<main>${top}<section class="ct">${tabs(sel)}${body}</section></main>${extra}</div>`;
const liveBtns = (draft) => (draft ? '' : '<button class="b plain">시나리오 시험</button>');
const cardA = `<div class="card">${head('빠른 접수형', true, liveBtns(false))}${doc(false)}</div>`;
const cardB = `<div class="card">${head('빠른 접수형', true, liveBtns(true))}${band}${doc(true, ['역할', '발화 속도', '맞장구'])}</div>`;
const cardD = `<div class="card">${head('친절형', false, '<button class="b danger">삭제</button><button class="b plain">시나리오 시험</button><button class="b line">통화에 사용하기</button>')}${doc(false)}</div>`;
const cardE = `<div class="card">${head('빠른 접수형', true, liveBtns(false))}${doc(false, [], true)}</div>`;
const hist = [['11월 12일 오후 3:20', '김관리', '반영 전', 0], ['10월 29일 오전 10:00', '김관리', '통화에 사용 중', 0], ['10월 21일 오후 2:05', '이운영', '', 1], ['10월 14일 오전 11:40', '김관리', '', 0], ['10월 2일 오후 4:12', '김관리', '', 0]];
const modal = `<div class="dim-bg"><div class="modal"><div class="mh"><h2>수정 기록</h2><span class="x">✕</span></div><div class="mb">
<ul class="list">${hist.map(([d, w, t, on]) => `<li class="${on ? 'on' : ''}"><b>${d}</b><span>${w}</span>${t ? `<span class="bd ${t === '반영 전' ? 'wait' : 'ok'}">${t}</span>` : ''}</li>`).join('')}</ul>
<div class="pv"><div class="pvh">10월 21일 오후 2:05 내용<span class="dim">통화에 쓰는 내용과 다른 항목 2개</span></div>
<section><h3>성격</h3><p><del>친절하고 차분합니다.</del><ins>밝고 친근합니다.</ins> 고객이 급하거나 화가 나 있어도 같은 속도와 말투를 유지합니다.</p></section>
<section><h3>역할</h3><ul><li>수거 일정: 오늘 수거는 <del>오후 6시</del><ins>오후 5시</ins>까지 접수한 건만 가능하다고 안내합니다.</li></ul></section></div></div>
<div class="mf"><button class="b plain">취소</button><button class="b solid">이 내용 불러오기</button></div></div></div>`;
let css = `.sh{display:flex;align-items:center;gap:8px;margin-bottom:10px}.sh h3{margin:0}.in.big{min-height:420px;font-size:15px;line-height:1.7;border-color:#8fb6f5;box-shadow:0 0 0 2px #eaf2fe}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Pretendard',sans-serif;color:#1d2433;background:#ddd}
.screen{width:1440px;height:900px;display:flex;background:#f5f6f8;position:relative;overflow:hidden;margin-bottom:40px}
.side{width:208px;background:#fff;border-right:1px solid #e3e6eb;padding:16px 12px;position:relative}.logo{display:flex;gap:10px;align-items:center;padding:4px 8px 20px;font-size:14px}
.grp{font-size:12px;color:#636d7f;padding:14px 8px 8px}.mi{display:flex;align-items:center;gap:10px;height:38px;padding:0 8px;border-radius:8px;font-size:15px;color:#2b2f36}.mi span{flex:1}.mi em{font-style:normal;font-size:13px;color:#5b6475}
.mi.on{background:#eaf2fe;color:#1a62d6;font-weight:600}.me{position:absolute;bottom:0;left:0;right:0;border-top:1px solid #e3e6eb;padding:18px 20px;font-size:14px}
main{flex:1;display:flex;flex-direction:column;min-width:0}.top{height:56px;flex:none;background:#fff;border-bottom:1px solid #e3e6eb;display:flex;align-items:center;gap:16px;padding:0 24px}.top h1{font-size:20px;font-weight:700}
.sp{flex:1}.live{font-size:13px;color:#5b6475;display:flex;align-items:center;gap:6px}.live i{width:8px;height:8px;border-radius:4px;background:#107a50}.live2{font-size:13px;font-weight:600}
.b{height:32px;padding:0 12px;border-radius:6px;font:600 13px 'Pretendard';border:1px solid transparent;white-space:nowrap}.ico{display:inline-flex;align-items:center;gap:6px}.solid{background:#1a62d6;color:#fff}.line{background:#fff;color:#1a62d6;border-color:#8fb6f5}.plain{background:#fff;color:#1d2433;border-color:#c5ccd6}.edit{background:#fff;color:#9a5c00;border-color:#e3b56b}.danger{background:#fff;color:#c73434;border-color:#ec9c9c}
.ct{flex:1;min-height:0;padding:16px 24px 24px;display:flex;flex-direction:column;gap:16px}.tabs{display:flex;gap:4px;flex:none;align-items:center}.tabs{position:relative}.addp{position:absolute;right:28px;top:0}
.tab{height:32px;padding:0 12px;border-radius:6px;display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#5b6475}.tab.on{background:#fff;color:#1d2433;box-shadow:0 0 0 1px #e3e6eb}
.card{flex:1;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #e3e6eb;border-radius:12px;overflow:hidden}.ch{flex:none;display:flex;align-items:center;gap:8px;padding:20px 28px;border-bottom:1px solid #e3e6eb}
.nm{font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px}.vo{font-size:15px;color:#5b6475;margin-top:6px;display:flex;gap:14px;align-items:center}.tl{color:#5b6475;text-decoration:underline;text-underline-offset:3px;font-size:14px}
.bd{display:inline-flex;align-items:center;height:22px;font-size:12px;font-weight:500;padding:0 6px;border-radius:4px;white-space:nowrap}.rt{background:#eaf2fe;color:#1a62d6}.ok{background:#e7f6ef;color:#107a50}.wait{background:#fff4e0;color:#9a5c00}
.band{flex:none;display:flex;align-items:center;gap:12px;padding:12px 28px;background:#fff9ef;border-bottom:1px solid #f3e2c2;font-size:16px}.dim{color:#636d7f;font-size:14px;font-weight:400}
.seg{flex:none;display:flex;gap:4px;padding:12px 28px;border-bottom:1px solid #e3e6eb}.sg>span,.tab{position:relative}.sg>span+span::before,.tab+.tab::before{content:'';position:absolute;left:-3px;top:9px;bottom:9px;width:1px;background:#c5ccd6}.sg>span.on::before,.sg>span.on+span::before,.tab.on::before,.tab.on+.tab::before{display:none}.sg{display:flex;gap:4px;background:#eef0f3;padding:4px;border-radius:8px}.sg>span{height:32px;padding:0 12px;border-radius:6px;display:flex;align-items:center;font-size:13px;font-weight:600;color:#5b6475}.seg .on{background:#fff;color:#1d2433;box-shadow:0 0 0 1px #e3e6eb}
.doc{flex:1;min-height:0;display:flex}.doc nav{width:180px;flex:none;border-right:1px solid #e3e6eb;padding:16px 12px;display:flex;flex-direction:column;gap:2px}
.doc nav{background:#f5f6f8}.doc nav a{display:flex;align-items:center;justify-content:space-between;height:36px;padding:0 12px;border-radius:6px;font-size:14px;font-weight:600;color:#5b6475}.doc nav a.on{background:#fff;color:#1d2433;box-shadow:0 0 0 1px #e3e6eb}
.body{flex:1;min-width:0;overflow:hidden;padding:8px 40px 0 32px;position:relative}.thumb{position:absolute;right:6px;top:8px;width:6px;height:46%;border-radius:3px;background:#c9ced6}
section.one{border-bottom:0}section{padding:20px 0;border-bottom:1px solid #eef0f3}section h3{font-size:17px;font-weight:700;margin-bottom:10px}section h4{font-size:15px;font-weight:700;color:#5b6475;margin:14px 0 6px}
section p,section li{font-size:16px;line-height:1.7}section ul{padding-left:20px}
del{color:#8a95a2}ins{text-decoration:none;background:#eaf2fe;color:#1a62d6;font-weight:600;padding:0 3px;border-radius:3px;margin-left:4px}
.dim-bg{position:absolute;inset:0;background:rgba(29,36,51,.45);display:flex;align-items:center;justify-content:center}
.modal{width:1000px;background:#fff;border-radius:14px;overflow:hidden}.mh{display:flex;align-items:center;padding:20px 28px;border-bottom:1px solid #e3e6eb}.mh h2{font-size:20px;flex:1}.x{color:#636d7f}
.mb{display:flex;height:540px}.list{list-style:none;width:300px;flex:none;border-right:1px solid #e3e6eb;padding:8px}.list li{padding:14px 16px;border-radius:8px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}.list li b{width:100%;font-size:16px}.list li span{font-size:14px;color:#636d7f}.list li .ok{color:#107a50}.list li .wait{color:#9a5c00}.list li.on{background:#eaf2fe}.list li.on b{color:#1a62d6}
.pv{flex:1;overflow:hidden;padding:0 32px}.pvh{padding:20px 0 4px;font-size:17px;font-weight:700;display:flex;gap:12px;align-items:baseline}
.mf{display:flex;justify-content:flex-end;gap:8px;padding:16px 28px;border-top:1px solid #e3e6eb}`;

const field = (label, val, tall) => `<div class="fd"><label>${label}</label><div class="in ${tall ? 'ta' : ''} ${val ? '' : 'ph'}">${val || (tall ? '내용을 입력하세요' : '예: 꼼꼼 확인형')}</div></div>`;
const form = (title, sub, vals, footL, ok) => `<div class="card form"><div class="fh"><b>${title}</b><span class="dim">${sub}</span></div><div class="fb">
${field('이름', vals ? vals.name : '')}<div class="fd"><label>목소리</label><div class="in sel">${vals ? '기본 음성' : '기본 음성'}<span class=\"chev\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:block\"><path d=\"m6 9 6 6 6-6\"/></svg></span></div></div>
${field('역할', vals ? vals.role : '', 1)}${field('성격', vals ? vals.pers : '', 1)}${field('발화 톤', vals ? vals.tone : '', 1)}</div>
<div class="ff">${footL || ''}<div class="sp"></div><button class="b plain">취소</button><button class="b solid">${ok}</button></div></div>`;
const roleTxt = '택배 접수 서비스의 AI 전화 상담사입니다. 고객의 택배 접수, 수거 일정 확인, 접수 변경과 취소, 요금 안내를 돕습니다.<br><br>업무 범위<br>- 접수: 보내는 분 이름, 연락처, 수거 주소, 받는 분 이름, 연락처, 배송 주소, 물품 종류, 박스 크기를 차례로 확인합니다.<br>- 수거 일정: 접수 번호나 보내는 분 연락처로 조회하고, 오늘 수거는 오후 6시까지 접수한 건만 가능하다고 안내합니다.<br>- 변경과 취소: 수거 기사가 출발하기 전까지만 가능합니다.';
const vA = { name: '빠른 접수형', role: roleTxt, pers: '친절하고 차분합니다. 고객이 급하거나 화가 나 있어도 같은 속도와 말투를 유지합니다.', tone: '존댓말로, 한 번에 한 가지만 묻습니다.' };
const vD = { ...vA, name: '친절형', pers: '다정하고 여유 있습니다.', tone: '존댓말, 부드럽게.' };
const formE = form('빠른 접수형 수정', '', vA, '', '저장');
const formE2 = form('친절형 수정', '', vD, '<button class="b danger">상담가 삭제</button>', '저장');
const formF = form('새 상담가', '', null, '', '등록');
const dlg = (t, body, okCls, ok) => `<div class="dim-bg"><div class="dlg"><h2>${t}</h2><p>${body}</p><div class="df"><button class="b plain">취소</button><button class="b ${okCls}">${ok}</button></div></div></div>`;
const bandI = '<div class="band"><span class="bd wait">반영 중</span><b>고친 내용</b><span class="dim">11월 12일 오후 3:20 저장</span><span class="dim">AI 확인이 끝나면 통화에 들어갑니다</span></div>';
const cardI = `<div class="card">${head('빠른 접수형', true, liveBtns(true))}${bandI}${doc(true, ['역할', '발화 속도', '맞장구'])}</div>`;
css += `.form .fh{flex:none;display:flex;gap:12px;align-items:baseline;padding:16px 28px;border-bottom:1px solid #e3e6eb;font-size:16px}.fb{flex:1;min-height:0;overflow:hidden;padding:20px 28px;display:flex;flex-direction:column;gap:20px}
.fd label{display:block;font-size:15px;font-weight:700;margin-bottom:8px}.in{border:1px solid #c5ccd6;border-radius:6px;padding:9px 12px;font-size:15px;line-height:1.6;max-width:720px}.in.ta{max-width:none}.in.ph{color:#8a95a2}.in.sel{display:flex;justify-content:space-between;align-items:center;width:320px}
.ff{flex:none;display:flex;align-items:center;gap:8px;padding:12px 28px;border-top:1px solid #e3e6eb}.danger.solid2{background:#c73434;color:#fff;border-color:#c73434}
.dlg{width:440px;background:#fff;border-radius:12px;padding:28px}.dlg h2{font-size:18px;margin-bottom:10px}.dlg p{font-size:14px;color:#5b6475;line-height:1.6}.df{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}`;

const bandK = '<div class="band"><span class="bd wait">시험 중</span><b>통화에 반영하기 전 시험</b><span class="dim">시나리오 4 / 10</span><div class="bar"><i style="width:40%"></i></div><span class="dim">통과 3</span><span class="dim stop">실패 1</span><div class="sp"></div><button class="b plain">진행 보기</button><button class="b danger">시험 중단</button></div>';
const bandM = '<div class="band"><span class="bd wait">확인 필요</span><b>시나리오 2개 실패</b><span class="dim">11월 13일 오후 4:10 시험</span><div class="sp"></div><button class="b plain">실패한 시나리오 보기</button><button class="b line">확인하고 반영</button></div><div class="seg"><div class="sg"><span class="on">고친 내용</span><span>통화에 쓰는 내용</span></div></div>';
const cardK = `<div class="card">${head('빠른 접수형', true, '')}${bandK}${doc(true, ['역할', '발화 속도', '맞장구']).replace('<button class="b edit">수정</button>', '<button class="b plain" style="opacity:.4">수정</button>')}</div>`;
const cardM = `<div class="card">${head('빠른 접수형', true, liveBtns(true))}${bandM}${doc(true, ['역할', '발화 속도', '맞장구'])}</div>`;
css += '.bar{width:160px;height:6px;border-radius:3px;background:#eef0f3;overflow:hidden}.bar i{display:block;height:100%;background:#9a5c00}.stop{color:#c73434}.band.bad{background:#fdf3f3;border-bottom-color:#f3cccc}.stopb{background:#fdecec;color:#c73434}';

const top2 = (title, sub) => `<header class="top"><span class="back">‹</span><h1>${title}</h1><span class="dim">${sub}</span><div class="sp"></div><span class="live"><i></i>빠른 접수형 AI 상담가</span><span class="live2">통화 중 2건</span></header>`;
const scr2 = (name, title, sub, body, extra = '') => `<div class="screen" data-name="${name}">${menu('AI 상담가')}<main>${top2(title, sub)}<section class="ct">${body}</section></main>${extra}</div>`;
const BD = { 통과: 'ok', 실패: 'stopb', '연결 실패': 'idle', '시험 중': 'wait', 대기: 'idle', '새로 실패': 'stopb', '새로 통과': 'ok' };
const bd = (t) => t === '-' || t === '같음' ? `<span class="dim">${t}</span>` : `<span class="bd ${BD[t]}">${t}</span>`;
const SC = [['접수','신규 고객 기본 접수'],['','등록 고객, 주소록 1건 매칭'],['','등록 고객, 주소록에 없는 새 받는 분'],['정보 수집','한 번에 여러 정보 말하기'],['','앞 항목 정정'],['조회','1건 조회'],['취소','취소 가능한 택배 취소'],['문의','접수 중 FAQ 질문 후 복귀'],['종료','접수 중 중도 포기'],['','무응답']];
const LIVE = ['통과','통과','실패','통과','통과','통과','실패','통과','통과','통과'];
const NEW = ['통과','통과','통과','연결 실패','실패','통과','실패','통과','통과','통과'];
const CHG = ['같음','같음','새로 통과','-','새로 실패','같음','같음','같음','같음','같음'];
const RUN = ['통과','통과','통과','시험 중','시험 중','대기','대기','대기','대기','대기'];
const table = (col4, chg) => `<table class="tb"><thead><tr><th>업무</th><th class="l">시나리오</th><th>통화에 쓰는 내용 <span>10월 1일</span></th><th>고친 내용 <span>11월 12일</span></th><th>변화</th></tr></thead><tbody>${SC.map(([g, n], i) => `<tr><td class="g">${g}</td><td class="l">${n}</td><td>${bd(LIVE[i])}</td><td>${bd(col4[i])}</td><td>${chg ? bd(chg[i]) : '<span class="dim">-</span>'}</td></tr>`).join('')}</tbody></table>`;
const stat = (k, v, c) => `<div class="st"><span>${k}</span><b class="${c || ''}">${v}</b></div>`;
const p5 = `<div class="lh">${stat('전체', 10)}${stat('통과', 7, 'okc')}<div class="st"><span>실패</span><b class="stop">2</b></div>${stat('연결 실패', 1)}<div class="sp"></div><button class="b plain">남은 1개 시험</button><button class="b line">전체 10개 시험</button></div><div class="box">${table(NEW, CHG)}</div>`;
const p5b = `<div class="lh"><div class="st"><span>진행</span><b>4 / 10</b></div><div class="bar big"><i style="width:40%"></i></div><span class="dim">통과 3</span><span class="dim stop">실패 0</span><div class="sp"></div><button class="b danger">시험 중단</button></div><div class="box">${table(RUN, null)}</div>`;
const TR = [['AI 상담가','안녕하세요, 김민수님. 서울 강남구 테헤란로 이백십이에서 발송하시는 택배 접수 도와드릴까요?','00:08'],['고객','아니요.','00:11'],['AI 상담가','무엇을 도와드릴까요?','00:17'],['고객','보낸 택배 확인하려고요.','00:19'],['AI 상담가','확인해 볼게요.','00:27'],['AI 상담가','조회할 택배를 받는 분 성함으로 말씀해 주세요. 지금 전화하신 번호로 접수된 택배만 확인할 수 있어요.','00:42'],['고객','이지은이요.','00:44'],['AI 상담가','네, 잠시만요.','00:50'],['AI 상담가','이지은님 택배는 접수 미완료 상태로 아직 최종 접수 전입니다. 다른 내용도 확인해 드릴까요?','01:02'],['고객','없어요.','01:04'],['AI 상담가','알겠습니다. 이용해 주셔서 감사합니다. 좋은 하루 보내세요.','01:21']];
const RS = [['고객 대본 완료','모든 대사 진행','모든 대사 진행','통과'],['접수된 택배 수','0','0','통과'],['접수 확인된 초안 수','0','1','실패'],['조회 실행','1회 이상','2회','통과'],['기존 주문 상태','이지은 미완료, 박서준 결제 완료','이지은 미완료, 박서준 결제 완료','통과']];
const p7 = `<div class="card"><div class="seg"><div class="sg"><span class="on">고친 내용 <em>11월 12일</em> <span class="bd stopb">실패</span></span><span>통화에 쓰는 내용 <em>10월 1일</em> <span class="bd ok">통과</span></span><span>시나리오</span></div><div class="sp"></div><span class="dim">오늘 오후 1:41 시험, 통화 1분 28초</span></div>
<div class="dt"><div class="tr">${TR.map(([w, t, ts], i) => `<div class="ln ${i === 4 ? 'on' : ''}"><b class="${w === '고객' ? 'cu' : 'ai'}">${w}</b><p>${t}</p><span>${ts}</span></div>`).join('')}</div>
<div class="rs"><div class="rh"><b>결과표</b><span class="dim">통과 4, 실패 1</span></div><table class="tb sm"><thead><tr><th class="l">항목</th><th class="l">정답</th><th class="l">통화 결과</th><th>판정</th></tr></thead><tbody>${RS.map(([a, b, c, d]) => `<tr><td class="l">${a}</td><td class="l">${b}</td><td class="l">${c}</td><td>${bd(d)}</td></tr>`).join('')}</tbody></table></div></div>
<div class="pl"><span class="pb">▶</span><span class="dim">00:27</span><div class="bar wide"><i style="width:30%"></i></div><span class="dim">01:32</span></div></div>`;
css += `.back{font-size:26px;color:#5b6475;margin-right:-4px}.top .dim{margin-left:4px}
.st{display:flex;flex-direction:column;gap:2px;margin-right:28px}.st span{font-size:13px;color:#5b6475;font-weight:500}.st b{font-size:24px;font-weight:700}.okc{color:#107a50}.st small{font-size:13px;font-weight:600;margin-left:8px;color:#c73434}
.bar.big{width:280px;height:8px;border-radius:4px;margin-right:12px}.bar.big i{background:#1a62d6}.bar.wide{flex:1;height:6px}.bar.wide i{background:#1a62d6}
.idle{background:#eef0f3;color:#5b6475}
.tb{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14px;color:#333}.tb thead{background:#e8eff8}.tb th{height:36px;padding:0;color:#000;font-size:14px;font-weight:600;white-space:nowrap;border-bottom:1px solid #c5d6ec;text-align:center}.tb th span{font-weight:400;color:#636d7f;margin-left:4px}
.tb td{height:44px;padding:0 15px;border-bottom:1px dashed #c5d6ec;text-align:center}.tb tr>:not(:last-child){border-right:1px solid #c5d6ec}.tb tbody tr:nth-child(even){background:#f7fafe}.tb .l{text-align:left;padding-left:15px}.tb:not(.sm) th:nth-child(1){width:120px}.tb:not(.sm) th:nth-child(3),.tb:not(.sm) th:nth-child(4){width:220px}.tb:not(.sm) th:nth-child(5){width:140px}.tb.sm th:nth-child(4){width:72px}.tb .g{color:#5b6475;width:120px}
.tb.sm td{height:auto;padding:10px 12px;vertical-align:top}.box{flex:1;min-height:0;background:#fff;border:1px solid #e3e6eb;border-radius:8px;overflow:hidden}.lh{display:flex;align-items:center;gap:8px;flex:none}
.seg em{font-style:normal;font-weight:400;color:#636d7f;margin:0 4px}.sg>span{gap:4px}.seg{align-items:center}
.dt{flex:1;min-height:0;display:flex}.tr{flex:1;min-width:0;padding:8px 16px;border-right:1px solid #e3e6eb;overflow:hidden}.ln{display:flex;gap:16px;padding:10px 12px;border-radius:6px;font-size:14px;line-height:1.6}.ln.on{background:#f5f6f8}
.ln b{width:72px;flex:none;font-size:13px}.ln b.ai{color:#1a62d6}.ln b.cu{color:#5b6475}.ln p{flex:1}.ln span{color:#8a95a2;font-size:12px}
.rs{width:470px;flex:none;padding:16px}.rh{display:flex;gap:10px;align-items:baseline;margin-bottom:10px}.rh b{font-size:16px}
.pl{flex:none;display:flex;align-items:center;gap:14px;padding:12px 24px;border-top:1px solid #e3e6eb}.pb{width:32px;height:32px;border-radius:16px;background:#1a62d6;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px}`;

const lock = (html) => html.replace('<a class="tl">수정 기록 보기</a>', '<a class="tl off">수정 기록 보기</a>').replace('<button class="b edit">수정</button>', '<button class="b plain off">수정</button>');
const bandO = '<div class="band"><span class="bd idle">시험 중단</span><b>시나리오 4 / 10에서 멈춤</b><span class="dim">11월 13일 오후 4:05</span><span class="dim">김관리</span><div class="sp"></div><button class="b plain">지금까지 결과 보기</button><button class="b line">다시 시험하고 반영</button></div><div class="seg"><div class="sg"><span class="on">고친 내용</span><span>통화에 쓰는 내용</span></div></div>';
const cardO = `<div class="card">${head('빠른 접수형', true, liveBtns(true))}${bandO}${doc(true, ['역할', '발화 속도', '맞장구'])}</div>`;
css += '.tl.off,.b.off{opacity:.4}.tl.off{text-decoration:none}';

const bandK2 = '<div class="band"><span class="bd wait">시험 중</span><b>통화에 쓰기 전 시험</b><span class="dim">시나리오 4 / 10</span><div class="bar"><i style="width:40%"></i></div><span class="dim">통과 4</span><span class="dim stop">실패 0</span><div class="sp"></div><button class="b plain">진행 보기</button><button class="b danger">시험 중단</button></div>';
const bandQ = '<div class="band ok2"><span class="bd ok">시험 통과</span><b>시나리오 10개 모두 통과</b><span class="dim">11월 13일 오후 4:30 시험</span><div class="sp"></div><button class="b plain">결과 보기</button><button class="b line">통화에 사용하기</button></div>';
const bandI2 = '<div class="band"><span class="bd wait">반영 중</span><b>통화에 들어가는 중</b><span class="dim">AI 확인이 끝나면 다음 통화부터 친절형이 응대합니다</span></div>';
const cardK2 = lock(`<div class="card">${head('친절형', false, '')}${bandK2}${doc(false)}</div>`);
const cardQ = `<div class="card">${head('친절형', false, '<button class="b danger">삭제</button><button class="b plain">시나리오 시험</button>')}${bandQ}${doc(false)}</div>`;
const cardI2 = lock(`<div class="card">${head('친절형', false, '')}${bandI2}${doc(false)}</div>`);
css += '.band.ok2{background:#f1faf5;border-bottom-color:#cde9da}';

const full = (dd, changed) => `<div class="v3"><div class="fdoc">${keys.map((k) => `<section><div class="sh"><h3>${k}</h3>${changed.includes(k) ? '<span class="bd rt">바뀜</span>' : ''}</div>${P[k](dd)}</section>`).join('')}</div>
</div>`;
const headV = `<div class="ch"><div><div class="nm">빠른 접수형<span class="bd ok">통화에 사용 중</span></div><div class="vo"><span>기본 음성</span><span>10월 29일 오전 10:00 저장</span><a class="tl">수정 기록 보기</a></div></div><div class="sp"></div><button class="b edit">수정</button></div>`;
const headV2 = `<div class="ch"><div><div class="nm">빠른 접수형 수정</div></div><div class="sp"></div><button class="b plain">취소</button><button class="b solid">저장</button></div>`;
const ED = { 역할: roleEdit, 성격: '친절하고 차분합니다. 고객이 급하거나 화가 나 있어도 같은 속도와 말투를 유지합니다. 고객의 말을 끊지 않고 끝까지 듣습니다.', '발화 톤': '- 존댓말로, 한 번에 한 가지만 묻습니다.<br>- 문장은 짧고 분명하게 말합니다.<br>- 전문 용어 대신 고객이 쓰는 말로 바꿔 말합니다.', '발화 속도': '조금 빠르게, 또박또박 말합니다. 주소와 전화번호는 한 글자씩 천천히 되풀이합니다.', 맞장구: '고객이 길게 설명할 때 "네", "확인했습니다"처럼 짧게만 반응합니다.', 끼어들기: '고객이 말을 시작하면 바로 멈추고 듣습니다. 고객이 "잠깐만요"라고 하면 기다린다고 말한 뒤 조용히 기다립니다.' };
const fullEdit = `<div class="v3"><div class="fdoc"><section><h3>기본 정보</h3><div class="row2"><div class="fd"><label>이름</label><div class="in">빠른 접수형</div></div><div class="fd"><label>목소리</label><div class="in sel">기본 음성<span class=\"chev\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:block\"><path d=\"m6 9 6 6 6-6\"/></svg></span></div></div></div></section>${keys.map((k) => `<section><h3>${k}</h3><div class="in ta ed">${ED[k]}</div></section>`).join('')}</div></div>`;
const cardV2 = `<div class="card">${headV2}${fullEdit}</div>`;
const bandV = '<div class="band"><span class="bd wait">반영 전</span><b>고친 내용</b><span class="dim">11월 12일 오후 3:20 저장</span><span class="dim">김관리</span><div class="sp"></div><div class="sg"><span class="on">고친 내용</span><span>통화에 쓰는 내용</span></div><button class="b line">통화에 반영</button></div>';
const cardV = `<div class="card">${headV}${bandV}${full(true, ['역할', '발화 속도', '맞장구'])}</div>`;
css += '.screen.tall{height:auto;min-height:900px}.tall .ct,.tall .card,.tall .v3{flex:none;min-height:auto}.tall .fdoc{overflow:visible}.tall .fdoc section p,.tall .fdoc section li{font-size:15px;line-height:1.65}.tall .toc,.tall .hist{align-self:stretch}.row2{display:flex;gap:16px}.row2 .fd{flex:1}.row2 .fd label{font-size:13px;color:#5b6475;font-weight:600}.fdoc .in.ed{margin-top:8px;font-size:15px;line-height:1.65}.fdoc h3{font-size:17px;font-weight:700}.v3{flex:1;min-height:0;display:flex}.toc{width:150px;flex:none;border-right:1px solid #e3e6eb;padding:16px 10px;display:flex;flex-direction:column;gap:2px;background:#f5f6f8}.toc a{display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 10px;border-radius:6px;font-size:14px;font-weight:600;color:#5b6475}.toc a.on{background:#fff;color:#1d2433;box-shadow:0 0 0 1px #e3e6eb}'
 + '.fdoc{flex:1;min-width:0;overflow:hidden;padding:0 32px;position:relative}.fdoc section{padding:18px 0}.fdoc .sh{margin-bottom:8px}.fdoc .sh .bd{margin-left:8px}'
 + '.hist{width:300px;flex:none;border-left:1px solid #e3e6eb;padding:12px 10px;display:flex;flex-direction:column;gap:2px}.hh{display:flex;gap:8px;align-items:baseline;padding:4px 8px 10px}.hh b{font-size:16px}'
 + '.hr{padding:12px;border-radius:8px;display:flex;flex-direction:column;gap:6px}.hr.on{background:#eaf2fe}.h1{display:flex;align-items:center;gap:8px}.h1 b{font-size:14px}.hr.on .h1 b{color:#1a62d6}.h2{display:flex;justify-content:space-between;font-size:13px;color:#636d7f}.band .sg{margin-right:4px}.sg>.on{background:#fff;color:#1d2433;box-shadow:0 0 0 1px #e3e6eb}';

const CHW = ['역할', '발화 속도', '맞장구'];
const fullW = `<div class="v3"><div class="fdoc"><section><div class="row2"><div class="fd"><label>이름</label><div class="in">빠른 접수형</div></div><div class="fd"><label>목소리</label><div class="in sel">기본 음성<span class=\"chev\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:block\"><path d=\"m6 9 6 6 6-6\"/></svg></span></div></div></div></section><section class="one"><div class="sh"><h3>프롬프트</h3></div><div class="pbox"><div class="ph">역할</div><div class="pc cur">${ED['역할']}</div><div class="ph">성격</div><div class="pc">${ED['성격']}</div><div class="ph">발화 톤</div><div class="pc">${ED['발화 톤']}</div><div class="ph">발화 속도</div><div class="pc">${ED['발화 속도']}</div><div class="ph">맞장구</div><div class="pc">${ED['맞장구']}</div><div class="ph">끼어들기</div><div class="pc">${ED['끼어들기']}</div></div></section></div></div>`;
const headW = `<div class="ch"><div><div class="nm">빠른 접수형<span class="bd ok">통화에 사용 중</span></div><div class="vo"><span>10월 29일 오전 10:00 저장</span><a class="tl">수정 기록 보기</a></div></div><div class="sp"></div><button class="b plain">취소</button><button class="b solid">저장</button></div>`;
const bandW = '<div class="band"><span class="bd wait">반영 전</span><b>고친 내용</b><span class="dim">11월 12일 오후 3:20 저장</span><span class="dim">김관리</span><div class="sp"></div><div class="sg"><span class="on">고친 내용</span><span>통화에 쓰는 내용</span></div><button class="b line off">통화에 반영</button></div>';
const cardW = `<div class="card">${headW}${bandW}${fullW}</div>`;
css += '.big1{white-space:normal}.pbox{margin-top:8px;border:1px solid #c5ccd6;border-radius:6px;overflow:hidden}.ph{background:#f5f6f8;color:#5b6475;font-size:14px;font-weight:700;padding:6px 12px;border-top:1px solid #e3e6eb;border-bottom:1px solid #e3e6eb;user-select:none}.ph:first-child{border-top:0}.pc{padding:10px 12px;font-size:15px;line-height:1.65}.fdoc section.one{border-bottom:0}.in.focus{border-color:#1a62d6;box-shadow:0 0 0 3px #eaf2fe}.fdoc .sh .bd+.bd{margin-left:4px}';

const HD = [['역할', '역할'], ['성격', '성격'], ['발화 톤', '발화 톤'], ['발화 속도', '발화 속도'], ['맞장구', '맞장구'], ['끼어들기', '끼어들기']];
const ED2 = { ...ED, 역할: ED['역할'].split('## ').join('').replace('|', '') };
const FORM = (name, o = {}) => `<div class="v3"><div class="fdoc ${o.locked ? 'locked' : ''}">${name ? '' : '<section><div class="row2"><div class="fd"><label>이름</label><div class="in ph">예: 꼼꼼 확인형</div></div><div class="fd"><label>목소리</label><div class="in sel">기본 음성<span class=\"chev\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:block\"><path d=\"m6 9 6 6 6-6\"/></svg></span></div></div></div></section>'}<section class="one"><div class="sh"><h3>프롬프트</h3></div><div class="pbox ${o.focus ? 'focus' : ''}">${HD.map(([h, k]) => `<div class="ph">${h}</div><div class="pc ${o.empty ? 'ph2' : ''}">${o.empty ? '내용을 입력하세요' : ED2[k]}</div>`).join('')}</div></section></div></div>`;
const HEAD = (name, live, btns, o = {}) => `<div class="ch"><div><div class="nm">${name}<span class="pen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span>${live ? '<span class="bd ok">통화에 사용 중</span>' : ''}</div><div class="vo"><span class="vsel ${o.off ? 'off' : ''}">목소리 <b>기본 음성</b> <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"display:block\"><path d=\"m6 9 6 6 6-6\"/></svg></span><span>10월 29일 오전 10:00 저장</span><a class="tl ${o.off ? 'off' : ''}">수정 기록 보기</a></div></div><div class="sp"></div>${btns}</div>`;
const CARD = (...parts) => `<div class="card">${parts.join('')}</div>`;
const T = '<button class="b plain">시나리오 시험</button>';
const SAVE = '<button class="b plain">취소</button><button class="b solid">저장</button>';
const cA = CARD(HEAD('빠른 접수형', true, T), FORM('빠른 접수형'));
const cE = CARD(HEAD('빠른 접수형', true, SAVE), FORM('빠른 접수형', { focus: 1 }));
const cB = CARD(HEAD('빠른 접수형', true, ''), band, FORM('빠른 접수형'));
const cK = CARD(HEAD('빠른 접수형', true, '', { off: 1 }), bandK, FORM('빠른 접수형', { locked: 1 }));
const cO = CARD(HEAD('빠른 접수형', true, ''), bandO, FORM('빠른 접수형'));
const cM = CARD(HEAD('빠른 접수형', true, ''), bandM, FORM('빠른 접수형'));
const cI = CARD(HEAD('빠른 접수형', true, '', { off: 1 }), bandI, FORM('빠른 접수형', { locked: 1 }));
const cD = CARD(HEAD('친절형', false, '<button class="b danger">삭제</button>' + T + '<button class="b line">통화에 사용하기</button>'), FORM('친절형'));
const cK2 = CARD(HEAD('친절형', false, '', { off: 1 }), bandK2, FORM('친절형', { locked: 1 }));
const cQ = CARD(HEAD('친절형', false, '<button class="b danger">삭제</button>' + T), bandQ, FORM('친절형'));
const cI2 = CARD(HEAD('친절형', false, '', { off: 1 }), bandI2, FORM('친절형', { locked: 1 }));
const cF = CARD('<div class="ch"><div><div class="nm">새 상담가</div></div><div class="sp"></div><button class="b plain">취소</button><button class="b solid">등록</button></div>', FORM('', { empty: 1 }));
css += '.nmin{display:inline-flex;align-items:center;width:280px;height:40px;padding:0 12px;border:1px solid #1a62d6;border-radius:6px;box-shadow:0 0 0 3px #eaf2fe;font-size:20px;font-weight:700;margin-right:2px}.pen{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:6px;color:#636d7f;margin-left:-6px}.vsel{display:inline-flex;align-items:center;gap:6px;line-height:1;height:28px;padding:0 10px;border:1px solid #c5ccd6;border-radius:6px;font-size:13px;color:#5b6475}.vsel b{color:#1d2433;font-weight:600}.vsel.off{opacity:.4}.fdoc.locked .in,.fdoc.locked .pc{background:#f5f6f8;color:#5b6475}.fdoc.locked .pbox{border-color:#e3e6eb}.pbox.focus{border-color:#1a62d6;box-shadow:0 0 0 3px #eaf2fe}.pc.ph2{color:#8a95a2}.in.ph{color:#8a95a2}';

const cS = (() => { const i = cA.indexOf('<div class="nm">빠른 접수형'); const j = cA.indexOf('</span>', cA.indexOf('<span class="pen">', i)) + 7;
  return cA.slice(0, i) + '<div class="nm"><span class="nmin">빠른 접수형</span>' + cA.slice(j); })();
fs.writeFileSync(process.argv[2], `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
${scr('A', '빠른 접수형', cA)}
${scr('B', '빠른 접수형', cB)}
${scr('C', '빠른 접수형', cA, modal)}
${scr('D', '친절형', cD)}
${scr('E', '빠른 접수형', cE)}
${scr('F', '', cF)}
${scr('G', '빠른 접수형', cB, dlg('시험하고 통화에 반영할까요?', '시나리오 10개를 모두 돌립니다. 모두 통과하면 바로 반영하고, 실패가 있으면 결과를 확인한 뒤 반영할 수 있습니다.', 'solid', '시험하고 반영'))}
${scr('H', '친절형', cD, dlg('통화에 쓰기 전에 친절형을 시험할까요?', '시나리오 10개를 모두 돌린 뒤, 결과를 보고 통화에 사용할지 정합니다.', 'solid', '시험 시작'))}
${scr('I', '빠른 접수형', cI)}
${scr('S', '빠른 접수형', cS)}
${scr('J', '친절형', cD, dlg('친절형을 삭제할까요?', '삭제하면 되돌릴 수 없습니다.', 'danger solid2', '삭제'))}
${scr('K', '빠른 접수형', cK)}
${scr('L', '빠른 접수형', cK, dlg('시험을 중단할까요?', '지금까지 돌린 결과는 남습니다. 통화에는 반영되지 않고, 다시 시험해야 반영할 수 있습니다.', 'danger solid2', '중단'))}
${scr('M', '빠른 접수형', cM)}
${scr('O', '빠른 접수형', cO)}
${scr('N', '빠른 접수형', cM, dlg('실패한 시나리오 2개가 있습니다. 통화에 반영할까요?', '실패: 앞 항목 정정, 취소 가능한 택배 취소<br>반영하면 다음 통화부터 고친 내용으로 응대합니다.', 'solid', '반영'))}
${scr('K2', '친절형', cK2)}
${scr('Q', '친절형', cQ)}
${scr('R', '친절형', cQ, dlg('친절형을 통화에 사용할까요?', '다음 통화부터 빠른 접수형 대신 친절형이 응대합니다. 지금 통화 중인 2건은 바뀌지 않습니다.', 'solid', '사용하기'))}
${scr('I2', '친절형', cI2)}
${scr2('P5', '시나리오 시험', '빠른 접수형 고친 내용 11월 12일 오후 3:20', p5)}
${scr2('P5b', '시나리오 시험', '빠른 접수형 고친 내용 11월 12일 오후 3:20', p5b)}
${scr2('P7', '앞 항목 정정', '빠른 접수형 시나리오 시험', p7)}</body></html>`);
