import fs from 'node:fs';
import path from 'node:path';

// Every write the backlog store makes to disk: a snapshot (a temp file renamed
// into place) or a change-log append. `onWrite(items)` gets the cards that
// write carries and may throw to simulate a failed write. Returns the restore.
export function interceptBoardWrites(onWrite) {
  const origWrite = fs.writeFileSync;
  const origAppend = fs.appendFileSync;
  const inBacklog = (file) => typeof file === 'string' && path.basename(path.dirname(file)) === 'backlog';
  fs.writeFileSync = (file, data, ...rest) => {
    if (inBacklog(file) && /^store\.json\.\d+\.tmp$/.test(path.basename(file))) {
      let items = [];
      try { items = JSON.parse(data).items ?? []; } catch { /* not a board snapshot */ }
      onWrite(items);
    }
    return origWrite.call(fs, file, data, ...rest);
  };
  fs.appendFileSync = (file, data, ...rest) => {
    if (inBacklog(file) && /^store\..+\.log$/.test(path.basename(file))) {
      const items = [];
      for (const line of String(data).split('\n')) {
        try { const r = JSON.parse(line); if (r?.t === 'put') items.push(r.item); } catch { /* blank or torn */ }
      }
      onWrite(items);
    }
    return origAppend.call(fs, file, data, ...rest);
  };
  return () => { fs.writeFileSync = origWrite; fs.appendFileSync = origAppend; };
}
