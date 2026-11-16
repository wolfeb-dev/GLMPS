const unsupported = () => { throw new Error('mem0 plugin: Postgres is not supported (pg shim)'); };
export class Pool { constructor() { unsupported(); } }
export class Client { constructor() { unsupported(); } }
export default { Pool, Client };
