import path from 'node:path';

// Resolved from the working directory: the app is always started from the repo root.
const WEB_ROOT = path.join(process.cwd(), 'src', 'web');

export const VIEWS_DIR = path.join(WEB_ROOT, 'views');
export const PUBLIC_DIR = path.join(WEB_ROOT, 'public');
