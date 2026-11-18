import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { FaqChange } from './faq-change';

@Injectable()
export class AiFaqClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async notify(change: FaqChange): Promise<void> {
    const token = this.config.get('AI_FAQ_TOKEN', { infer: true });
    if (!token) throw new Error('FAQ notification is not configured');
    const response = await fetch(
      this.config.get('AI_AGENT_URL', { infer: true }) + '/internal/faqs/refresh',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: change.eventId,
          operation: change.operation,
          faqEntrySeqs: change.faqEntrySeqs,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      },
    );
    await response.body?.cancel();
    if (response.status !== 202) throw new Error('FAQ notification was not accepted');
  }
}
