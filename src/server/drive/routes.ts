import { randomUUID } from 'node:crypto';
import { pipeline, type Readable } from 'node:stream';
import busboy from 'busboy';
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import type { Config } from '../config.ts';
import type { Stores } from '../db/types.ts';
import type { Storage } from '../storage/types.ts';
import { DriveError, errorStatus, errorText, messageText, type ErrorCode, type MessageCode } from './errors.ts';
import { contentDisposition, formatDate, formatSize, inlineType, toIso } from './format.ts';
import { canManage, createDriveService } from './service.ts';

export interface DriveDeps {
  stores: Stores;
  storage: Storage;
  config: Pick<Config, 'maxUploadBytes'>;
}

const MAX_FILES_PER_UPLOAD = 200;

function parseId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{24}$/.test(raw)) throw new DriveError('not_found');
  return raw;
}

function wantsJson(req: Request): boolean {
  return (req.get('accept') ?? '').includes('application/json');
}

export function createDriveRouter(deps: DriveDeps): Router {
  const { storage, config } = deps;
  const service = createDriveService(deps);
  const router = Router();

  const viewer = (req: Request) => {
    if (!req.user) throw new DriveError('not_found');
    return req.user;
  };

  const folderUrl = (req: Request, folderId: string | null, flash?: { msg?: MessageCode; err?: ErrorCode }) => {
    const query = new URLSearchParams();
    if (flash?.msg) query.set('msg', flash.msg);
    if (flash?.err) query.set('err', flash.err);
    const qs = query.size ? `?${query}` : '';
    return `${req.baseUrl}${folderId === null ? '' : `/folder/${folderId}`}${qs}` || '/';
  };

  // A mutation following POST → redirect → GET. Errors other than 404 are shown as a
  // flash message in the folder we return to; 404 goes to the shared handler.
  const mutate = async (
    req: Request,
    res: Response,
    backTo: string | null,
    action: () => MessageCode | Promise<MessageCode>,
  ) => {
    try {
      const msg = await action();
      res.redirect(303, folderUrl(req, backTo, { msg }));
    } catch (err) {
      if (!(err instanceof DriveError) || err.status === 404) throw err;
      res.redirect(303, folderUrl(req, backTo, { err: err.code }));
    }
  };

  // --- browsing ---

  const showFolder = async (req: Request, res: Response, folderId: string | null) => {
    const user = viewer(req);
    const listing = await service.list(user, folderId);
    let flashErr = errorText(req.query.err);
    if (flashErr && req.query.err === 'too_big') flashErr += ` (${formatSize(config.maxUploadBytes)})`;
    res.render('drive', {
      title: listing.folder ? `${listing.folder.name} — Диск` : 'Диск',
      styles: ['/static/drive.css'],
      user,
      base: req.baseUrl,
      folder: listing.folder,
      path: listing.path,
      entries: listing.entries,
      // Privacy is inherited: one private folder on the path is enough.
      insidePrivate: listing.path.some((n) => n.isPrivate),
      flashOk: messageText(req.query.msg),
      flashErr,
      maxUpload: formatSize(config.maxUploadBytes),
      canManage: (node: Parameters<typeof canManage>[0]) => canManage(node, user),
      formatSize,
      formatDate,
      toIso,
      inlineType,
    });
  };

  router.get('/', (req, res) => showFolder(req, res, null));
  router.get('/folder/:id', (req, res) => showFolder(req, res, parseId(req.params.id)));

  // --- download ---

  router.get('/file/:id', async (req, res) => {
    const { node, body, size } = await service.openFile(viewer(req), parseId(req.params.id));
    const type = inlineType(node.name);
    res.set({
      'Content-Type': type ?? 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(node.name, type !== null && req.query.inline === '1'),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    });
    if (req.method === 'HEAD') {
      body.destroy();
      res.end();
      return;
    }
    // pipeline destroys the storage stream if the client goes away, and cuts the response
    // short if storage fails after the headers were sent.
    pipeline(body, res, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`Failed while sending file ${node.id}:`, err);
      }
    });
  });

  // --- folders ---

  const createFolder = async (req: Request, res: Response, parentId: string | null) => {
    const user = viewer(req);
    await service.requireFolder(user, parentId);
    return mutate(req, res, parentId, async () => {
      await service.createFolder(user, parentId, req.body?.name, req.body?.private === '1');
      return 'created' as const;
    });
  };
  router.post('/folder', (req, res) => createFolder(req, res, null));
  router.post('/folder/:id/folder', (req, res) => createFolder(req, res, parseId(req.params.id)));

  // --- node actions ---

  router.post('/node/:id/rename', async (req, res) => {
    const user = viewer(req);
    const { node } = await service.get(user, parseId(req.params.id));
    return mutate(req, res, node.parentId, async () => {
      await service.rename(user, node.id, req.body?.name);
      return 'renamed' as const;
    });
  });

  router.post('/node/:id/privacy', async (req, res) => {
    const user = viewer(req);
    const { node } = await service.get(user, parseId(req.params.id));
    const makePrivate = req.body?.private === '1';
    return mutate(req, res, node.parentId, async (): Promise<MessageCode> => {
      await service.setPrivate(user, node.id, makePrivate);
      return makePrivate ? 'private_on' : 'private_off';
    });
  });

  router.post('/node/:id/delete', async (req, res) => {
    const user = viewer(req);
    const { node } = await service.get(user, parseId(req.params.id));
    return mutate(req, res, node.parentId, async () => {
      await service.remove(user, node.id);
      return 'deleted' as const;
    });
  });

  // --- upload ---

  // Files stream from the request straight into storage: nothing piles up in memory or
  // in temp files. The folder comes from the URL, so it is known before the body is parsed.
  const upload = async (req: Request, res: Response, folderId: string | null) => {
    const user = viewer(req);
    await service.requireFolder(user, folderId);

    // busboy also handles urlencoded bodies; only files are wanted here.
    if (!/^multipart\/form-data\b/i.test(req.get('content-type') ?? '')) throw new DriveError('bad_request');
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        // busboy flags a file as truncated at exactly the limit, hence the +1.
        limits: { fileSize: config.maxUploadBytes + 1, files: MAX_FILES_PER_UPLOAD, fields: 20 },
      });
    } catch {
      throw new DriveError('bad_request');
    }

    const tasks: Promise<void>[] = [];
    const errors = new Set<ErrorCode>();
    let uploaded = 0;
    let aborted = false; // the client dropped the connection: nobody to answer
    let stopped = false; // body parsing was cut short
    // Files of one request are registered one at a time so that equal names get distinct suffixes.
    let registering: Promise<unknown> = Promise.resolve();
    let finished = false;

    const discard = async (key: string) => {
      try {
        await storage.delete(key);
      } catch (err) {
        console.error(`Failed to delete object ${key}:`, err);
      }
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      await Promise.allSettled(tasks);
      if (aborted || res.headersSent) return;
      if (uploaded === 0 && errors.size === 0) errors.add('no_files');
      const codes = [...errors];
      const redirect = folderUrl(req, folderId, { msg: uploaded > 0 ? 'uploaded' : undefined, err: codes[0] });
      if (wantsJson(req)) {
        res.status(codes.length ? Math.max(...codes.map(errorStatus)) : 200).json({
          ok: codes.length === 0,
          uploaded,
          errors: codes.map((code) => errorText(code)),
          redirect,
        });
      } else {
        res.redirect(303, redirect);
      }
    };

    // Early stop: the rest of the body is not parsed and the unfinished file gets an error.
    const stop = (code?: ErrorCode) => {
      if (stopped) return;
      stopped = true;
      if (code) errors.add(code);
      req.unpipe(parser);
      parser.destroy(new Error('Upload interrupted'));
      if (!aborted) {
        res.set('Connection', 'close');
        req.resume();
      }
      finish().catch((err) => console.error('Failed to finish the upload:', err));
    };

    const storeFile = async (stream: Readable & { truncated?: boolean }, info: busboy.FileInfo) => {
      const key = randomUUID(); // the key is unrelated to the file name
      let tooBig = false;
      stream.on('limit', () => {
        tooBig = true;
      });
      try {
        const { size } = await storage.put(key, stream, { contentType: info.mimeType });
        if (aborted || stopped) return await discard(key);
        if (tooBig || stream.truncated) {
          errors.add('too_big');
          return await discard(key);
        }
        try {
          const file = { name: info.filename ?? '', storageKey: key, size, mime: info.mimeType || null };
          const added = registering.then(() => service.addFile(user, folderId, file));
          registering = added.catch(() => {});
          await added;
          uploaded++;
        } catch (err) {
          await discard(key);
          if (err instanceof DriveError) errors.add(err.code);
          else {
            console.error('Failed to record the file in the database:', err);
            errors.add('upload_failed');
          }
        }
      } catch (err) {
        // Storage should leave no partial objects, but deleting a missing key is harmless.
        await discard(key);
        if (!aborted && !stopped) {
          console.error('Storage error during upload:', err);
          stop('upload_failed');
        }
      }
    };

    parser.on('file', (_field, stream, info) => {
      // Browsers send an empty file input as a part without a name.
      if (!info.filename) return void stream.resume();
      tasks.push(storeFile(stream, info));
    });
    parser.on('filesLimit', () => errors.add('too_many'));
    parser.on('error', () => stop('bad_request'));
    parser.on('close', () => {
      finish().catch((err) => console.error('Failed to finish the upload:', err));
    });

    req.on('error', () => {});
    req.on('close', () => {
      if (req.complete || finished) return;
      aborted = true;
      stop();
    });
    req.pipe(parser);
  };
  router.post('/upload', (req, res) => upload(req, res, null));
  router.post('/folder/:id/upload', (req, res) => upload(req, res, parseId(req.params.id)));

  // Drive errors are rendered here: the app-level handler knows nothing about DriveError.
  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (!(err instanceof DriveError)) return next(err);
    if (res.headersSent) return void res.destroy();
    if (err.status >= 500) console.error(err);
    if (wantsJson(req)) return void res.status(err.status).json({ ok: false, errors: [err.message] });
    res.status(err.status).render('error', { title: `Ошибка ${err.status}`, status: err.status, message: err.message });
  };
  router.use(onError);

  return router;
}
