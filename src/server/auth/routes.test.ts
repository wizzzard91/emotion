import express from 'express';
import request from 'supertest';
import type { AppDeps } from '../app.ts';
import { createMemoryStores } from '../db/memory.ts';
import { VIEWS_DIR } from '../paths.ts';
import { folderRecord, testConfig } from '../testing.ts';
import { createAuthRouter, createLimiter, loadUser, parseCookies, requireAuth, safeNext } from './routes.ts';
import { getSessionUser } from './sessions.ts';
import { createUser } from './users.ts';

const MISSING_ID = 'f'.repeat(24);

const ADMIN = { login: 'anna', name: 'Анна <Админ>', password: 'admin-password', isAdmin: true };
const MEMBER = { login: 'boris', name: 'Борис', password: 'member-password', isAdmin: false };

// A minimal app instead of app.ts, which would drag in the drive and storage.
async function setup(env: NodeJS.ProcessEnv = {}) {
  const stores = createMemoryStores();
  const deps = { stores, config: testConfig(env), storage: undefined as never } as AppDeps;
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  app.use(express.urlencoded({ extended: false }));
  app.use(loadUser(deps));
  app.use(createAuthRouter(deps));
  app.get('/drive/folder', requireAuth, (req, res) => void res.send(`привет, ${req.user!.login}`));
  app.post('/drive/folder', requireAuth, (_req, res) => void res.send('ok'));
  const admin = await createUser(stores, ADMIN);
  const member = await createUser(stores, MEMBER);
  return { app, stores, admin, member };
}

type App = Awaited<ReturnType<typeof setup>>['app'];

function post(app: App, url: string, body: Record<string, string | boolean>, cookie?: string) {
  const req = request(app).post(url).type('form');
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
}

function setCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.[0] ?? '';
}

/** Logs in and returns the value for the Cookie header. */
async function login(app: App, who: { login: string; password: string }): Promise<string> {
  const res = await post(app, '/login', who);
  expect(res.status).toBe(302);
  return setCookie(res).split(';')[0]!;
}

describe('login', () => {
  test('the login page renders', async () => {
    const { app } = await setup();
    const res = await request(app).get('/login?next=/drive/folder');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="next" value="/drive/folder"');
    expect(res.text).toContain('/static/auth.css');
  });

  test('a successful login sets the cookie and lets the user in', async () => {
    const { app, stores } = await setup();
    const res = await post(app, '/login', { login: 'ANNA', password: ADMIN.password });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const cookie = setCookie(res);
    expect(cookie).toMatch(/^sid=[\w-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).not.toContain('Secure');
    // the database holds a hash, not the token itself
    const token = cookie.slice(4, 47);
    expect(await stores.sessions.find(token)).toBeUndefined();
    expect((await getSessionUser(stores, token))?.login).toBe('anna');

    const page = await request(app).get('/drive/folder').set('Cookie', cookie.split(';')[0]!);
    expect(page.text).toBe('привет, anna');
    const again = await request(app).get('/login').set('Cookie', cookie.split(';')[0]!);
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe('/');
  });

  test('the cookie is Secure when COOKIE_SECURE=true', async () => {
    const { app } = await setup({ COOKIE_SECURE: 'true' });
    const res = await post(app, '/login', ADMIN);
    expect(setCookie(res)).toContain('Secure');
  });

  test('a wrong password and an unknown login get the same answer', async () => {
    const { app } = await setup();
    const wrong = await post(app, '/login', { login: 'anna', password: 'wrong-password' });
    const unknown = await post(app, '/login', { login: 'nobody', password: 'wrong-password' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.text).toContain('Неверный логин или пароль');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.text.replace('value="anna"', '')).toBe(unknown.text.replace('value="nobody"', ''));
    const empty = await request(app).post('/login');
    expect(empty.status).toBe(401);
  });

  test('redirects to next after login, but only to a local path', async () => {
    const { app } = await setup();
    const ok = await post(app, '/login', { ...ADMIN, next: '/drive/folder?sort=name' });
    expect(ok.headers.location).toBe('/drive/folder?sort=name');
    for (const next of ['//evil.com', '/\\evil.com', 'https://evil.com/', '/.//evil.com', 'evil.com', '/\t/evil.com', 'javascript:alert(1)']) {
      const res = await post(app, '/login', { ...ADMIN, next });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    }
  });

  test('logout removes the session and the cookie', async () => {
    const { app, stores, admin } = await setup();
    const cookie = await login(app, ADMIN);
    const res = await post(app, '/logout', {}, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(setCookie(res)).toMatch(/^sid=;/);
    expect(await stores.sessions.deleteByUser(admin.id)).toBe(0);
    expect((await request(app).get('/drive/folder').set('Cookie', cookie)).status).toBe(302);
  });
});

describe('safeNext', () => {
  test.each([
    ['/', '/'],
    ['/drive/12?x=1#top', '/drive/12?x=1#top'],
    ['/drive/Отчёты', '/drive/%D0%9E%D1%82%D1%87%D1%91%D1%82%D1%8B'],
  ])('accepts %s', (input, expected) => expect(safeNext(input)).toBe(expected));

  test.each([
    '//evil.com', '///evil.com', '/\\evil.com', '\\\\evil.com', '/\\/evil.com', 'http://evil.com', '//evil.com/%2f..',
    '/.//evil.com', '/drive/..//evil.com', '/\n/evil.com', ' /drive', '', 'drive', '/' + 'a'.repeat(3000),
  ])('rejects %j', (input) => expect(safeNext(input)).toBe('/'));

  test('a non-string is / as well', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(['/a', '/b'])).toBe('/');
  });
});

