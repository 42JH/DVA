import { ConflictException, HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import {
  ElevenLabsRequestError,
  ElevenLabsService,
  type SpeechSettings,
  type VoiceSample,
} from './elevenlabs.service';

type VoiceStatus = 'CREATING' | 'VERIFICATION_REQUIRED' | 'READY';
type Voice = { voiceId: string | null; status: VoiceStatus };

@Injectable()
export class VoiceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly elevenLabs: ElevenLabsService,
  ) {}

  private async find(accountId: string): Promise<Voice | undefined> {
    const { rows } = await this.database.query<Voice>(
      'SELECT provider_voice_id AS "voiceId", status FROM voice_clones WHERE user_id = $1',
      [accountId],
    );
    return rows[0];
  }

  async status(accountId: string): Promise<{ status: VoiceStatus | 'NOT_REGISTERED' }> {
    const voice = await this.find(accountId);
    if (
      voice?.status === 'VERIFICATION_REQUIRED' &&
      voice.voiceId &&
      (await this.elevenLabs.isVerified(voice.voiceId))
    ) {
      const { rows } = await this.database.query<{ status: VoiceStatus }>(
        `UPDATE voice_clones SET status = 'READY'
         WHERE user_id = $1 AND provider_voice_id = $2 RETURNING status`,
        [accountId, voice.voiceId],
      );
      return rows[0] ?? { status: 'NOT_REGISTERED' };
    }
    return { status: voice?.status ?? 'NOT_REGISTERED' };
  }

  async clone(accountId: string, sample: VoiceSample): Promise<{ status: VoiceStatus }> {
    this.elevenLabs.requireApiKey();
    const reserved = await this.database.query(
      `INSERT INTO voice_clones (user_id, status) VALUES ($1, 'CREATING')
       ON CONFLICT (user_id) DO NOTHING`,
      [accountId],
    );
    if (!reserved.rowCount) {
      throw new ConflictException('A voice is already registered or being created');
    }

    let created: Awaited<ReturnType<ElevenLabsService['clone']>>;
    try {
      created = await this.elevenLabs.clone(accountId, sample);
    } catch (error) {
      // shortcut: ambiguous creation needs operator reconciliation before another attempt.
      if (
        error instanceof ElevenLabsRequestError &&
        error.upstreamStatus &&
        error.upstreamStatus >= 400 &&
        error.upstreamStatus < 500 &&
        error.upstreamStatus !== 408
      ) {
        await this.database.query(
          "DELETE FROM voice_clones WHERE user_id = $1 AND status = 'CREATING'",
          [accountId],
        );
        if (error.requiresPaidPlan) {
          throw new HttpException(
            'The ElevenLabs subscription does not include Instant Voice Cloning',
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      }
      throw error;
    }

    const status = created.requiresVerification ? 'VERIFICATION_REQUIRED' : 'READY';
    await this.database.query(
      'UPDATE voice_clones SET provider_voice_id = $2, status = $3 WHERE user_id = $1',
      [accountId, created.voiceId, status],
    );
    return { status };
  }

  private async readyVoiceId(accountId: string): Promise<string> {
    const voice = await this.find(accountId);
    if (voice?.status !== 'READY' || !voice.voiceId) {
      throw new ConflictException('No verified voice is available for this account');
    }
    return voice.voiceId;
  }

  async speech(accountId: string, text: string): Promise<Buffer> {
    return this.elevenLabs.speech(await this.readyVoiceId(accountId), text);
  }

  async streamSpeech(
    accountId: string,
    text: string,
    signal: AbortSignal,
    settings?: SpeechSettings,
  ) {
    return this.elevenLabs.streamSpeech(await this.readyVoiceId(accountId), text, signal, settings);
  }

  async delete(accountId: string): Promise<void> {
    const voice = await this.find(accountId);
    if (!voice) {
      return;
    }
    if (!voice.voiceId) {
      throw new ConflictException('Voice creation is awaiting reconciliation');
    }
    await this.elevenLabs.delete(voice.voiceId);
    await this.database.query(
      'DELETE FROM voice_clones WHERE user_id = $1 AND provider_voice_id = $2',
      [accountId, voice.voiceId],
    );
  }
}
