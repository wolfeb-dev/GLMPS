// Stands in for the server: stays alive (a held timer, like a listening
// socket) until its parent is gone; with `nowatch` it is the unfixed server.
// Gives up after 60 s so a broken watch cannot leak a process past the run.
// Says "ready" once the watch has read its ppid; the parent fixture waits for it.
import { watchParent } from '../../lib/kernel/parent-watch.js';

const hold = setTimeout(() => process.exit(3), 60_000);
if (process.argv[2] !== 'nowatch') watchParent({ intervalMs: 200, onGone: () => { clearTimeout(hold); process.exit(0); } });
process.stdout.write('ready\n');
