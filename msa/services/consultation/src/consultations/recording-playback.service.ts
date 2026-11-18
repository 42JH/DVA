import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Environment } from '../config/environment';
import { RecordingDto } from './dto/call-response.dto';

@Injectable()
export class RecordingPlaybackService implements OnApplicationShutdown {
  private readonly s3: S3Client;

  constructor(private readonly config: ConfigService<Environment, true>) {
    this.s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 },
    });
  }

  async create(
    objectKey: string,
  ): Promise<Pick<RecordingDto, 'url' | 'expiresAt' | 'playbackError'>> {
    const bucket = this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
    if (!bucket)
      return {
        url: null,
        expiresAt: null,
        playbackError: 'DEPENDENCY_UNAVAILABLE',
      };

    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
        {
          abortSignal: AbortSignal.timeout(10000),
        },
      );
      const credentials = await this.s3.config.credentials();
      const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
      const expiresIn = Math.min(
        300,
        credentials.expiration
          ? Math.floor(
              (credentials.expiration.getTime() - signingDate.getTime()) / 1000,
            )
          : 300,
      );
      if (expiresIn < 1) throw new Error('recording_credentials_expired');

      // 같은 자격 증명으로 서명과 만료 시각을 계산해 중간 갱신으로 인한 불일치를 막는다.
      const signer = new S3Client({
        region: await this.s3.config.region(),
        credentials,
      });
      try {
        const url = await getSignedUrl(
          signer,
          new GetObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            ResponseCacheControl: 'no-store',
          }),
          { signingDate, expiresIn },
        );
        return {
          url,
          expiresAt: new Date(signingDate.getTime() + expiresIn * 1000),
          playbackError: null,
        };
      } finally {
        signer.destroy();
      }
    } catch (error: unknown) {
      const missing =
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404;
      return {
        url: null,
        expiresAt: null,
        playbackError: missing ? 'NOT_FOUND' : 'DEPENDENCY_UNAVAILABLE',
      };
    }
  }

  onApplicationShutdown() {
    this.s3.destroy();
  }
}
