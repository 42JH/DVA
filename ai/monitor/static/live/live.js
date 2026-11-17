"use strict";

// shortcut: '말하는 중'은 AI 전사가 마지막으로 바뀐 뒤 이 시간 안이면 말하는 중으로 추측한다. 입이 어긋나면 서버에 speaking 값을 요청한다
const TALK_HOLD_MS = 800;

const TOOL_LABEL = {
  record_fields: "접수 정보 기록 중",
  find_destination: "받는 곳 찾는 중",
  lookup_orders: "주문 조회 중",
  search_manual: "안내 자료 검색 중",
  get_state: "접수 상태 확인 중",
};

function lastAt(lines, speaker) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].speaker === speaker) return lines[i].t ?? 0;
  return 0;
}

// call: 통화 스냅샷(docs/ops/monitor.md) / agentChangedAt: 화면이 AI 전사 변화를 본 시각(ms) / now: 지금(ms)
function stateOf(call, agentChangedAt, now) {
  if (!call || call.status === "ended") return { kind: "idle", tools: [] };
  const lines = call.transcript || [];
  const customerAt = lastAt(lines, "customer");
  const agentAt = lastAt(lines, "agent");
  // 고객 말 뒤에 시작한 도구들 (t·at·done_at 모두 서버 time.time()이라 비교 가능)
  const tools = (call.tool_calls || []).filter((c) => c.at > customerAt);
  // 모든 도구가 끝난 뒤 시작한 AI 발화만 대답으로 본다. 도구 실행 중 시작한 발화는 대기 멘트로 보고 말풍선을 유지
  // shortcut: 도구가 다 끝난 뒤 백엔드 판단을 기다리며 하는 대기 멘트는 대답으로 오인한다. 문제되면 서버에 위임 완료 시각을 요청한다
  const answered = tools.every((c) => c.done_at != null) && agentAt > Math.max(...tools.map((c) => c.done_at));
  if (tools.length && !answered) return { kind: "tool", tools: tools.map((c) => TOOL_LABEL[c.name] ?? c.name) };
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
    if (c.status !== "ended" && (!picked || c.started_at > picked.started_at)) picked = c;
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
