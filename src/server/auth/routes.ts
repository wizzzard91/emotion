import { Router, type Request, type RequestHandler, type Response } from 'express';
// Type only: a real import of app.ts would be circular.
import type { AppDeps } from '../app.ts';
import { burnPasswordCheck, verifyPassword } from './passwords.ts';
import { createSession, deleteSession, deleteUserSessions, getSessionUser, SESSION_TTL_SECONDS } from './sessions.ts';
import { createUser, deleteUser, listUsers, setPassword, ValidationError } from './users.ts';

export const SESSION_COOKIE = 'sid';

const STYLES = ['/static/auth.css'];
const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' });
const MAX_FAILED_ATTEMPTS = 10;
const ATTEMPTS_WINDOW_MS = 15 * 60 * 1000;
const LIMITER_MAX_KEYS = 5000;

const TOO_MANY_ATTEMPTS = 'Слишком много неудачных попыток. Попробуйте через 15 минут.';
// One message for every case: do not reveal whether the login exists.
const BAD_CREDENTIALS = 'Неверный логин или пароль';

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/** Where to go after login: a local path only, otherwise `/`. */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // Browsers read `\` as `/` and drop control characters: `/\evil.com`, `/\t/evil.com`.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  const base = 'http://emotion.invalid';
  const url = URL.parse(value, base);
  // `/.//evil.com` normalises to `//evil.com`.
  if (!url || url.origin !== base || url.pathname.startsWith('//')) return '/';
  return url.pathname + url.search + url.hash;
}

export interface Limiter {
  isBlocked(key: string): boolean;
  fail(key: string): void;
  reset(key: string): void;
}

/** In-memory counter of failed attempts; it resets on restart, which is fine for a team of ten. */
export function createLimiter(
  max: number = MAX_FAILED_ATTEMPTS,
  windowMs: number = ATTEMPTS_WINDOW_MS,
  maxKeys: number = LIMITER_MAX_KEYS,
  now: () => number = Date.now,
): Limiter {
  const entries = new Map<string, { count: number; resetAt: number }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.resetAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    isBlocked: (key) => (live(key)?.count ?? 0) >= max,
    fail(key) {
      const entry = live(key);
      if (entry) {
        entry.count++;
        return;
      }
      if (entries.size >= maxKeys) {
        const t = now();
        for (const [k, e] of entries) if (e.resetAt <= t) entries.delete(k);
        // Still full: sacrifice the oldest entries so memory stays bounded.
        for (const k of entries.keys()) {
          if (entries.size < maxKeys) break;
          entries.delete(k);
        }
      }
      entries.set(key, { count: 1, resetAt: now() + windowMs });
    },
    reset: (key) => void entries.delete(key),
  };
}

function field(req: Request, name: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
}

function sessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE);
}

function renderError(res: Response, status: number, message: string): void {
  res.status(status).render('error', { title: `Ошибка ${status}`, status, message });
}

export function loadUser(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    const token = sessionToken(req);
    const user = token ? await getSessionUser(deps.stores, token) : undefined;
    if (user) req.user = user;
    res.locals.user = user ?? null; // the header partial needs `user` in every template
    next();
  };
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.user) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  renderError(res, 401, 'Нужно войти');
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.user) return requireAuth(req, res, next);
  if (!req.user.isAdmin) return renderError(res, 403, 'Эта страница только для администраторов');
  next();
};

