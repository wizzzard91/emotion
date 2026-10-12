import type { User } from './auth/users.ts';

declare global {
  namespace Express {
    interface Request {
      /** Set by loadUser when the session is valid. */
      user?: User;
    }
  }
}