test('parseCookies parses the header by hand', () => {
  const cookies = parseCookies('a=1; sid=abc-_D; quoted="x y"; enc=%D0%B0; bad=%E0%A4%A; sid=second; =nope; flag');
  expect(Object.fromEntries(cookies)).toEqual({ a: '1', sid: 'abc-_D', quoted: 'x y', enc: 'а', bad: '%E0%A4%A' });
  expect(parseCookies(undefined).size).toBe(0);
});

describe('requireAuth', () => {
  test('GET without a session redirects to login with next', async () => {
    const { app } = await setup();
    const res = await request(app).get('/drive/folder?sort=name&q=a b');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?next=%2Fdrive%2Ffolder%3Fsort%3Dname%26q%3Da%2520b');
  });

  test('POST without a session is a 401', async () => {
    const { app } = await setup();
    const res = await post(app, '/drive/folder', {});
    expect(res.status).toBe(401);
    expect(res.text).toContain('Нужно войти');
  });

  test('a forged cookie is not accepted', async () => {
    const { app } = await setup();
    const res = await request(app).get('/drive/folder').set('Cookie', `sid=${'A'.repeat(43)}`);
    expect(res.status).toBe(302);
  });
});

describe('team administration', () => {
  test('guests are sent to login, members get a 403', async () => {
    const { app } = await setup();
    const guest = await request(app).get('/users');
    expect(guest.status).toBe(302);
    expect(guest.headers.location).toBe('/login?next=%2Fusers');
    expect((await post(app, '/users', {})).status).toBe(401);

    const cookie = await login(app, MEMBER);
    expect((await request(app).get('/users').set('Cookie', cookie)).status).toBe(403);
    const create = await post(app, '/users', { login: 'hacker', name: 'Хакер', password: 'password-1', isAdmin: '1' }, cookie);
    expect(create.status).toBe(403);
    expect((await post(app, `/users/${MISSING_ID}/password`, { password: 'password-1' }, cookie)).status).toBe(403);
    expect((await post(app, `/users/${MISSING_ID}/delete`, {}, cookie)).status).toBe(403);
  });

  test('an administrator sees the list, names are escaped', async () => {
    const { app } = await setup();
    const cookie = await login(app, ADMIN);
    const res = await request(app).get('/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Анна &lt;Админ&gt;');
    expect(res.text).not.toContain('<Админ>');
    expect(res.text).toContain('boris');
    expect(res.text).toContain('href="/account/password"');
  });

  test('an administrator adds a member', async () => {
    const { app, stores } = await setup();
    const cookie = await login(app, ADMIN);
    const res = await post(app, '/users', { login: 'vera', name: 'Вера', password: 'vera-password' }, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/users?ok=created');
    expect(await stores.users.findByLogin('vera')).toMatchObject({ name: 'Вера', isAdmin: false });
    await login(app, { login: 'vera', password: 'vera-password' });

    const bad = await post(app, '/users', { login: 'vera', name: 'Вера 2', password: 'vera-password' }, cookie);
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('уже есть');
    expect(bad.text).toContain('value="Вера 2"');
    const short = await post(app, '/users', { login: 'gleb', name: 'Глеб', password: '123' }, cookie);
    expect(short.status).toBe(400);
    expect(await stores.users.findByLogin('gleb')).toBeUndefined();
  });

  test('an administrator resets a password and the member is logged out', async () => {
    const { app, member } = await setup();
    const cookie = await login(app, ADMIN);
    const memberCookie = await login(app, MEMBER);
    const res = await post(app, `/users/${member.id}/password`, { password: 'brand-new-pass' }, cookie);
    expect(res.headers.location).toBe('/users?ok=password');
    expect((await request(app).get('/drive/folder').set('Cookie', memberCookie)).status).toBe(302);
    expect((await post(app, '/login', MEMBER)).status).toBe(401);
    await login(app, { login: 'boris', password: 'brand-new-pass' });

    expect((await post(app, `/users/${member.id}/password`, { password: 'short' }, cookie)).status).toBe(400);
    expect((await post(app, `/users/${MISSING_ID}/password`, { password: 'brand-new-pass' }, cookie)).status).toBe(404);
    expect((await post(app, '/users/abc/password', { password: 'brand-new-pass' }, cookie)).status).toBe(404);
  });

  test('deletion: a member can be deleted, oneself and an owner of files cannot', async () => {
    const { app, stores, admin, member } = await setup();
    const cookie = await login(app, ADMIN);
    const self = await post(app, `/users/${admin.id}/delete`, {}, cookie);
    expect(self.status).toBe(400);
    expect(self.text).toContain('Нельзя удалить самого себя');

    const folder = await stores.nodes.insert(folderRecord(member.id, 'Папка'));
    const owner = await post(app, `/users/${member.id}/delete`, {}, cookie);
    expect(owner.status).toBe(400);
    expect(owner.text).toContain('остались файлы');

    await stores.nodes.deleteSubtree(folder.id);
    const res = await post(app, `/users/${member.id}/delete`, {}, cookie);
    expect(res.headers.location).toBe('/users?ok=deleted');
    expect(await stores.users.findByLogin('boris')).toBeUndefined();
    expect((await post(app, `/users/${member.id}/delete`, {}, cookie)).status).toBe(404);
  });
});

describe('changing own password', () => {
  test('is unavailable without a session', async () => {
    const { app } = await setup();
    expect((await request(app).get('/account/password')).headers.location).toBe('/login?next=%2Faccount%2Fpassword');
    expect((await post(app, '/account/password', {})).status).toBe(401);
  });

  test('requires the current password and a matching confirmation', async () => {
    const { app } = await setup();
    const cookie = await login(app, MEMBER);
    expect((await request(app).get('/account/password').set('Cookie', cookie)).status).toBe(200);

    const wrong = await post(app, '/account/password', { current: 'nope', password: 'new-password-1', confirm: 'new-password-1' }, cookie);
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain('Текущий пароль введён неверно');
    const mismatch = await post(app, '/account/password', { current: MEMBER.password, password: 'new-password-1', confirm: 'new-password-2' }, cookie);
    expect(mismatch.status).toBe(400);
    const short = await post(app, '/account/password', { current: MEMBER.password, password: 'short', confirm: 'short' }, cookie);
    expect(short.status).toBe(400);
    expect(short.text).toContain('не короче 8');
    await login(app, MEMBER); // the old password still works
  });

  test('changes the password and closes the other sessions', async () => {
    const { app } = await setup();
    const here = await login(app, MEMBER);
    const elsewhere = await login(app, MEMBER);
    const res = await post(app, '/account/password', { current: MEMBER.password, password: 'new-password-1', confirm: 'new-password-1' }, here);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/account/password?ok=1');

    expect((await request(app).get('/drive/folder').set('Cookie', here)).status).toBe(200);
    expect((await request(app).get('/drive/folder').set('Cookie', elsewhere)).status).toBe(302);
    expect((await post(app, '/login', MEMBER)).status).toBe(401);
    await login(app, { login: 'boris', password: 'new-password-1' });
    const done = await request(app).get('/account/password?ok=1').set('Cookie', here);
    expect(done.text).toContain('Пароль изменён');
  });
});

describe('brute-force protection', () => {
  test('after 10 failures login is blocked even with the right password', async () => {
    const { app } = await setup();
    for (let i = 0; i < 10; i++) {
      expect((await post(app, '/login', { login: 'anna', password: `wrong-${i}` })).status).toBe(401);
    }
    const blocked = await post(app, '/login', { login: 'Anna', password: ADMIN.password });
    expect(blocked.status).toBe(429);
    expect(blocked.text).toContain('Слишком много неудачных попыток');
    expect(blocked.headers['set-cookie']).toBeUndefined();
    // another login from the same address is unaffected
    await login(app, MEMBER);
  });

  test('an unknown login is blocked just like an existing one', async () => {
    const { app } = await setup();
    for (let i = 0; i < 10; i++) await post(app, '/login', { login: 'ghost', password: 'wrong-password' });
    expect((await post(app, '/login', { login: 'ghost', password: 'wrong-password' })).status).toBe(429);
  });

  test('a successful login resets the counter', async () => {
    const { app } = await setup();
    for (let i = 0; i < 9; i++) await post(app, '/login', { login: 'anna', password: 'wrong-password' });
    await login(app, ADMIN);
    for (let i = 0; i < 9; i++) await post(app, '/login', { login: 'anna', password: 'wrong-password' });
    await login(app, ADMIN);
  });

  test('the window expires and the table size is bounded', () => {
    let now = 0;
    const limiter = createLimiter(2, 1000, 3, () => now);
    limiter.fail('a');
    expect(limiter.isBlocked('a')).toBe(false);
    limiter.fail('a');
    expect(limiter.isBlocked('a')).toBe(true);
    now = 999;
    expect(limiter.isBlocked('a')).toBe(true);
    now = 1000;
    expect(limiter.isBlocked('a')).toBe(false);

    // overflow: the oldest keys are evicted
    for (const key of ['b', 'b', 'c', 'd', 'e']) limiter.fail(key);
    expect(limiter.isBlocked('b')).toBe(false);
    limiter.fail('e');
    expect(limiter.isBlocked('e')).toBe(true);
    limiter.reset('e');
    expect(limiter.isBlocked('e')).toBe(false);
  });
});
