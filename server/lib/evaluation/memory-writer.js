// server/lib/evaluation/memory-writer.js
//
// Sole writer of the curated memory dir (<slug>.md + MEMORY.md index). The
// proposals store is a thin wrapper over the shared pending-request
// primitive, server/lib/governance/request-info.js (glmps-81 Phase 4) - 
// storage lives at stateDir/requests/<id>.json now, not
// stateDir/memory-distill/proposals/<id>.json. Existing callers
// (memory-distill-worker.js, /api/memory/proposals* in server.js) are
// unaffected: stageProposal/listProposals/approveProposal/rejectProposal
// keep their exact signatures and return shapes.
// No network. Fail-open where reasonable, but write refusal (exists) and
// missing-proposal reads are reported via return value, never thrown.

import fs from 'node:fs';
import path from 'node:path';
import { renderMemoryFile, renderIndexLine, slugify } from './memory-distill-core.js';
import { createRequest, listPending, resolveRequest } from '../governance/request-info.js';

const INDEX_HEADER = '# Memory index\n\n';


export function writeMemoryFile(memoryDir, fact, { sessionId } = {}) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const slug = slugify(fact.name);
  const file = path.join(memoryDir, `${slug}.md`);

  if (fs.existsSync(file)) {
    return { written: false, file, reason: 'exists' };
  }

  fs.writeFileSync(file, renderMemoryFile(fact, { sessionId }));

  const indexFile = path.join(memoryDir, 'MEMORY.md');
  let content;
  try {
    content = fs.readFileSync(indexFile, 'utf8');
  } catch {
    content = INDEX_HEADER;
  }
  const marker = `](${slug}.md)`;
  if (!content.includes(marker)) {
    content = content.replace(/\s*$/, '') + '\n' + renderIndexLine(fact) + '\n';
  }
  fs.writeFileSync(indexFile, content);

  return { written: true, file };
}

// Same identity scheme as before the refactor: the id is still
// slugify(fact.name), passed through as an explicit id so re-staging the
// same-named fact still overwrites the same pending request (byte-identical
// id values pre/post refactor - nothing downstream that treats the id as
// opaque, e.g. web/shared/api.js, needs to change, but nothing relies on the
// literal string either).

export function stageProposal(stateDir, proposal) {
  const id = slugify(proposal.fact.name);
  return createRequest(stateDir, { kind: 'memory-proposal', payload: proposal, id });
}

export function listProposals(stateDir) {
  return listPending(stateDir, { kind: 'memory-proposal' }).map(({ id, payload }) => ({ ...payload, id }));
}

export function approveProposal(stateDir, id) {
  const r = resolveRequest(stateDir, id, { decision: 'approved', by: 'memory-writer' });
  if (!r.resolved) return { written: false, reason: 'missing' };
  const proposal = r.payload;
  return writeMemoryFile(proposal.memoryDir, proposal.fact, { sessionId: proposal.sessionId });
}

export function rejectProposal(stateDir, id) {
  resolveRequest(stateDir, id, { decision: 'rejected', by: 'memory-writer' });
}
