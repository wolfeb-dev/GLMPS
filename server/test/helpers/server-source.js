// The source of everything that registers HTTP routes: server.js plus the
// route modules split out of it (card glmps-2-0-151). A test that audits routes
// by reading source must use this, or a moved route silently leaves its audit.
import fs from 'node:fs';
import path from 'node:path';

const SERVER_DIR = path.resolve(import.meta.dirname, '..', '..');

/** Repo-relative paths of the route modules. */
export function routeModuleFiles() {
  const dir = path.join(SERVER_DIR, 'lib', 'routes');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join('server', 'lib', 'routes', f));
}

/** server.js and every route module, as one string. */
export function serverSource() {
  const repo = path.dirname(SERVER_DIR);
  return [path.join('server', 'server.js'), ...routeModuleFiles()].map((f) => fs.readFileSync(path.join(repo, f), 'utf8')).join('\n');
}
