import { ApiException } from '../common/errors/api.exception';

export const PERSONA_PROMPT_FIELDS = [
  'role',
  'personality',
  'tone',
  'speedInstruction',
  'backchannel',
  'interruption',
] as const;

export type PersonaPromptFields = Record<(typeof PERSONA_PROMPT_FIELDS)[number], string>;

export function composePersonaPrompt(fields: PersonaPromptFields): string {
  const text = `# 페르소나\n\n## 역할\n${fields.role}\n\n## 성격\n${fields.personality}\n\n## 발화 스타일\n### 톤\n${fields.tone}\n\n### 속도\n${fields.speedInstruction}\n\n## 맞장구\n${fields.backchannel}\n\n## 끼어들기\n${fields.interruption}`;
  // AI의 Python 문자 수 기준과 일치시킨다. UTF-16 길이는 이모지를 두 번 센다.
  if (Array.from(text).length > 20000)
    throw new ApiException(
      422,
      'BUSINESS_RULE_VIOLATION',
      '조합한 프롬프트는 20,000자 이하여야 합니다.',
    );
  return text;
}
