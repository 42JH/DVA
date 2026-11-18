const $ = (id) => document.getElementById(id);
let pc, mic, events, channel, audioContext, animation, labId, muted = false;
let lastBubble, lastRole, lastEnd, lastSpeechEnd, speechActive = false, silentSince;
let handoffNotice, playbackForHandoff = false, remoteActive = false;
const seen = new Set();
const sec = (v) => Number.isFinite(v) ? `${v.toFixed(2)}초` : '—';
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function tick(label, ms) {
  const row = document.createElement('div'); row.className = 'tick';
  const stamp = document.createElement('time'); stamp.textContent = Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)}s` : '브라우저';
  const text = document.createElement('span'); text.textContent = label;
  row.append(stamp, text); $('timeline').append(row);
  while ($('timeline').children.length > 200) $('timeline').firstChild.remove();
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
function transcript(role, delta, start, end) {
  $('transcript').querySelector('.empty')?.remove();
  if (!lastBubble || lastRole !== role || !Number.isFinite(start) || !Number.isFinite(lastEnd) || start - lastEnd > 1500) {
    const box = document.createElement('div'); box.className = `bubble ${role}`;
    const label = document.createElement('small'); label.textContent = role === 'user' ? '고객' : 'LIVE-1';
    const paragraph = document.createElement('p'); box.append(label, paragraph); $('transcript').append(box); lastBubble = paragraph;
  }
  lastBubble.textContent += delta; lastRole = role; lastEnd = end;
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
function showEvidence(items) {
  $('evidence').replaceChildren();
  for (const item of items) {
    const box = document.createElement('details'); box.className = 'document'; box.open = true;
    const title = document.createElement('summary'); title.textContent = `${item.rank}. ${item.title}`;
    const body = document.createElement('pre'); body.textContent = item.content;
    box.append(title, body); $('evidence').append(box);
  }
}
function event(value) {
  if (value.type === 'snapshot') {
    lastBubble = null; lastRole = null; lastEnd = null; $('transcript').replaceChildren();
    for (const item of value.snapshot.transcripts) transcript(item.role, item.text, item.start_ms, item.end_ms);
    for (const trace of value.snapshot.traces) if (trace.evidence) showEvidence(trace.evidence);
    for (const old of value.snapshot.events) seen.add(old.seq);
    return;
  }
  if (seen.has(value.seq)) return; seen.add(value.seq);
  switch (value.type) {
    case 'transcript': transcript(value.role, value.delta, value.start_ms, value.end_ms); break;
    case 'connected': tick('Live 제어 연결 준비', value.server_ms); break;
    case 'delegation': tick('Live-1 → 백엔드 검색 요청', value.server_ms); break;
    case 'search_started':
      $('query').textContent = value.query; $('backendTime').textContent = sec(value.backend_seconds);
      tick(`백엔드 도구 선택 ${sec(value.backend_seconds)} → RAG 검색`, value.server_ms); break;
    case 'handoff_ready':
      $('embeddingTime').textContent = sec(value.search_timings?.embedding_seconds);
      $('searchTime').textContent = sec(value.search_seconds); $('audioTime').textContent = '대기 중';
      showEvidence(value.evidence); handoffNotice = performance.now(); playbackForHandoff = false;
      tick(`Top3를 Live-1에 직접 전달 · ${value.context_parts}조각 · 백엔드 추가 호출 없음`, value.server_ms); break;
    case 'output_observed':
      if (value.output_type === 'audio') $('audioTime').textContent = sec(value.after_handoff_ms / 1000);
      tick(`근거 전달 후 첫 ${value.output_type === 'audio' ? '음성 프레임' : '전사'} 수신 ${sec(value.after_handoff_ms / 1000)}${Number.isFinite(value.input_end_gap_ms) ? ` · 고객 전사 끝부터 ${sec(value.input_end_gap_ms/1000)} (세션 타임라인 추정)` : ''}`, value.server_ms); break;
    case 'stale_result': tick('새 위임이 있어 이전 검색 결과 발화 생략', value.server_ms); break;
    case 'error': notice(`${value.message}${value.error_type ? ` (${value.error_type})` : ''}`, true); tick(value.message, value.server_ms); break;
    case 'expired': notice('실험 시간 제한으로 연결이 종료됩니다.'); break;
    case 'closed':
      notice('대화가 종료되었습니다. 기록을 내보낼 수 있습니다.'); $('status').textContent = '종료';
      $('dot').className = ''; cleanupMedia(); break;
  }
}
async function measure(payload) {
  if (!labId) return;
  try { await fetch(`/live-lab/api/sessions/${encodeURIComponent(labId)}/measurements`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}); } catch {}
}
function analyser(stream) {
  const source = audioContext.createMediaStreamSource(stream); const node = audioContext.createAnalyser(); node.fftSize = 1024; source.connect(node);
  const data = new Float32Array(node.fftSize);
  return () => { node.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length); };
}
function watchAudio(inputLevel, outputLevel) {
  let lastFrame = 0;
  function frame(now) {
    animation = requestAnimationFrame(frame); if (now - lastFrame < 50) return; lastFrame = now;
    if (inputLevel() > .015 && !muted) { speechActive = true; silentSince = undefined; }
    else if (speechActive) {
      silentSince ??= now;
      if (now - silentSince > 300) { lastSpeechEnd = silentSince; speechActive = false; measure({kind:'user_speech_end',client_ms:lastSpeechEnd}); }
    }
    const playing = outputLevel ? outputLevel() > .008 : false;
    if (playing && !remoteActive) {
      const gap = lastSpeechEnd === undefined ? null : Math.max(0, now - lastSpeechEnd);
      measure({kind:'playback_start',client_ms:now,user_to_audio_ms:gap});
      tick(`브라우저 출력 음성 감지${gap === null ? '' : ` · 마지막 고객 음성 후 ${sec(gap/1000)} (추정)`}`);
    }
    if (playing && handoffNotice !== undefined && !playbackForHandoff) {
      playbackForHandoff = true;
      measure({kind:'playback_after_handoff',client_ms:now,after_handoff_notice_ms:now-handoffNotice});
      tick(`근거 준비 알림 후 출력 에너지 감지 ${sec((now-handoffNotice)/1000)} (발화 시작/정답 여부는 전사 확인)`);
    }
    remoteActive = playing;
  }
  animation = requestAnimationFrame(frame);
}
function cleanupMedia() {
  if (animation) cancelAnimationFrame(animation);
  events?.close(); channel?.close(); pc?.close(); mic?.getTracks().forEach(track => track.stop());
  if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(()=>{});
  $('remoteAudio').srcObject = null; $('connect').disabled = false; $('stop').disabled = true; $('mute').disabled = true;
}
async function stop() {
  $('stop').disabled = true;
  try { if (labId) await fetch(`/live-lab/api/sessions/${encodeURIComponent(labId)}`, {method:'DELETE'}); }
  finally { cleanupMedia(); $('status').textContent='종료'; $('dot').className=''; }
}
$('connect').onclick = async () => {
  $('connect').disabled = true; notice('마이크와 Live-1 연결을 준비합니다.');
  lastBubble = null; lastRole = null; lastEnd = null; lastSpeechEnd = undefined; handoffNotice = undefined;
  remoteActive = false; speechActive = false; silentSince = undefined; muted = false;
  seen.clear(); labId=undefined; $('export').disabled=true; $('transcript').replaceChildren(); $('timeline').replaceChildren();
  try {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('마이크는 localhost 또는 HTTPS에서 사용할 수 있습니다.');
    audioContext = new AudioContext(); await audioContext.resume();
    mic = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    pc = new RTCPeerConnection(); let remoteLevel;
    pc.ontrack = ({track,streams}) => {
      const stream = streams[0] || new MediaStream([track]); $('remoteAudio').srcObject=stream;
      $('remoteAudio').play().catch(()=>notice('소리가 들리지 않으면 오디오 재생 버튼을 눌러 주세요.'));
      remoteLevel = analyser(stream);
    };
    for (const track of mic.getTracks()) pc.addTrack(track,mic);
    channel = pc.createDataChannel('oai-events');
    channel.onmessage = ({data}) => {
      try { const v=JSON.parse(data); if(v.type==='session.started') { $('status').textContent='대화 중'; $('dot').className='active'; notice('질문해 보세요. 전사와 검색 시간이 아래에 표시됩니다.'); } } catch {}
    };
    pc.onconnectionstatechange = () => { if(pc.connectionState==='failed') { notice('미디어 연결이 끊겼습니다.',true); stop(); } };
    await pc.setLocalDescription(await pc.createOffer());
    if(pc.iceGatheringState!=='complete') await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',check);reject(new Error('미디어 연결 준비 시간 초과'));},15000);
      function check(){if(pc.iceGatheringState==='complete'){clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',check);resolve();}}
      pc.addEventListener('icegatheringstatechange',check); check();
    });
    const response=await fetch('/live-lab/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:pc.localDescription.sdp})});
    if(!response.ok) { let detail;try{detail=(await response.json()).detail;}catch{}throw new Error(detail||'세션 생성 실패'); }
    const result=await response.json(); labId=result.lab_id;
    events=new EventSource(`/live-lab/api/sessions/${encodeURIComponent(labId)}/events`);
    events.onmessage=({data})=>{try{event(JSON.parse(data));}catch(e){notice(`이벤트 표시 실패: ${e.message}`,true);}};
    await pc.setRemoteDescription({type:'answer',sdp:result.transport.sdp});
    const inputLevel=analyser(mic); watchAudio(inputLevel,()=>remoteLevel ? remoteLevel() : 0);
    $('mute').disabled=false; $('stop').disabled=false; $('export').disabled=false; $('mute').textContent='마이크 끄기';
  } catch(error) { notice(error.message,true); if(labId) await stop(); else cleanupMedia(); }
};
$('mute').onclick=()=>{muted=!muted;mic?.getTracks().forEach(track=>track.enabled=!muted);$('mute').textContent=muted?'마이크 켜기':'마이크 끄기';};
$('stop').onclick=stop;
$('export').onclick=async()=>{
  if(!labId)return;const r=await fetch(`/live-lab/api/sessions/${encodeURIComponent(labId)}/export`);if(!r.ok){notice('기록을 가져오지 못했습니다.',true);return;}
  const url=URL.createObjectURL(new Blob([JSON.stringify(await r.json(),null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`live-rag-${new Date().toISOString().replaceAll(':','-')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('pagehide',()=>{if(labId)fetch(`/live-lab/api/sessions/${encodeURIComponent(labId)}`,{method:'DELETE',keepalive:true}).catch(()=>{});cleanupMedia();});
fetch('/live-lab/api/config').then(r=>r.json()).then(c=>{$('models').textContent=`${c.live_model} / ${c.backend_model}`;}).catch(()=>notice('서버 설정을 가져오지 못했습니다.',true));
