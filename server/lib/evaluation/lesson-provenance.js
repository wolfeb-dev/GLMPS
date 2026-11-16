// server/lib/evaluation/lesson-provenance.js
//
// Provenance shape for a lesson. A0.1 forbids landing a lesson with no
// traceable origin: assertProvenance is the one gate every lesson writer
// (createLesson, and later writeLesson) calls before a row is appended.
//
// Zero runtime dependencies.

export const SCOPES = ['repo', 'desk', 'global'];

export class LessonProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LessonProvenanceError';
  }
}

// Normalize a caller-supplied provenance object into the canonical shape.
// Every field defaults so downstream code never has to guard against a
// missing key. Does not validate - that is assertProvenance's job, kept
// separate so a caller can normalize first and inspect before deciding
// whether to assert.
export function normalizeProvenance(input = {}) {
  return {
    sourceRunId: input.sourceRunId ?? null,
    sourceEventIds: Array.isArray(input.sourceEventIds) ? input.sourceEventIds : [],
    derivedFromRefs: Array.isArray(input.derivedFromRefs) ? input.derivedFromRefs : [],
    scope: input.scope ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

// Throws LessonProvenanceError when the provenance cannot justify a write:
// an unknown scope, or no traceable origin at all (neither a source event
// nor a derived-from ref present). A lesson with no traceable origin is
// exactly what A0.1 forbids.
export function assertProvenance(p) {
  if (!SCOPES.includes(p?.scope)) {
    throw new LessonProvenanceError(
      `lesson provenance scope must be one of ${SCOPES.join(', ')}, got ${JSON.stringify(p?.scope)}`,
    );
  }
  const hasEvents = Array.isArray(p.sourceEventIds) && p.sourceEventIds.length > 0;
  const hasRefs = Array.isArray(p.derivedFromRefs) && p.derivedFromRefs.length > 0;
  if (!hasEvents && !hasRefs) {
    throw new LessonProvenanceError(
      'lesson provenance has no traceable origin: sourceEventIds and derivedFromRefs are both empty',
    );
  }
}
