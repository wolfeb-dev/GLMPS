// Mem0's `openai` import becomes the operator's Claude, in-process.
let chatCompletion = null;
export function setChatCompletion(fn) { chatCompletion = fn; }
export default class OpenAI {
  constructor() {
    this.chat = { completions: { create: async (body) => { if (!chatCompletion) throw new Error('mem0 plugin: model not configured'); return chatCompletion(body); } } };
    this.embeddings = { create: async () => { throw new Error('mem0 plugin: embeddings are not available through the model; configure the embedder'); } };
  }
}
export { OpenAI };
// Mem0's vendored bundle statically imports `{ AzureOpenAI }` from "openai"
// for its (unused, never-selected) azure_openai provider. ES module linking
// resolves every named import before any code runs, so the shim must export
// this binding even though GLMPS never constructs it: a throwing stub, per
// the "refuse if used" pattern for shimmed optional providers.
export class AzureOpenAI {
  constructor() { throw new Error('mem0 plugin: azure openai is not available (openai shim)'); }
}
