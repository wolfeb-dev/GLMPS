// Mem0 uses axios for its hosted client and PostHog telemetry. GLMPS sends
// nothing anywhere, so every call is refused.
const refuse = async () => { throw new Error('mem0 plugin: network access is disabled (axios shim)'); };
const axios = Object.assign(refuse, { get: refuse, post: refuse, put: refuse, patch: refuse, delete: refuse, request: refuse, create: () => axios, defaults: { headers: {} }, interceptors: { request: { use() {} }, response: { use() {} } } });
export default axios;
