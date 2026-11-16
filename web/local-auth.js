// web/local-auth.js - scan 2026-10-15 F2: the plain-browser half of the
// local session. `npm run dashboard-link` prints /local-auth.html#<session>;
// the value rides the fragment (never sent to the server or logged), is kept
// in this origin's localStorage (port-scoped, unlike a cookie), and the
// fragment is dropped from history before going to the dashboard.
import { acceptLocalSession } from './shared/api.js';

const status = document.getElementById('local-auth-status');
const value = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
if (acceptLocalSession(value)) {
  location.replace('/');
} else {
  status.textContent = 'This link is incomplete or could not be saved. Run `npm run dashboard-link` in the GLMPS folder and open the new link.';
}
