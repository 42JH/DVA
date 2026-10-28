import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { ConsultationsRepository } from './consultations.repository';
import { PlaybackDto } from './dto/playback.dto';

@Injectable()
export class RecordingPlaybackService implements OnApplicationShutdown {
  private readonly s3: S3Client;

  constructor(
    private readonly repository: ConsultationsRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {
    this.s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 },
    });
  }

  async create(id: number): Promise<PlaybackDto> {
    const recording = await this.repository.findRecording(id);
    if (!recording) throw new ApiException(404, 'NOT_FOUND', '녹취 기록을 찾을 수 없습니다.');
    const bucket = this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
    if (!bucket)
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '녹취 저장소가 설정되지 않았습니다.');

    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: recording.objectKey }), {
        abortSignal: AbortSignal.timeout(10000),
      });
      const credentials = await this.s3.config.credentials();
      const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
      const expiresIn = Math.min(
        300,
        credentials.expiration
          ? Math.floor((credentials.expiration.getTime() - signingDate.getTime()) / 1000)
          : 300,
      );
      if (expiresIn < 1) throw new Error('recording_credentials_expired');

      // 같은 자격 증명으로 서명과 만료 시각을 계산해 중간 갱신으로 인한 불일치를 막는다.
      const signer = new S3Client({ region: await this.s3.config.region(), credentials });
      try {
        const url = await getSignedUrl(
          signer,
          new GetObjectCommand({
            Bucket: bucket,
            Key: recording.objectKey,
            ResponseCacheControl: 'no-store',
          }),
          { signingDate, expiresIn },
        );
        return { url, expiresAt: new Date(signingDate.getTime() + expiresIn * 1000) };
      } finally {
        signer.destroy();
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
      )
        throw new ApiException(404, 'NOT_FOUND', '녹취 파일을 찾을 수 없습니다.');
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '녹취 재생 URL을 발급할 수 없습니다.');
    }
  }

  onApplicationShutdown() {
    this.s3.destroy();
  }
}
