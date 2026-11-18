"use strict";

// shortcut: '말하는 중'은 AI 전사가 마지막으로 바뀐 뒤 이 시간 안이면 말하는 중으로 추측한다. 입이 어긋나면 서버에 speaking 값을 요청한다
const TALK_HOLD_MS = 800;

// 이름·주소·연락처는 화면에 값을 띄우지 않고 항목 이름만 쓴다 (시연 화면이 외부에 보일 수 있음). 라벨은 policy/workflow.toml과 같게
const FIELD_LABEL = {
  sender_name: "보내는 분 성함", sender_address: "발송 주소", sender_address_detail: "발송지 상세주소",
  receiver_name: "받는 분 성함", receiver_phone: "받는 분 연락처",
  receiver_address: "받는 곳 주소", receiver_address_detail: "받는 곳 상세주소",
  item_price: "물건 가격", client_comment: "배송 요청 사항", pickup_at: "수거 시각",
};
const COUNT_LABEL = { document_count: "서류 봉투", small_box_count: "소형 박스", medium_box_count: "중형 박스", big_box_count: "대형 박스" };
const BOX_LABEL = { small: "소형 박스", medium: "중형 박스", big: "대형 박스" };
const QUESTION_MAX = 40;

function recordText(a) {
  const adding = new Set(a.add_item_counts || []);
  const parts = [];
  for (const [key, value] of Object.entries(a)) {
    if (value == null) continue;
    if (FIELD_LABEL[key]) parts.push(FIELD_LABEL[key]);
    else if (COUNT_LABEL[key] && Number.isInteger(value)) {
      parts.push(value === 0 ? `${COUNT_LABEL[key]} 빼기` : `${COUNT_LABEL[key]} ${value}개${adding.has(key) ? " 추가" : ""}`);
    }
  }
  const box = a.box_suggestion;
  if (box && BOX_LABEL[box.size] && Number.isInteger(box.count)) parts.push(`${BOX_LABEL[box.size]} ${box.count}개`);
  if (!parts.length && (a.item_evidence || a.box_size_needed)) parts.push("물품");
  return parts.length ? `${parts.join(" · ")} 접수 중` : "접수 정보 기록 중";
}

// 도구 호출 하나 → 말풍선 한 줄. args는 모델이 만든 값이라 형식이 틀릴 수 있어 없는 셈 치고 기본 문장으로 돌아간다
function toolText(c) {
  const a = c.args && typeof c.args === "object" ? c.args : {};
  switch (c.name) {
    case "search_manual": {
      const q = typeof a.question === "string" ? a.question.trim() : "";
      if (!q) return "안내 자료 찾는 중";
      return `"${q.length > QUESTION_MAX ? q.slice(0, QUESTION_MAX) + "…" : q}" 알아보는 중`;
    }
    case "lookup_orders":
      if (a.other_customer) return "다른 번호로 접수된 주문 조회 중";
      if (a.receiver_name) return "받는 분 성함으로 주문 조회 중";
      if (a.scope === "current_call") return "이번 통화에서 접수한 택배 조회 중";
      if (a.scope === "previous_call") return "지난 통화에서 접수한 주문 조회 중";
      return "이 번호로 접수된 주문 조회 중";
    case "find_destination":
      if (a.recent) return "최근 보낸 곳 찾는 중";
      if (a.organization) return `${[a.organization, a.department].filter(Boolean).join(" ")} 찾는 중`;
      if (a.name) return "받는 분 성함으로 주소 찾는 중";
      return "받는 곳 주소 찾는 중";
    case "record_fields":
      return recordText(a);
    case "get_state":
      return "지금까지 접수한 내용 확인 중";
    default:
      return c.name;
  }
}

// 서버 단계(app/calls/session.py의 ENDED)는 "ended"를 보내지 않는다. "ended"는 문서(docs/ops/monitor.md)·옛 서버 값
const ENDED = new Set(["ended", "closing", "closed", "failed", "finalizing", "done"]);

function lastAt(lines, speaker) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].speaker === speaker) return lines[i].t ?? 0;
  return 0;
}

