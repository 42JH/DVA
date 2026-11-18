import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestComplaintFaqs } from '@dva/events/call-read-references.cjs';
import type { Environment } from '../../config/environment';

@Injectable()
export class ComplaintFaqClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  read() {
    return requestComplaintFaqs(
      this.config.get('OPERATIONS_URL', { infer: true }) +
        '/internal/call-read-references/complaint-faqs',
      this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
    );
  }
}
