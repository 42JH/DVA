import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Environment } from '../../config/environment';
import { RecordingProcessingError } from './recording-retry';

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
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RecordingProcessingError('SOURCE_NOT_ALLOWED', false);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !allowedHosts.includes(url.hostname)
  )
    throw new RecordingProcessingError('SOURCE_NOT_ALLOWED', false);
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

  async erase(key: string): Promise<void> {
    // shortcut: 녹취는 한 버킷을 사용한다. 버킷 분리 전 객체별 버킷 참조를 저장한다.
    const bucket = this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
    if (!bucket) throw new Error('recording_storage_not_configured');
    const abortSignal = AbortSignal.timeout(120000);
    // A plain DELETE only adds a marker in a versioned bucket.
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal,
    });
    for (let page = 0; page < 100; page++) {
      const listed = await this.s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 1000 }),
        { abortSignal },
      );
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((object) => object.Key === key)
        .map((object) => ({ Key: key, VersionId: object.VersionId }));
      if (!objects.length) {
        if (listed.IsTruncated) throw new Error('recording_version_listing_incomplete');
        return;
      }
      const deleted = await this.s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        { abortSignal },
      );
      if (deleted.Errors?.length) throw new Error('recording_version_delete_failed');
    }
    throw new Error('recording_version_delete_limit');
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
        throw new RecordingProcessingError('OBJECT_CONFLICT', false);
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
      )
        return false;
      if (error instanceof RecordingProcessingError) throw error;
      throw new RecordingProcessingError('STORAGE_UNAVAILABLE');
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
                return callback(new RecordingProcessingError('ADDRESS_NOT_PUBLIC', false), '', 4);
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
            const status = response.statusCode ?? 0;
            if (status === 401 || status === 403)
              throw new RecordingProcessingError('SOURCE_ACCESS_DENIED');
            if (status === 404 || status === 410)
              throw new RecordingProcessingError('SOURCE_NOT_FOUND');
            if (status === 429) throw new RecordingProcessingError('SOURCE_RATE_LIMITED');
            if (status >= 500) throw new RecordingProcessingError('SOURCE_UNAVAILABLE');
            if (status !== 200) throw new RecordingProcessingError('DOWNLOAD_REJECTED', false);
            if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream')
              throw new RecordingProcessingError('CONTENT_TYPE_REJECTED', false);
            const length = response.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
              throw new RecordingProcessingError('TOO_LARGE', false);
            const chunks: Buffer[] = [];
            const output =
              length !== undefined && Number(length) >= 8 * 1024 * 1024
                ? Buffer.alloc(Number(length))
                : null;
            let size = 0;
            for await (const chunk of response) {
              const bytes = output && Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length;
              if (size > MAX_BYTES) throw new RecordingProcessingError('TOO_LARGE', false);
              if (output) {
                if (size > output.length) throw new RecordingProcessingError('DOWNLOAD_INCOMPLETE');
                bytes.copy(output, size - bytes.length);
              } else chunks.push(bytes);
            }
            if (!size || (length !== undefined && Number(length) !== size))
              throw new RecordingProcessingError('DOWNLOAD_INCOMPLETE');
            resolve({ bytes: output ?? Buffer.concat(chunks, size), contentType });
          } catch (error) {
            response.destroy();
            reject(
              error instanceof RecordingProcessingError
                ? error
                : new RecordingProcessingError('DOWNLOAD_UNAVAILABLE'),
            );
          }
        },
      );
      request.on('error', (error) =>
        reject(
          error instanceof RecordingProcessingError
            ? error
            : new RecordingProcessingError('DOWNLOAD_UNAVAILABLE'),
        ),
      );
    });
  }

  async save(recordingId: string, callId: number, source: string): Promise<string> {
    const bucket = this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
    if (!bucket) throw new RecordingProcessingError('STORAGE_UNAVAILABLE');
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
        throw new RecordingProcessingError('STORAGE_UNAVAILABLE');
    }
    return key;
  }

  onApplicationShutdown() {
    this.s3.destroy();
  }
}