// call: 통화 스냅샷(docs/ops/monitor.md) / agentChangedAt: 화면이 AI 전사 변화를 본 시각(ms) / now: 지금(ms)
function stateOf(call, agentChangedAt, now) {
  if (!call || ENDED.has(call.status)) return { kind: "idle", tools: [] };
  const lines = call.transcript || [];
  const customerAt = lastAt(lines, "customer");
  const agentAt = lastAt(lines, "agent");
  // 고객 말 뒤에 시작한 도구들 (t·at·done_at 모두 서버 time.time()이라 비교 가능)
  const tools = (call.tool_calls || []).filter((c) => c.at > customerAt);
  // 모든 도구가 끝난 뒤 시작한 AI 발화만 대답으로 본다. 도구 실행 중 시작한 발화는 대기 멘트로 보고 말풍선을 유지
  // shortcut: 도구가 다 끝난 뒤 백엔드 판단을 기다리며 하는 대기 멘트는 대답으로 오인한다. 문제되면 서버에 위임 완료 시각을 요청한다
  const answered = tools.every((c) => c.done_at != null) && agentAt > Math.max(...tools.map((c) => c.done_at));
  if (tools.length && !answered) return { kind: "tool", tools: tools.map(toolText) };
  const last = lines[lines.length - 1];
  if (!last) return { kind: "idle", tools: [] };
  if (last.speaker === "customer") return { kind: "listening", tools: [] };
  return { kind: now - agentChangedAt < TALK_HOLD_MS ? "talking" : "idle", tools: [] };
}

const calls = new Map();           // session_id → 최신 스냅샷
const agentSeen = new Map();       // session_id → { sig: 마지막 AI 전사 "t|text", at: 화면이 그 변화를 본 시각(ms) }

// 진행 중(accepting·active) 통화 중 가장 최근에 시작한 것, 없으면 null
function pickCall() {
  let picked = null;
  for (const c of calls.values()) {
    if (!ENDED.has(c.status) && (!picked || c.started_at > picked.started_at)) picked = c;
  }
  return picked;
}

function noteAgent(call) {
  const lines = call.transcript || [];
  let last = null;
  for (let i = lines.length - 1; i >= 0 && !last; i--) if (lines[i].speaker === "agent") last = lines[i];
  if (!last) return;
  const sig = `${last.t}|${last.text}`;
  if (agentSeen.get(call.session_id)?.sig !== sig) agentSeen.set(call.session_id, { sig, at: Date.now() });
}

const IMG = "/monitor/live/";
const FRAME_MS = 150;
const FRAMES = {
  idle: ["idle.png"],
  listening: ["listening.png"],
  tool: ["toolcalling.png"],
  talking: ["idle.png", "talk_01.png", "talk_02.png", "talk_01.png"],
};
// 처음 바뀔 때 깜빡이지 않게 모든 프레임을 미리 받아 둔다
for (const name of new Set(Object.values(FRAMES).flat())) new Image().src = IMG + name;

const character = document.getElementById("character");
const bubble = document.getElementById("bubble");
const toolList = document.getElementById("tools");
let frameTimer = null;
let shownKind = "idle";

function render(state) {
  bubble.hidden = state.kind !== "tool";
  toolList.replaceChildren(...state.tools.map((label) => {
    const li = document.createElement("li");
    li.textContent = label; // 서버에서 온 도구 이름일 수 있어 innerHTML을 쓰지 않는다
    return li;
  }));
  if (state.kind === shownKind) return; // 같은 상태면 프레임 반복을 처음부터 다시 시작하지 않는다
  shownKind = state.kind;
  clearInterval(frameTimer);
  frameTimer = null;
  const frames = FRAMES[state.kind];
  let i = frames.length > 1 ? 1 : 0; // 말하기는 talk_01부터: 시작하자마자 입이 열리게
  character.src = IMG + frames[i];
  if (frames.length > 1) {
    frameTimer = setInterval(() => {
      i = (i + 1) % frames.length;
      character.src = IMG + frames[i];
    }, FRAME_MS);
  }
}

let lastKey = "";
function refresh() {
  const call = pickCall();
  const state = stateOf(call, call ? agentSeen.get(call.session_id)?.at ?? 0 : 0, Date.now());
  const key = `${call?.session_id ?? "-"}|${state.kind}|${state.tools.join(",")}`;
  if (key === lastKey) return; // 200ms마다 불리므로 바뀔 때만
  lastKey = key;
  render(state);
}

const source = new EventSource("/monitor/api/stream");
// 다시 연결되면 서버가 현재 목록을 처음부터 다시 보낸다. 끊긴 사이 사라진 통화가 '진행 중'으로 남지 않게 비운다
source.onopen = () => { calls.clear(); };
source.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type !== "call") return;
  calls.set(msg.call.session_id, msg.call);
  noteAgent(msg.call);
  refresh();
};
setInterval(refresh, 200); // SSE가 조용해도 '말하는 중 → 말 끝'으로 넘어가야 한다
