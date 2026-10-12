import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3Config } from '../config.ts';
import { assertValidKey } from './key.ts';
import { StorageNotFoundError } from './types.ts';
import type { Storage } from './types.ts';

// At most PART_SIZE * QUEUE_SIZE is held in memory at once (plus the read buffer).
// Object size ceiling: 10,000 parts * 8 MB ≈ 78 GB.
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  // A missing bucket is a configuration error and must not be hidden.
  if (e.name === 'NoSuchBucket') return false;
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Self-hosted S3 servers often reject the SDK's newer default checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config, client?: S3Client) {
    this.bucket = config.bucket;
    this.client = client ?? createS3Client(config);
  }

  async put(key: string, body: Readable, opts?: { contentType?: string }): Promise<{ size: number }> {
    assertValidKey(key);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(null, chunk);
      },
    });
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: counter, ContentType: opts?.contentType },
      partSize: PART_SIZE,
      queueSize: QUEUE_SIZE,
      leavePartsOnError: false,
    });
    // A source error reaches Upload through counter: pipeline destroys it with the same error.
    const piped = pipeline(body, counter).catch(() => {});
    try {
      // Upload.abort() does not fit: it rejects done() at once and sends AbortMultipartUpload in the background.
      // On an ordinary error done() waits for the multipart abort and only then rejects.
      await upload.done();
    } catch (err) {
      body.destroy();
      counter.destroy();
      throw err;
    }
    await piped;
    return { size };
  }

  async get(key: string): Promise<{ body: Readable; size: number }> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!(res.Body instanceof Readable)) throw new Error(`S3 returned no body for ${key}`);
      let size = res.ContentLength;
      if (size === undefined) {
        try {
          const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
          size = head.ContentLength ?? 0;
        } catch (err) {
          res.Body.destroy();
          throw err;
        }
      }
      return { body: res.Body, size };
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}
