import crypto from 'node:crypto';
export const v4 = () => crypto.randomUUID();
export default { v4 };
