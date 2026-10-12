import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import type { Stores } from '../db/types.ts';
import { VIEWS_DIR } from '../paths.ts';
import { createDriveRouter } from './routes.ts';
import { createDriveService, type DriveService } from './service.ts';
import { allNodes, MemoryStorage, MISSING_ID, setup, type TestUser } from './testing.ts';

const MAX = 1024;

let stores: Stores;
let storage: MemoryStorage;
let service: DriveService;
let alice: TestUser;
let bob: TestUser;
let admin: TestUser;
let current: TestUser;
let app: express.Express;
let silent = false;

beforeEach(async () => {
  ({ stores, storage, alice, bob, admin } = await setup());
  service = createDriveService({ stores, storage });
  current = alice;
  app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = current as typeof req.user;
    res.locals.user = current;
    res.locals.title = 'Emotion';
    next();
  });
  app.use('/drive', createDriveRouter({ stores, storage, config: { maxUploadBytes: MAX } }));
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (!silent) console.error(err);
    res.status(500).send('broken');
  };
  app.use(onError);
});

const as = (user: TestUser) => {
  current = user;
  return request(app);
};
const rows = () => allNodes(stores);

function putFile(user: TestUser, parentId: string | null, name: string, content: string | Buffer = 'data') {
  const key = `key-${storage.objects.size}`;
  const data = Buffer.from(content);
  storage.objects.set(key, data);
  return service.addFile(user, parentId, { name, storageKey: key, size: data.length, mime: null });
}

