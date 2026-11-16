import leftPad from 'left-pad';
import path from 'node:path';
export const hello = (s) => leftPad(s, 5) + path.sep.length;
