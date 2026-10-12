import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { S3Config } from '../config.ts';
import { InvalidStorageKeyError } from './key.ts';
import { S3Storage } from './s3.ts';
import { failingStream, readAll } from './testutil.ts';
import { StorageNotFoundError } from './types.ts';

const baseConfig: S3Config = {
  endpoint: 'http://127.0.0.1:1',
  region: 'us-east-1',
  bucket: 'bkt',
  forcePathStyle: true,
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
};

function fakeClient(send: (command: unknown) => Promise<unknown>) {
  const calls: unknown[] = [];
  const client = {
    send: (command: unknown) => {
      calls.push(command);
      return send(command);
    },
  } as unknown as S3Client;
  return { client, calls };
}

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

describe('S3Storage with a fake client', () => {
  test('get returns body and ContentLength', async () => {
    const { client, calls } = fakeClient(async () => ({
      Body: Readable.from([Buffer.from('hello')]),
      ContentLength: 5,
    }));
    const { body, size } = await new S3Storage(baseConfig, client).get('k1');
    expect(size).toBe(5);
    expect((await readAll(body)).toString()).toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(GetObjectCommand);
    expect((calls[0] as GetObjectCommand).input).toEqual({ Bucket: 'bkt', Key: 'k1' });
  });

  test('get falls back to HEAD when ContentLength is absent', async () => {
    const { client, calls } = fakeClient(async (command) =>
      command instanceof HeadObjectCommand
        ? { ContentLength: 3 }
        : { Body: Readable.from([Buffer.from('abc')]) },
    );
    expect((await new S3Storage(baseConfig, client).get('k1')).size).toBe(3);
    expect(calls).toHaveLength(2);
  });

  test.each([
    ['NoSuchKey', 404],
    ['NotFound', 404],
    ['UnknownError', 404],
  ])('get maps %s/%d to StorageNotFoundError', async (name, status) => {
    const { client } = fakeClient(async () => {
      throw s3Error(name, status);
    });
    await expect(new S3Storage(baseConfig, client).get('k1')).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  test.each([
    ['NoSuchBucket', 404],
    ['AccessDenied', 403],
    ['InternalError', 500],
  ])('get passes %s through', async (name, status) => {
    const { client } = fakeClient(async () => {
      throw s3Error(name, status);
    });
    const err = await new S3Storage(baseConfig, client).get('k1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StorageNotFoundError);
    expect((err as Error).name).toBe(name);
  });

  test('delete sends DeleteObject and ignores a missing key', async () => {
    const ok = fakeClient(async () => ({}));
    await new S3Storage(baseConfig, ok.client).delete('k1');
    expect(ok.calls[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((ok.calls[0] as DeleteObjectCommand).input).toEqual({ Bucket: 'bkt', Key: 'k1' });

    const missing = fakeClient(async () => {
      throw s3Error('NoSuchKey', 404);
    });
    await expect(new S3Storage(baseConfig, missing.client).delete('k1')).resolves.toBeUndefined();

    const denied = fakeClient(async () => {
      throw s3Error('AccessDenied', 403);
    });
    await expect(new S3Storage(baseConfig, denied.client).delete('k1')).rejects.toThrow('AccessDenied');
  });

  test('invalid keys never reach the client', async () => {
    const { client, calls } = fakeClient(async () => ({}));
    const storage = new S3Storage(baseConfig, client);
    await expect(storage.get('../x')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.delete('a//b')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.put('', Readable.from([]))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect(calls).toEqual([]);
  });
});

// A minimal in-memory S3 server: exercises the real SDK (path-style, multipart; signatures are not verified).
describe('S3Storage against an in-process fake S3 server', () => {
  const objects = new Map<string, { data: Buffer; contentType?: string }>();
  const uploads = new Map<string, { contentType?: string; parts: Map<number, Buffer> }>();
  const log: string[] = [];
  let server: http.Server;
  let storage: S3Storage;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = url.searchParams;
      const objectPath = decodeURIComponent(url.pathname);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const data = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      const uploadId = q.get('uploadId');
      const xml = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
      };
      const encodings = `${req.headers['content-encoding'] ?? ''}|${req.headers['x-amz-content-sha256'] ?? ''}`;
      if (encodings.includes('aws-chunked') || encodings.includes('STREAMING')) {
        log.push('chunked-encoding');
      }

      if (req.method === 'POST' && q.has('uploads')) {
        const id = `up${uploads.size + 1}-${Date.now()}`;
        uploads.set(id, { contentType, parts: new Map() });
        log.push('create');
        return xml(200, `<InitiateMultipartUploadResult><Bucket>bkt</Bucket><Key>k</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && uploadId) {
        uploads.get(uploadId)?.parts.set(Number(q.get('partNumber')), data);
        log.push('part');
        res.writeHead(200, { etag: `"part${q.get('partNumber')}"` });
        return res.end();
      }
      if (req.method === 'POST' && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload) return xml(404, '<Error><Code>NoSuchUpload</Code></Error>');
        const parts = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map((p) => p[1]);
        objects.set(objectPath, { data: Buffer.concat(parts), contentType: upload.contentType });
        uploads.delete(uploadId);
        log.push('complete');
        return xml(200, '<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
      }
      if (req.method === 'DELETE' && uploadId) {
        uploads.delete(uploadId);
        log.push('abort');
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'PUT') {
        objects.set(objectPath, { data, contentType });
        log.push('putObject');
        res.writeHead(200, { etag: '"single"' });
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const object = objects.get(objectPath);
        if (!object) {
          return xml(404, '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
        }
        res.writeHead(200, { 'content-length': object.data.length, etag: '"x"' });
        return res.end(req.method === 'GET' ? object.data : undefined);
      }
      if (req.method === 'DELETE') {
        objects.delete(objectPath);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(400);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    storage = new S3Storage({ ...baseConfig, endpoint: `http://127.0.0.1:${port}` });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    objects.clear();
    uploads.clear();
    log.length = 0;
  });

  test('small put uses path-style addressing, reports size and content type', async () => {
    const result = await storage.put('dir/small', Readable.from([Buffer.from('hel'), Buffer.from('lo')]), {
      contentType: 'text/plain',
    });
    expect(result).toEqual({ size: 5 });
    expect(objects.get('/bkt/dir/small')).toEqual({ data: Buffer.from('hello'), contentType: 'text/plain' });
    expect(log).toEqual(['putObject']);

    const { body, size } = await storage.get('dir/small');
    expect(size).toBe(5);
    expect((await readAll(body)).toString()).toBe('hello');
  });

  test('empty put', async () => {
    expect(await storage.put('empty', Readable.from([]))).toEqual({ size: 0 });
    expect(objects.get('/bkt/empty')?.data.length).toBe(0);
  });

  test('large put streams as multipart without aws-chunked encoding', async () => {
    const chunk = Buffer.alloc(1024 * 1024);
    const total = 19;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < total; i++) yield Buffer.from(chunk.fill(i));
      })(),
    );
    const { size } = await storage.put('big', source);
    expect(size).toBe(total * chunk.length);
    const stored = objects.get('/bkt/big')?.data;
    expect(stored?.length).toBe(size);
    expect(stored?.[0]).toBe(0);
    expect(stored?.[size - 1]).toBe(total - 1);
    expect(log).toEqual(['create', 'part', 'part', 'part', 'complete']);
    expect(uploads.size).toBe(0);
  });

  test('source failure mid-upload aborts the multipart upload and stores nothing', async () => {
    const mb6 = Buffer.alloc(6 * 1024 * 1024);
    const body = failingStream([mb6, mb6, mb6], new Error('client went away'));
    await expect(storage.put('broken', body)).rejects.toThrow('client went away');
    expect(objects.size).toBe(0);
    expect(uploads.size).toBe(0);
    expect(log).toContain('create');
    expect(log).toContain('abort');
    expect(log).not.toContain('complete');
  });

  test('source failure before the first part stores nothing', async () => {
    const body = failingStream([Buffer.from('tiny')], new Error('boom'));
    await expect(storage.put('broken', body)).rejects.toThrow('boom');
    expect(objects.size).toBe(0);
    expect(log).toEqual([]);
  });

  test('get of a missing key throws StorageNotFoundError; delete is idempotent', async () => {
    await expect(storage.get('missing')).rejects.toBeInstanceOf(StorageNotFoundError);
    await storage.put('k1', Readable.from([Buffer.from('x')]));
    await storage.delete('k1');
    expect(objects.size).toBe(0);
    await expect(storage.delete('k1')).resolves.toBeUndefined();
  });
});