describe('browsing', () => {
  it('an empty disk shows a friendly placeholder', async () => {
    const res = await as(alice).get('/drive').expect(200);
    expect(res.text).toContain('Здесь пока пусто');
    expect(res.text).toContain('action="/drive/upload"');
    expect(res.text).toContain('<script src="/static/drive.js" defer>');
    expect(res.text).toContain('/static/drive.css');
  });

  it('shows entries, owner, size and breadcrumbs', async () => {
    const docs = await service.createFolder(bob, null, 'Документы');
    const sub = await service.createFolder(alice, docs.id, 'Вложенная');
    await putFile(bob, sub.id, 'отчёт.pdf', Buffer.alloc(1536));
    const res = await as(alice).get(`/drive/folder/${sub.id}`).expect(200);
    expect(res.text).toContain(`href="/drive/folder/${docs.id}">Документы</a>`);
    expect(res.text).toContain('отчёт.pdf');
    expect(res.text).toContain('1,5 КБ');
    expect(res.text).toContain('Bob');
    expect(res.text).toContain(`action="/drive/folder/${sub.id}/upload"`);
  });

  it('escapes names', async () => {
    await service.createFolder(alice, null, '<img src=x onerror=alert(1)>"\'');
    const res = await as(alice).get('/drive').expect(200);
    expect(res.text).not.toContain('<img');
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;&#34;&#39;');
  });

  it('the page has no inline styles or handlers (CSP)', async () => {
    const f = await service.createFolder(alice, null, 'Папка', true);
    await putFile(alice, null, 'a.txt');
    for (const url of ['/drive', `/drive/folder/${f.id}`]) {
      const res = await as(alice).get(url).expect(200);
      expect(res.text).not.toMatch(/\sstyle=|<style|\son[a-z]+="|<script(?![^>]*\ssrc=)/i);
    }
  });

  it("other people's private folders are listed for nobody, administrators included", async () => {
    await service.createFolder(alice, null, 'Общая-папка');
    await service.createFolder(alice, null, 'Тайна-Алисы', true);
    const mine = await as(alice).get('/drive').expect(200);
    expect(mine.text).toContain('Тайна-Алисы');
    for (const user of [bob, admin]) {
      const res = await as(user).get('/drive').expect(200);
      expect(res.text).toContain('Общая-папка');
      expect(res.text).not.toContain('Тайна-Алисы');
    }
  });

  it('inaccessible and missing nodes answer with the same 404', async () => {
    const p = await service.createFolder(alice, null, 'Тайна', true);
    const inner = await service.createFolder(alice, p.id, 'Внутри');
    const f = await putFile(alice, inner.id, 'секрет.txt');
    for (const user of [bob, admin]) {
      const missing = await as(user).get(`/drive/folder/${MISSING_ID}`).expect(404);
      for (const url of [`/drive/folder/${p.id}`, `/drive/folder/${inner.id}`]) {
        const res = await as(user).get(url).expect(404);
        expect(res.text).toBe(missing.text);
        expect(res.text).not.toContain('Тайна');
      }
      await as(user).get(`/drive/file/${f.id}`).expect(404);
      await as(user).post(`/drive/node/${f.id}/delete`).expect(404);
      await as(user).post(`/drive/node/${p.id}/rename`).type('form').send({ name: 'x' }).expect(404);
      await as(user).post(`/drive/node/${p.id}/privacy`).type('form').send({ private: '0' }).expect(404);
      await as(user).post(`/drive/folder/${p.id}/folder`).type('form').send({ name: 'x' }).expect(404);
      await as(user).post(`/drive/folder/${inner.id}/upload`).attach('files', Buffer.from('x'), 'x.txt').expect(404);
    }
    expect((await rows())).toHaveLength(3);
    expect(storage.objects.size).toBe(1);
    await as(alice).get(`/drive/folder/${inner.id}`).expect(200);
  });

  it('malformed ids are a 404', async () => {
    await as(alice).get('/drive/folder/abc').expect(404);
    await as(alice).get('/drive/folder/0').expect(404);
    await as(alice).get('/drive/file/1e3').expect(404);
  });

  it('flash messages come from a fixed list only', async () => {
    const ok = await as(alice).get('/drive?msg=created').expect(200);
    expect(ok.text).toContain('Папка создана');
    const err = await as(alice).get('/drive?err=name_taken').expect(200);
    expect(err.text).toContain('с таким именем здесь уже есть');
    const evil = await as(alice).get('/drive?msg=%3Cb%3Ehack&err=constructor').expect(200);
    expect(evil.text).not.toContain('hack');
    expect(evil.text).not.toContain('flash');
  });
});

describe('folders and actions', () => {
  it('creates a folder and returns to the same folder (PRG)', async () => {
    const res = await as(alice).post('/drive/folder').type('form').send({ name: 'Новая', private: '1' }).expect(303);
    expect(res.headers.location).toBe('/drive?msg=created');
    const [row] = await rows();
    expect(row).toMatchObject({ name: 'Новая', ownerId: alice.id });
    await as(bob).get(`/drive/folder/${row!.id}`).expect(404);

    const nested = await as(alice).post(`/drive/folder/${row!.id}/folder`).type('form').send({ name: 'Глубже' }).expect(303);
    expect(nested.headers.location).toBe(`/drive/folder/${row!.id}?msg=created`);
  });

  it('errors are shown as a flash message after the redirect', async () => {
    await service.createFolder(alice, null, 'Есть');
    const clash = await as(bob).post('/drive/folder').type('form').send({ name: 'есть' }).expect(303);
    expect(clash.headers.location).toBe('/drive?err=name_taken');
    const bad = await as(bob).post('/drive/folder').type('form').send({ name: 'a/b' }).expect(303);
    expect(bad.headers.location).toBe('/drive?err=bad_name');
    const empty = await as(bob).post('/drive/folder').expect(303);
    expect(empty.headers.location).toBe('/drive?err=bad_name');
    expect((await rows())).toHaveLength(1);
  });

  it('rename, privacy, delete', async () => {
    const dir = await service.createFolder(alice, null, 'Папка');
    const f = await putFile(alice, dir.id, 'a.txt');

    const forbidden = await as(bob).post(`/drive/node/${f.id}/rename`).type('form').send({ name: 'b.txt' }).expect(303);
    expect(forbidden.headers.location).toBe(`/drive/folder/${dir.id}?err=forbidden`);
    const renamed = await as(alice).post(`/drive/node/${f.id}/rename`).type('form').send({ name: 'b.txt' }).expect(303);
    expect(renamed.headers.location).toBe(`/drive/folder/${dir.id}?msg=renamed`);

    const notOwner = await as(admin).post(`/drive/node/${dir.id}/privacy`).type('form').send({ private: '1' }).expect(303);
    expect(notOwner.headers.location).toBe('/drive?err=not_owner');
    const closed = await as(alice).post(`/drive/node/${dir.id}/privacy`).type('form').send({ private: '1' }).expect(303);
    expect(closed.headers.location).toBe('/drive?msg=private_on');
    await as(admin).get(`/drive/file/${f.id}`).expect(404);
    await as(admin).post(`/drive/node/${dir.id}/delete`).expect(404);

    const deleted = await as(alice).post(`/drive/node/${dir.id}/delete`).expect(303);
    expect(deleted.headers.location).toBe('/drive?msg=deleted');
    expect((await rows())).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it("a folder with someone else's private folder inside cannot be deleted", async () => {
    const dir = await service.createFolder(alice, null, 'Общая');
    await service.createFolder(bob, dir.id, 'Личное Боба', true);
    const res = await as(admin).post(`/drive/node/${dir.id}/delete`).expect(303);
    expect(res.headers.location).toBe('/drive?err=has_hidden');
    expect((await rows())).toHaveLength(2);
  });

  it('mutations are POST only', async () => {
    const f = await putFile(alice, null, 'a.txt');
    await as(alice).get(`/drive/node/${f.id}/delete`).expect(404);
    expect((await rows())).toHaveLength(1);
  });
});

describe('upload', () => {
  it('uploads and downloads a file with a Cyrillic name', async () => {
    const dir = await service.createFolder(alice, null, 'Папка');
    const content = Buffer.from('Привет, мир! '.repeat(20));
    const up = await as(alice).post(`/drive/folder/${dir.id}/upload`).attach('files', content, 'Годовой отчёт №1.pdf').expect(303);
    expect(up.headers.location).toBe(`/drive/folder/${dir.id}?msg=uploaded`);

    const [, row] = await rows();
    expect(row).toMatchObject({ name: 'Годовой отчёт №1.pdf', parentId: dir.id, size: content.length, ownerId: alice.id });
    // The storage key is random and does not contain the file name.
    expect(row!.storageKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.objects.get(row!.storageKey!)).toEqual(content);

    const down = await as(bob).get(`/drive/file/${row!.id}`).buffer(true).parse(binary).expect(200);
    expect(down.body).toEqual(content);
    expect(down.headers['content-length']).toBe(String(content.length));
    expect(down.headers['content-type']).toBe('application/pdf');
    expect(down.headers['content-disposition']).toBe(
      `attachment; filename="_______ _____ _1.pdf"; filename*=UTF-8''${encodeURIComponent('Годовой отчёт №1.pdf')}`,
    );
    expect(down.headers['x-content-type-options']).toBe('nosniff');
  });

  it('several files at once; equal names get a suffix', async () => {
    await putFile(bob, null, 'отчёт.txt');
    const res = await as(alice)
      .post('/drive/upload')
      .set('Accept', 'application/json')
      .attach('files', Buffer.from('1'), 'отчёт.txt')
      .attach('files', Buffer.from('22'), 'отчёт.txt')
      .attach('files', Buffer.from('333'), 'другое.txt')
      .expect(200);
    expect(res.body).toEqual({ ok: true, uploaded: 3, errors: [], redirect: '/drive?msg=uploaded' });
    expect((await rows()).map((r) => r.name)).toEqual(['отчёт.txt', 'отчёт (2).txt', 'отчёт (3).txt', 'другое.txt']);
    expect(storage.objects.size).toBe(4);
  });

  it('a file exactly at the limit passes, a larger one is rejected and cleaned up', async () => {
    await as(alice).post('/drive/upload').attach('files', Buffer.alloc(MAX, 1), 'ровно.bin').expect(303);
    expect((await rows()).map((r) => r.name)).toEqual(['ровно.bin']);

    const res = await as(alice).post('/drive/upload').attach('files', Buffer.alloc(MAX + 1, 1), 'много.bin').expect(303);
    expect(res.headers.location).toBe('/drive?err=too_big');
    expect((await rows()).map((r) => r.name)).toEqual(['ровно.bin']);
    expect(storage.objects.size).toBe(1);
    const page = await as(alice).get(res.headers.location!).expect(200);
    expect(page.text).toContain('Файл больше допустимого размера (1 КБ)');
  });

  it('an oversized file does not block the others; JSON response for XHR', async () => {
    const res = await as(alice)
      .post('/drive/upload')
      .set('Accept', 'application/json')
      .attach('files', Buffer.alloc(MAX * 3, 1), 'большой.bin')
      .attach('files', Buffer.from('ok'), 'маленький.txt')
      .expect(413);
    expect(res.body).toEqual({
      ok: false,
      uploaded: 1,
      errors: ['Файл больше допустимого размера'],
      redirect: '/drive?msg=uploaded&err=too_big',
    });
    expect((await rows()).map((r) => r.name)).toEqual(['маленький.txt']);
    expect(storage.objects.size).toBe(1);
  });

  it('empty form and non-multipart body', async () => {
    const empty = await as(alice).post('/drive/upload').field('x', '1').expect(303);
    expect(empty.headers.location).toBe('/drive?err=no_files');
    await as(alice).post('/drive/upload').type('form').send({ a: '1' }).expect(400);
    expect((await rows())).toHaveLength(0);
  });

  it('storage failure: an error and nothing in the database', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    storage.failPut = true;
    const res = await as(alice)
      .post('/drive/upload')
      .set('Accept', 'application/json')
      .attach('files', Buffer.from('abc'), 'a.txt')
      .expect(500);
    expect(res.body.ok).toBe(false);
    expect((await rows())).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    spy.mockRestore();
  });

  it('database write failure: the object is removed from storage', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await service.createFolder(alice, null, 'Папка');
    // The folder disappears while the file is on its way to storage.
    const put = storage.put.bind(storage);
    storage.put = async (key, body) => {
      const result = await put(key, body);
      await stores.nodes.deleteSubtree(dir.id);
      return result;
    };
    const res = await as(alice).post(`/drive/folder/${dir.id}/upload`).attach('files', Buffer.from('abc'), 'a.txt').expect(303);
    expect(res.headers.location).toBe(`/drive/folder/${dir.id}?err=not_found`);
    expect((await rows())).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    spy.mockRestore();
  });

  it('a connection dropped mid-upload leaves neither a record nor an object', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const boundary = 'xxBOUNDARYxx';
      const req = http.request({
        port,
        host: '127.0.0.1',
        method: 'POST',
        path: '/drive/upload',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': 100000 },
      });
      req.on('error', () => {});
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="обрыв.bin"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n' +
          'x'.repeat(500),
      );
      await waitFor(() => storage.started === 1);
      req.destroy();
      await waitFor(() => storage.pending === 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(storage.objects.size).toBe(0);
      expect((await rows())).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('download', () => {
  it.each(['страница.html', 'картинка.svg', 'скрипт.js', 'x.xhtml', 'без-расширения'])(
    '%s is served as octet-stream and as an attachment only',
    async (name) => {
      const f = await putFile(alice, null, name, '<script>alert(1)</script>');
      for (const url of [`/drive/file/${f.id}`, `/drive/file/${f.id}?inline=1`]) {
        const res = await as(bob).get(url).buffer(true).parse(binary).expect(200);
        expect(res.headers['content-type']).toBe('application/octet-stream');
        expect(res.headers['content-disposition']).toMatch(/^attachment; /);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      }
    },
  );

  it('safe types: attachment by default, inline on request', async () => {
    const f = await putFile(alice, null, 'фото.PNG', 'png');
    const plain = await as(alice).get(`/drive/file/${f.id}`).expect(200);
    expect(plain.headers['content-type']).toBe('image/png');
    expect(plain.headers['content-disposition']).toBe(
      `attachment; filename="____.PNG"; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE.PNG`,
    );
    const inline = await as(alice).get(`/drive/file/${f.id}?inline=1`).expect(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline; /);
  });

  it('renaming to .html does not make the file executable in the browser', async () => {
    const f = await putFile(alice, null, 'a.txt', '<script>alert(1)</script>');
    await as(alice).post(`/drive/node/${f.id}/rename`).type('form').send({ name: 'a.html' }).expect(303);
    const res = await as(alice).get(`/drive/file/${f.id}?inline=1`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment; /);
  });

  it('a folder cannot be downloaded; a file without content is a 404', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await service.createFolder(alice, null, 'Папка');
    const f = await putFile(alice, null, 'a.txt');
    storage.objects.clear();
    await as(alice).get(`/drive/file/${dir.id}`).expect(404);
    await as(alice).get(`/drive/file/${f.id}`).expect(404);
    spy.mockRestore();
  });

  it('HEAD returns headers without a body', async () => {
    const f = await putFile(alice, null, 'a.txt', 'hello');
    const res = await as(alice).head(`/drive/file/${f.id}`).expect(200);
    expect(res.headers['content-length']).toBe('5');
  });

  it('a storage failure after the headers were sent cuts the response instead of hanging it', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const f = await putFile(alice, null, 'a.bin');
    let destroyed = false;
    storage.get = async () => {
      const body = new Readable({
        read() {
          this.push(Buffer.alloc(10));
          setImmediate(() => this.destroy(new Error('network down')));
        },
      });
      body.on('close', () => {
        destroyed = true;
      });
      return { body, size: 1000 };
    };
    await expect(as(alice).get(`/drive/file/${f.id}`).buffer(true).parse(binary)).rejects.toThrow();
    expect(destroyed).toBe(true);
    spy.mockRestore();
  });

  it('when the client disconnects the storage stream is destroyed', async () => {
    const f = await putFile(alice, null, 'a.bin');
    let destroyed = false;
    storage.get = async () => {
      const body = new Readable({
        read() {
          setTimeout(() => this.push(Buffer.alloc(1024)), 5);
        },
      });
      body.on('close', () => {
        destroyed = true;
      });
      return { body, size: 1024 * 1024 * 1024 };
    };
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve) => {
        const req = http.get({ port, host: '127.0.0.1', path: `/drive/file/${f.id}` }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => {});
      });
      await waitFor(() => destroyed);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition was not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
