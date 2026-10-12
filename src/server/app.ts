import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Config } from './config.ts';
import type { Stores } from './db/types.ts';
import type { Storage } from './storage/types.ts';
import { createAuthRouter, loadUser, requireAuth } from './auth/routes.ts';
import { createDriveRouter } from './drive/routes.ts';
import { PUBLIC_DIR, VIEWS_DIR } from './paths.ts';

export interface AppDeps {
  stores: Stores;
  storage: Storage;
  config: Config;
}

/** An error with an HTTP status and a message that is safe to show to the user. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// CSRF protection without tokens: the session cookie is SameSite=Lax, and this
// rejects state-changing requests that come from a foreign origin.
const sameOriginOnly: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return next(new HttpError(403, 'Запрос с другого сайта отклонён'));
  }
  const origin = req.get('origin');
  if (origin && URL.parse(origin)?.host !== req.get('host')) {
    return next(new HttpError(403, 'Запрос с другого сайта отклонён'));
  }
  next();
};

export function createApp(deps: AppDeps) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    // The error template needs these even when a request fails before loadUser.
    res.locals.user = null;
    res.locals.title = 'Emotion';
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    next();
  });
  app.use('/static', express.static(PUBLIC_DIR));
  app.use(sameOriginOnly);
  app.use(express.urlencoded({ extended: false }));
  app.use(loadUser(deps));

  app.use(createAuthRouter(deps)); // /login, /logout, /account, /users (team administration)
  app.get('/', (_req, res) => res.redirect('/drive'));
  app.use('/drive', requireAuth, createDriveRouter(deps));

  app.use((_req, _res, next) => next(new HttpError(404, 'Страница не найдена')));
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Что-то сломалось на сервере' : err.message;
    if (res.headersSent) return res.destroy();
    res.status(status).render('error', { title: `Ошибка ${status}`, status, message });
  };
  app.use(onError);
  return app;
}