export function createAuthRouter(deps: AppDeps): Router {
  const { stores, config } = deps;
  const router = Router();
  const limiter = createLimiter();

  const cookieOptions = { httpOnly: true, sameSite: 'lax', path: '/', secure: config.cookieSecure } as const;

  const renderLogin = (res: Response, status: number, locals: { next: string; login?: string; error?: string }) => {
    res.status(status).render('login', { title: 'Вход — Emotion', styles: STYLES, login: '', error: null, ...locals });
  };

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    renderLogin(res, 200, { next: safeNext(req.query.next) });
  });

  router.post('/login', async (req, res) => {
    const login = field(req, 'login').trim();
    const password = field(req, 'password');
    const next = safeNext(field(req, 'next'));
    const key = `${login.toLowerCase().slice(0, 64)}|${req.ip ?? ''}`;

    if (limiter.isBlocked(key)) {
      res.set('Retry-After', String(ATTEMPTS_WINDOW_MS / 1000));
      return renderLogin(res, 429, { next, login, error: TOO_MANY_ATTEMPTS });
    }

    const found = login ? await stores.users.findByLogin(login) : undefined;
    let ok = false;
    if (found) ok = await verifyPassword(password, found.passwordHash);
    else await burnPasswordCheck(password);

    if (!found || !ok) {
      limiter.fail(key);
      return renderLogin(res, 401, { next, login, error: BAD_CREDENTIALS });
    }

    limiter.reset(key);
    await deleteSession(stores, sessionToken(req)); // this browser's previous session is no longer needed
    const token = await createSession(stores, found.id);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 });
    res.redirect(next);
  });

  router.post('/logout', async (req, res) => {
    await deleteSession(stores, sessionToken(req));
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.redirect('/login');
  });

  // --- Own password ---

  const renderAccount = (res: Response, status: number, locals: { error?: string; ok?: boolean }) => {
    res.status(status).render('account', { title: 'Смена пароля — Emotion', styles: STYLES, error: null, ok: false, ...locals });
  };

  router.get('/account/password', requireAuth, (req, res) => {
    renderAccount(res, 200, { ok: req.query.ok === '1' });
  });

  router.post('/account/password', requireAuth, async (req, res) => {
    const user = req.user!;
    const key = `account:${user.id}`;
    if (limiter.isBlocked(key)) return renderAccount(res, 429, { error: TOO_MANY_ATTEMPTS });

    const hash = (await stores.users.findById(user.id))?.passwordHash;
    if (!hash || !(await verifyPassword(field(req, 'current'), hash))) {
      limiter.fail(key);
      return renderAccount(res, 400, { error: 'Текущий пароль введён неверно' });
    }
    const password = field(req, 'password');
    if (password !== field(req, 'confirm')) {
      return renderAccount(res, 400, { error: 'Новый пароль и его повтор не совпадают' });
    }
    try {
      await setPassword(stores, user.id, password);
    } catch (err) {
      if (err instanceof ValidationError) return renderAccount(res, 400, { error: err.message });
      throw err;
    }
    limiter.reset(key);
    await deleteUserSessions(stores, user.id, sessionToken(req)); // log out every other device
    res.redirect('/account/password?ok=1');
  });

  // --- Team (administrators only) ---

  const NOTICES: Record<string, string> = {
    created: 'Участник добавлен',
    password: 'Пароль изменён, участник разлогинен на всех устройствах',
    deleted: 'Участник удалён',
  };

  const renderUsers = async (
    req: Request,
    res: Response,
    status: number,
    locals: { error?: string; form?: { login: string; name: string; isAdmin: boolean } } = {},
  ) => {
    const ok = typeof req.query.ok === 'string' && Object.hasOwn(NOTICES, req.query.ok) ? NOTICES[req.query.ok] : null;
    res.status(status).render('users', {
      title: 'Команда — Emotion',
      styles: STYLES,
      users: (await listUsers(stores)).map((u) => ({ ...u, created: DATE_FORMAT.format(u.createdAt) })),
      me: req.user!,
      notice: locals.error ? null : ok,
      error: null,
      form: { login: '', name: '', isAdmin: false },
      ...locals,
    });
  };

  // undefined when the URL does not carry a well-formed id
  const userId = (req: Request): string | undefined => {
    const raw = req.params.id;
    return typeof raw === 'string' && /^[0-9a-f]{24}$/.test(raw) ? raw : undefined;
  };
  const NO_SUCH_USER = 'Такого участника нет';

  router.get('/users', requireAdmin, (req, res) => renderUsers(req, res, 200));

  router.post('/users', requireAdmin, async (req, res) => {
    const form = { login: field(req, 'login').trim(), name: field(req, 'name').trim(), isAdmin: field(req, 'isAdmin') !== '' };
    try {
      await createUser(stores, { ...form, password: field(req, 'password') });
    } catch (err) {
      if (err instanceof ValidationError) return renderUsers(req, res, 400, { error: err.message, form });
      throw err;
    }
    res.redirect('/users?ok=created');
  });

  router.post('/users/:id/password', requireAdmin, async (req, res) => {
    const id = userId(req);
    if (id === undefined || !(await stores.users.findById(id))) return renderError(res, 404, NO_SUCH_USER);
    try {
      await setPassword(stores, id, field(req, 'password'));
    } catch (err) {
      if (err instanceof ValidationError) return renderUsers(req, res, 400, { error: err.message });
      throw err;
    }
    // A reset usually means "access leaked": close the old sessions; the admin keeps their own current one.
    await deleteUserSessions(stores, id, id === req.user!.id ? sessionToken(req) : undefined);
    res.redirect('/users?ok=password');
  });

  router.post('/users/:id/delete', requireAdmin, async (req, res) => {
    const id = userId(req);
    if (id === undefined || !(await stores.users.findById(id))) return renderError(res, 404, NO_SUCH_USER);
    if (id === req.user!.id) return renderUsers(req, res, 400, { error: 'Нельзя удалить самого себя' });
    try {
      await deleteUser(stores, id);
    } catch (err) {
      if (err instanceof ValidationError) return renderUsers(req, res, 400, { error: err.message });
      throw err;
    }
    res.redirect('/users?ok=deleted');
  });

  return router;
}
