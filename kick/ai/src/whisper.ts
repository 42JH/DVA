import { useEffect, useRef, useState } from 'react';
import processorUrl from './mic-processor.js?url';

type Capture = { context: AudioContext; stream?: MediaStream; node?: AudioWorkletNode };

export function useWhisper(onFinal: (text: string) => void) {
  const callback = useRef(onFinal);
  callback.current = onFinal;
  const worker = useRef<Worker | null>(null);
  const capture = useRef<Capture | null>(null);
  const epoch = useRef(0);
  const pending = useRef(0);
  const flush = useRef<() => void>(() => {});
  const [state, setState] = useState<'off' | 'loading' | 'ready' | 'starting' | 'listening' | 'stopping'>('off');
  const [error, setError] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const base = new URL(import.meta.env.BASE_URL, location.href).href;

  function closeCapture() {
    const current = capture.current;
    capture.current = null;
    if (!current) return;
    if (current.node) current.node.port.onmessage = null;
    current.node?.disconnect();
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => {});
  }

  useEffect(() => () => {
    epoch.current++;
    closeCapture();
    worker.current?.terminate();
  }, []);

  function prepare() {
    if (worker.current) return;
    setError('');
    setState('loading');
    const next = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    worker.current = next;
    const fail = (reason: string) => {
      if (worker.current !== next) return;
      reset();
      setError(`Whisper 오류 · ${reason}`);
    };
    next.onerror = (event) => fail(event.message || '음성 인식 모델을 시작하지 못했어요.');
    next.onmessageerror = () => fail('음성 인식 결과를 읽지 못했어요.');
    next.onmessage = ({ data }) => {
      if (worker.current !== next) return;
      if (data.error) {
        fail(data.error);
      } else if (data.ready) {
        setState('ready');
      } else {
        if (data.text) callback.current(data.text);
        pending.current--;
        if (!pending.current) {
          setTranscribing(false);
          if (!capture.current) setState('ready');
        }
      }
    };
    next.postMessage({ base });
  }

  async function start() {
    if (state !== 'ready' || capture.current || !worker.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('마이크는 localhost 또는 HTTPS에서 사용할 수 있어요.');
      return;
    }
    const session = ++epoch.current;
    setState('starting');
    setError('');
    try {
      const context = new AudioContext({ sampleRate: 16000 });
      const current: Capture = { context };
      capture.current = current;
      await context.resume();
      if (session !== epoch.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== epoch.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      await context.audioWorklet.addModule(processorUrl);
      if (session !== epoch.current) return;
      const node = new AudioWorkletNode(context, 'microphone-frames', { numberOfOutputs: 0 });
      current.node = node;
      let frames: Float32Array[] = [];
      let length = 0;
      let voiced = 0;
      let silence = 0;
      let previous: Float32Array | undefined;
      flush.current = () => {
        if (voiced >= 3200 && worker.current) {
          const samples = new Float32Array(length);
          let offset = 0;
          for (const frame of frames) {
            samples.set(frame, offset);
            offset += frame.length;
          }
          pending.current++;
          setTranscribing(true);
          worker.current.postMessage({ base, samples }, [samples.buffer]);
        }
        frames = [];
        length = 0;
        voiced = 0;
        silence = 0;
      };
      node.port.onmessage = ({ data: frame }: MessageEvent<Float32Array>) => {
        if (session !== epoch.current) return;
        let energy = 0;
        for (const sample of frame) energy += sample * sample;
        const speaking = Math.sqrt(energy / frame.length) >= 0.009;
        if (!length && !speaking) {
          previous = frame;
          return;
        }
        if (!length && previous) {
          frames.push(previous);
          length += previous.length;
          previous = undefined;
        }
        frames.push(frame);
        length += frame.length;
        if (speaking) voiced += frame.length;
        silence = speaking ? 0 : silence + frame.length;
        if (silence >= 12800 || length >= 160000) flush.current();
      };
      stream.getAudioTracks()[0].onended = () => {
        if (session !== epoch.current) return;
        stop();
        setError('마이크 연결이 끊겼어요. 마이크를 다시 연결해 주세요.');
      };
      context.createMediaStreamSource(stream).connect(node);
      setState('listening');
    } catch (reason) {
      if (session !== epoch.current) return;
      closeCapture();
      setState('ready');
      setError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? '브라우저에서 마이크 권한을 허용한 뒤 다시 시작해 주세요.'
        : `마이크를 열지 못했어요 · ${String(reason)}`);
    }
  }

  function stop() {
    epoch.current++;
    flush.current();
    closeCapture();
    setState(pending.current ? 'stopping' : 'ready');
  }

  function reset() {
    epoch.current++;
    closeCapture();
    worker.current?.terminate();
    worker.current = null;
    pending.current = 0;
    flush.current = () => {};
    setTranscribing(false);
    setState('off');
    setError('');
  }

  return { state, error, transcribing, prepare, start, stop, reset };
}
