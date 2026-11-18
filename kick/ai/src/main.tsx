import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import sdk from '@litert-lm/core/package.json';
import { callPrompt, parseReplies, type Turn } from './call';
import { Gemma } from './gemma';
import { getGpuAdapter, modelBytes, modelFile, modelRevision, modelUrl, prepareModel } from './model';
import { useLocalSpeech } from './speech';
import { useWhisper } from './whisper';
import './styles.css';

type Status = 'idle' | 'downloading' | 'loading' | 'ready' | 'generating' | 'advising' | 'cancelling' | 'releasing';

const labels: Record<Status, string> = {
  idle: '로드 대기', downloading: '모델 파일 준비 중', loading: '모델 초기화 중',
  ready: '추론 가능', generating: '응답 생성 중', advising: '대화 분석 중',
  cancelling: '생성 중지 중', releasing: '모델 해제 중',
};
const initialPrompt = '금요일 오후 3시에 회의가 가능하냐는 질문에 한국어로 한 문장으로 답해 주세요.';
const formatMs = (value: number | null) => value === null ? '—' : `${Math.round(value).toLocaleString()} ms`;
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

function App() {
  const [gemma] = useState(() => new Gemma());
  const [gpu, setGpu] = useState({ label: '확인 중', available: false });
  const [status, setStatus] = useState<Status>('idle');
  const busy = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [progress, setProgress] = useState(0);
  const [source, setSource] = useState('—');
  const [downloadMs, setDownloadMs] = useState<number | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [resultStatus, setResultStatus] = useState('');
  const [firstChunkMs, setFirstChunkMs] = useState<number | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<Gemma['generate']>>>(null);
  const call = useRef({ turns: [] as Turn[], handled: 0, failed: false });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [replies, setReplies] = useState<string[]>([]);
  const [callError, setCallError] = useState('');
  const [typedTurn, setTypedTurn] = useState('');
  const [retry, setRetry] = useState(0);

  function addTurn(speaker: Turn['speaker'], text: string) {
    const next = [...call.current.turns, { speaker, text }];
    call.current.turns = next;
    call.current.failed = false;
    setTurns(next);
    setCallError('');
    setReplies([]);
  }

  const speech = useLocalSpeech((text) => addTurn('상대방', text));
  const whisper = useWhisper((text) => addTurn('상대방', text));
  const [speechEngine, setSpeechEngine] = useState('whisper');
  const useBrowserSpeech = speechEngine === 'browser';

  function resetCall() {
    speech.reset();
    whisper.reset();
    if (status === 'advising') gemma.cancel();
    call.current = { turns: [], handled: 0, failed: false };
    setTurns([]);
    setReplies([]);
    setCallError('');
    setTypedTurn('');
  }

  useEffect(() => {
    const session = call.current;
    const snapshot = session.turns;
    if (status !== 'ready' || busy.current || session.failed || session.handled === snapshot.length
      || snapshot.at(-1)?.speaker !== '상대방') return;
    busy.current = true;
    setStatus('advising');
    setFirstChunkMs(null);
    setResult(null);
    let output = '';
    void gemma.generate(callPrompt(snapshot), (text, elapsed) => {
      output = text;
      if (call.current === session && session.turns === snapshot) setFirstChunkMs((first) => first ?? elapsed);
    }, systemPrompt).then((generation) => {
      if (!generation || call.current !== session || session.turns !== snapshot) return;
      const nextReplies = parseReplies(output);
      session.handled = snapshot.length;
      setReplies(nextReplies);
      setResult(generation);
    }).catch((reason: unknown) => {
      if (call.current !== session || session.turns !== snapshot) return;
      session.failed = true;
      setCallError(`대화 분석 실패 · ${describeError(reason)}`);
    }).finally(() => {
      busy.current = false;
      setStatus('ready');
    });
  }, [gemma, status, turns, retry, systemPrompt]);

  useEffect(() => {
    let active = true;
    void getGpuAdapter().then((adapter) => {
      if (!active) return;
      const name = adapter.info.description || [adapter.info.vendor, adapter.info.architecture].filter(Boolean).join(' ');
      setGpu({ label: name ? `사용 가능 · ${name}` : '사용 가능', available: true });
    }).catch((reason: unknown) => {
      if (active) setGpu({ label: describeError(reason), available: false });
    });
    return () => { active = false; };
  }, []);

  async function loadModel() {
    if (busy.current || !gpu.available || status !== 'idle') return;
    busy.current = true;
    setError('');
    setProgress(0);
    setSource('—');
    setDownloadMs(null);
    setLoadMs(null);
    setStatus('downloading');
    try {
      const prepared = await prepareModel(selectedFile, setProgress);
      setSource(prepared.source);
      setDownloadMs(prepared.downloadMs);
      setStatus('loading');
      const start = performance.now();
      await gemma.initialize(prepared.file);
      setLoadMs(performance.now() - start);
      setStatus('ready');
    } catch (reason) {
      setError(`모델 준비 실패 · ${describeError(reason)}`);
      setStatus('idle');
    } finally {
      busy.current = false;
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || status !== 'ready' || !prompt.trim()) return;
    busy.current = true;
    setStatus('generating');
    setError('');
    setResponse('');
    setResultStatus('');
    setFirstChunkMs(null);
    setResult(null);
    try {
      const generation = await gemma.generate(prompt.trim(), (text, elapsed) => {
        setResponse(text);
        setFirstChunkMs((first) => first ?? elapsed);
      }, systemPrompt);
      setResult(generation);
      setResultStatus(generation ? '생성 완료' : '생성 중지됨');
    } catch (reason) {
      setError(`생성 실패 · ${describeError(reason)}`);
    } finally {
      setStatus('ready');
      busy.current = false;
    }
  }

  async function release() {
    if (busy.current || status !== 'ready') return;
    busy.current = true;
    setStatus('releasing');
    setError('');
    try {
      await gemma.release();
    } catch (reason) {
      setError(`모델 해제 실패 · ${describeError(reason)}`);
    } finally {
      setStatus('idle');
      busy.current = false;
    }
  }

  const benchmark = result?.benchmark;
  return (
    <main>
      <header>
        <h1>한국어 통화 연습</h1>
        <p>상대방 역할로 말하면 Gemma가 내가 말할 답변을 추천합니다.</p>
      </header>
      <section className="system-prompt" aria-labelledby="system-title">
        <h2 id="system-title">모델 지시</h2>
        <label htmlFor="system-prompt">시스템 프롬프트 (선택 사항)</label>
        <textarea id="system-prompt" rows={2} maxLength={400} value={systemPrompt}
          placeholder="예: 상대방에게 정중하게 답하고, 날짜와 시간은 그대로 유지해 주세요."
          onChange={(event) => setSystemPrompt(event.target.value)} />
        <p className="hint">다음 대화 분석과 Gemma 단독 테스트에 적용돼요.</p>
      </section>
      <div className="workspace call-workspace">
        <section aria-labelledby="call-title">
          <h2 id="call-title">실시간 대화</h2>
          <p className="hint">마이크에 상대방처럼 말해 보세요. Gemma를 로드하면 추천 답변이 표시돼요.</p>
          <label htmlFor="speech-engine">음성 인식 방식</label>
          <select id="speech-engine" value={speechEngine} onChange={(event) => {
            speech.reset();
            whisper.reset();
            setSpeechEngine(event.target.value);
          }}>
            <option value="whisper">Whisper (기기 내)</option>
            <option value="browser">브라우저 한국어 음성 팩</option>
          </select>
          {useBrowserSpeech ? <><p className="hint">
            {speech.availability === 'available' ? '한국어 기기 내 음성 인식 준비됨' :
              speech.availability === 'checking' ? '한국어 음성 팩 확인 중' :
              speech.availability === 'downloading' ? '한국어 음성 팩 설치 중' :
              speech.availability === 'downloadable' ? '한국어 음성 팩을 먼저 설치해 주세요.' :
              '이 브라우저에서 한국어 로컬 음성 인식을 사용할 수 없어요. 아래에 발화를 입력해 테스트할 수 있어요.'}
          </p>
          <div className="actions">
            {speech.availability === 'downloadable' && <button type="button" onClick={speech.install}>한국어 음성 팩 설치</button>}
            <button type="button" onClick={speech.start}
              disabled={speech.availability !== 'available' || speech.mic !== 'off'}>마이크 시작</button>
            <button className="secondary" type="button" onClick={speech.stop}
              disabled={speech.mic === 'off' || speech.mic === 'stopping'}>마이크 중지</button>
          </div>
          {speech.error && <p className="error" role="alert">{speech.error}</p>}
          <p className="hint" aria-live="polite">{{ off: '마이크 꺼짐', starting: '마이크 연결 중', listening: '듣는 중', stopping: '마이크 종료 중' }[speech.mic]}</p>
          </> : <>
            <div className="actions">
              {whisper.state === 'off' || whisper.state === 'loading'
                ? <button type="button" onClick={whisper.prepare} disabled={whisper.state === 'loading'}>음성 인식 모델 준비</button>
                : <button type="button" onClick={whisper.start} disabled={whisper.state !== 'ready'}>마이크 시작</button>}
              <button className="secondary" type="button" onClick={whisper.stop}
                disabled={whisper.state !== 'listening' && whisper.state !== 'starting'}>마이크 중지</button>
            </div>
            {whisper.error && <p className="error" role="alert">{whisper.error}</p>}
            <p className="hint" aria-live="polite">{whisper.transcribing ? '자막 생성 중' : {
              off: '처음에는 Whisper 모델 파일을 준비해 주세요.', loading: 'Whisper 모델 준비 중',
              ready: '마이크 시작을 누르고 말한 뒤 잠깐 쉬어 주세요.', starting: '마이크 연결 중',
              listening: '듣는 중', stopping: '마이크 종료 중',
            }[whisper.state]}</p>
          </>}
          <button className="secondary" type="button" onClick={resetCall}>대화 초기화</button>
          <ol className="transcript" aria-label="확정 자막">
            {turns.map((turn, index) => <li key={index}><strong>{turn.speaker}</strong> {turn.text}</li>)}
          </ol>
          {useBrowserSpeech && speech.partial && <p className="partial">임시 자막 · {speech.partial}</p>}
          <form className="typed-turn" onSubmit={(event) => {
            event.preventDefault();
            if (!typedTurn.trim()) return;
            addTurn('상대방', typedTurn.trim());
            setTypedTurn('');
          }}>
            <label htmlFor="typed-turn">상대방 발화 입력</label>
            <input id="typed-turn" value={typedTurn} onChange={(event) => setTypedTurn(event.target.value)} />
            <button type="submit" disabled={!typedTurn.trim()}>발화 추가</button>
          </form>
        </section>
        <section aria-labelledby="advice-title">
          <h2 id="advice-title">추천 답변</h2>
          {replies.length > 0 ? <div className="reply" role="group" aria-label="추천 답변">
            {replies.map((reply) => (
              <button key={reply} className="secondary" type="button" onClick={() => addTurn('나', reply)}>{reply}</button>
            ))}
          </div> : <p className="hint" aria-live="polite">
            {status === 'advising' ? '최신 발화로 답변을 만드는 중이에요.' :
              turns.length && status === 'idle' ? '모델을 로드하면 대화를 분석해요.' :
              '추천 답변이 준비되면 여기에 표시돼요.'}
          </p>}
          {callError && <div><p className="error" role="alert">{callError}</p>
            <button type="button" disabled={status !== 'ready'} onClick={() => {
              call.current.failed = false;
              setCallError('');
              setRetry((count) => count + 1);
            }}>분석 다시 시도</button>
          </div>}
        </section>
      </div>
      <div className="workspace">
        <section aria-labelledby="model-title">
          <h2 id="model-title">실행 환경</h2>
          <dl>
            <div><dt>WebGPU</dt><dd>{gpu.label}</dd></div>
            <div><dt>모델</dt><dd><a href={modelUrl}>{modelFile}</a><small> {modelRevision.slice(0, 7)} · 2.34 GB</small></dd></div>
            <div><dt>LiteRT-LM</dt><dd>{sdk.version}</dd></div>
            <div><dt>상태</dt><dd role="status">{labels[status]}</dd></div>
            <div><dt>파일 출처</dt><dd>{source}</dd></div>
          </dl>
          <label htmlFor="model-file">모델 파일 선택 (선택 사항)</label>
          <input id="model-file" type="file" accept=".litertlm" disabled={status !== 'idle'}
            onChange={(event) => setSelectedFile(event.target.files?.[0])} />
          <p className="hint">파일을 선택하지 않으면 처음에 모델을 내려받아 브라우저에 저장합니다.</p>
          {status === 'downloading' && (
            <div className="download">
              <progress aria-label="모델 다운로드" max={modelBytes} value={progress} />
              <span>{(progress / 1e6).toFixed(0)} / {(modelBytes / 1e6).toFixed(0)} MB</span>
            </div>
          )}
          <div className="actions">
            <button type="button" onClick={loadModel} disabled={!gpu.available || status !== 'idle'}>모델 로드</button>
            <button className="secondary" type="button" onClick={release} disabled={status !== 'ready'}>모델 해제</button>
          </div>
        </section>
        <section aria-labelledby="prompt-title">
          <h2 id="prompt-title">Gemma 단독 테스트</h2>
          <form onSubmit={generate}>
            <label htmlFor="prompt">프롬프트</label>
            <textarea id="prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <div className="actions">
              <button type="submit" disabled={status !== 'ready' || !prompt.trim()}>응답 생성</button>
              <button className="secondary" type="button" disabled={status !== 'generating'} onClick={() => {
                setStatus('cancelling');
                gemma.cancel();
              }}>생성 중지</button>
            </div>
          </form>
          <h3 id="response-title">모델 응답</h3>
          <p className="response" aria-labelledby="response-title">{response || '생성한 응답이 여기에 표시됩니다.'}</p>
          <p className="hint" aria-live="polite">{resultStatus}</p>
        </section>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="metrics" aria-labelledby="metrics-title">
        <h2 id="metrics-title">실행 시간</h2>
        <dl>
          <div><dt>모델 다운로드</dt><dd>{formatMs(downloadMs)}</dd></div>
          <div><dt>모델 초기화</dt><dd>{formatMs(loadMs)}</dd></div>
          <div><dt>첫 응답 조각</dt><dd>{formatMs(firstChunkMs)}</dd></div>
          <div><dt>전체 생성</dt><dd>{formatMs(result?.totalMs ?? null)}</dd></div>
          <div><dt>첫 토큰 (SDK)</dt><dd>{formatMs(benchmark && benchmark.timeToFirstTokenInSecond > 0
            ? benchmark.timeToFirstTokenInSecond * 1000 : null)}</dd></div>
          <div><dt>생성 속도 (SDK)</dt><dd>{benchmark && Number.isFinite(benchmark.lastDecodeTokensPerSecond)
            && benchmark.lastDecodeTokensPerSecond > 0 ? `${benchmark.lastDecodeTokensPerSecond.toFixed(1)} tok/s` : '—'}</dd></div>
        </dl>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
