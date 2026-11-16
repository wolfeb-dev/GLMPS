// Which launch target this extension host is. The same companion runs in every
// VS Code family IDE, and each drains only its own request file so a session
// queued for one IDE is never opened by another. No vscode import, so node:test
// can load it.
export type HostTarget = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf' | 'antigravity';

const BY_SCHEME: Record<string, HostTarget> = {
  'vscode': 'vscode', 'vscode-insiders': 'vscode-insiders', 'cursor': 'cursor', 'windsurf': 'windsurf', 'antigravity': 'antigravity', 'antigravity-ide': 'antigravity',
};

export function hostTarget(env: { uriScheme?: unknown; appName?: unknown }): HostTarget | null {
  const scheme = typeof env?.uriScheme === 'string' ? env.uriScheme.toLowerCase() : '';
  if (BY_SCHEME[scheme]) return BY_SCHEME[scheme];
  const app = typeof env?.appName === 'string' ? env.appName.toLowerCase() : '';
  if (app.includes('antigravity')) return 'antigravity';
  if (app.includes('windsurf')) return 'windsurf';
  if (app.includes('cursor')) return 'cursor';
  if (app.includes('visual studio code')) return app.includes('insiders') ? 'vscode-insiders' : 'vscode';
  return null;
}

// Must match companionFileName in server/lib/orchestration/editor-targets.js.
export function requestsFileName(target: HostTarget): string {
  return target === 'antigravity' ? 'resume.jsonl' : `resume.${target}.jsonl`;
}
