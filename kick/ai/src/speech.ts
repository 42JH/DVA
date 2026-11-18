import { useEffect, useRef, useState } from 'react';

type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
interface LocalRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionConstructor {
  new (): LocalRecognition;
  available(options: typeof korean): Promise<Availability>;
  install(options: typeof korean): Promise<boolean>;
}

const korean = { langs: ['ko-KR'], processLocally: true };
const messages: Record<string, string> = {
  'not-allowed': '브라우저에서 마이크 권한을 허용한 뒤 다시 시작해 주세요.',
  'service-not-allowed': '브라우저 설정에서 기기 내 음성 인식이 차단되어 있어요.',
  'audio-capture': '마이크를 찾지 못했어요. 연결 상태를 확인해 주세요.',
  'language-not-supported': '한국어 음성 팩 상태를 확인해 주세요.',
};

export function useLocalSpeech(onFinal: (text: string) => void) {
  const callback = useRef(onFinal);
  callback.current = onFinal;
  const [availability, setAvailability] = useState<Availability | 'checking' | 'unsupported'>('checking');
  const [mic, setMic] = useState<'off' | 'starting' | 'listening' | 'stopping'>('off');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const recognition = useRef<LocalRecognition | null>(null);
  const requested = useRef(false);
  const restart = useRef<number | undefined>(undefined);
  const browser = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  const supported = constructor && 'processLocally' in constructor.prototype
    && typeof constructor.available === 'function' && typeof constructor.install === 'function';

  useEffect(() => {
    let mounted = true;
    if (supported) {
      void constructor.available(korean).then((value) => {
        if (mounted) setAvailability(value);
      }).catch(() => {
        if (mounted) setAvailability('unsupported');
      });
    } else {
      setAvailability('unsupported');
    }
    return () => {
      mounted = false;
      requested.current = false;
      window.clearTimeout(restart.current);
      const active = recognition.current;
      recognition.current = null;
      active?.abort();
    };
  }, [constructor, supported]);

  useEffect(() => {
    if (!supported || availability !== 'downloading') return;
    let active = true;
    const timer = window.setInterval(() => {
      void constructor.available(korean).then((value) => {
        if (active) setAvailability(value);
      }).catch(() => {});
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [availability, constructor, supported]);

  async function install() {
    if (!supported) return;
    setError('');
    setAvailability('downloading');
    try {
      const installed = await constructor.install(korean);
      setAvailability(await constructor.available(korean));
      if (!installed) setError('한국어 음성 팩을 설치하지 못했어요. 인터넷 연결을 확인해 주세요.');
    } catch {
      setAvailability('downloadable');
      setError('한국어 음성 팩 설치 상태를 확인하지 못했어요. 다시 시도해 주세요.');
    }
  }

  function start() {
    if (!supported || availability !== 'available' || recognition.current) return;
    setError('');
    requested.current = true;
    openRecognition(constructor);
  }

  function openRecognition(api: RecognitionConstructor) {
    const instance = new api();
    recognition.current = instance;
    instance.lang = 'ko-KR';
    instance.processLocally = true;
    instance.continuous = true;
    instance.interimResults = true;
    const finalized = new Set<number>();
    setMic('starting');
    instance.onstart = () => {
      if (recognition.current === instance && requested.current) setMic('listening');
    };
    instance.onresult = ({ resultIndex, results }) => {
      if (recognition.current !== instance) return;
      const interim: string[] = [];
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const text = result[0].transcript.trim();
        if (!result.isFinal) {
          if (text) interim.push(text);
        } else if (index >= resultIndex && text && !finalized.has(index)) {
          finalized.add(index);
          callback.current(text);
        }
      }
      setPartial(interim.join(' '));
    };
    instance.onerror = ({ error: code }) => {
      if (recognition.current !== instance || code === 'no-speech' || code === 'aborted') return;
      requested.current = false;
      setError(messages[code] ?? `음성 인식이 중단됐어요 (${code}).`);
      if (code === 'language-not-supported') {
        void api.available(korean).then(setAvailability).catch(() => {});
      }
    };
    instance.onend = () => {
      if (recognition.current !== instance) return;
      recognition.current = null;
      setPartial('');
      if (!requested.current) {
        setMic('off');
        return;
      }
      setMic('starting');
      restart.current = window.setTimeout(() => {
        if (requested.current && !recognition.current) openRecognition(api);
      }, 250);
    };
    try {
      instance.start();
    } catch {
      requested.current = false;
      recognition.current = null;
      setMic('off');
      setError('마이크를 시작하지 못했어요. 브라우저 권한을 확인해 주세요.');
    }
  }

  function stop() {
    requested.current = false;
    window.clearTimeout(restart.current);
    if (!recognition.current) {
      setMic('off');
      return;
    }
    setMic('stopping');
    recognition.current.stop();
  }

  function reset() {
    requested.current = false;
    window.clearTimeout(restart.current);
    const active = recognition.current;
    recognition.current = null;
    active?.abort();
    setMic('off');
    setPartial('');
    setError('');
  }

  return { availability, mic, partial, error, install, start, stop, reset };
}
