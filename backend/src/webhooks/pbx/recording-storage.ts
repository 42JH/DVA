import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Environment } from '../../config/environment';

const MAX_BYTES = 32 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');

export function publicRecordingAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, '');
  const family = isIP(normalized);
  return family !== 0 && !blocked.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

export function recordingSource(value: string, allowedHosts: string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !allowedHosts.includes(url.hostname)
  )
    throw new Error('recording_source_not_allowed');
  return url;
}

@Injectable()
export class RecordingStorage implements OnApplicationShutdown {
  private readonly s3: S3Client;

  constructor(private readonly config: ConfigService<Environment, true>) {
    this.s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 },
    });
  }

  get configured(): boolean {
    return !!this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
  }

  private async stored(bucket: string, key: string, callId: number): Promise<boolean> {
    try {
      const object = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(15000),
      });
      if (
        object.Metadata?.['call-session-seq'] !== String(callId) ||
        !object.ContentLength ||
        object.ContentLength > MAX_BYTES
      )
        throw new Error('recording_object_conflict');
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
      )
        return false;
      throw error;
    }
  }

  private download(url: URL): Promise<{ bytes: Buffer; contentType: string }> {
    return new Promise((resolve, reject) => {
      const request = get(
        url,
        {
          signal: AbortSignal.timeout(60000),
          // 검증한 DNS 응답을 실제 연결에 사용해 재조회에 의한 내부 주소 우회를 막는다.
          lookup: (hostname, options, callback) => {
            lookup(hostname, { all: true }, (error, addresses) => {
              if (error) return callback(error, '', 4);
              if (
                !addresses.length ||
                addresses.some((entry) => !publicRecordingAddress(entry.address))
              )
                return callback(new Error('recording_address_not_public'), '', 4);
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0].address, addresses[0].family);
            });
          },
        },
        async (response) => {
          try {
            const contentType = (response.headers['content-type'] ?? '')
              .split(';')[0]
              .trim()
              .toLowerCase();
            if (
              response.statusCode !== 200 ||
              (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream')
            )
              throw new Error('recording_download_rejected');
            const length = response.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
              throw new Error('recording_too_large');
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > MAX_BYTES) throw new Error('recording_too_large');
              chunks.push(bytes);
            }
            if (!size || (length !== undefined && Number(length) !== size))
              throw new Error('recording_download_incomplete');
            resolve({ bytes: Buffer.concat(chunks, size), contentType });
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      request.on('error', reject);
    });
  }

  async save(recordingId: string, callId: number, source: string): Promise<string> {
    const bucket = this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
    if (!bucket) throw new Error('recording_storage_not_configured');
    const key = `recordings/${createHash('sha256').update(recordingId).digest('hex')}`;
    // DB 저장 전에 중단되었어도 기존 객체를 재사용한다. 만료된 원본 URL을 다시 받을 필요가 없다.
    if (await this.stored(bucket, key, callId)) return key;
    const url = recordingSource(
      source,
      this.config.get('RECORDING_ALLOWED_HOSTS', { infer: true }),
    );
    const { bytes, contentType } = await this.download(url);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.length,
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
          IfNoneMatch: '*',
          Metadata: { 'call-session-seq': String(callId) },
        }),
        { abortSignal: AbortSignal.timeout(60000) },
      );
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 412 &&
        (await this.stored(bucket, key, callId))
      ))
        throw error;
    }
    return key;
  }

  onApplicationShutdown() {
    this.s3.destroy();
  }
}
