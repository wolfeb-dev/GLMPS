// server/test/skills-view.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillsView } from '../lib/observability/skills-view.js';

function inv(skills) {
  return { skills, agents: [], memory: [], contextFiles: [] };
}

test('buildSkillsView: bare-name label counts a matching installed skill', () => {
  const inventory = inv([{ name: 'brainstorming', description: 'explore ideas', plugin: 'superpowers', path: 'D:\\p\\SKILL.md' }]);
  const events = [{ kind: 'skill', lane: 'context', label: 'brainstorming', path: null, ts: 100, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  assert.equal(view.skills.length, 1);
  const s = view.skills[0];
  assert.equal(s.name, 'brainstorming');
  assert.equal(s.installed, true);
  assert.equal(s.uses, 1);
  assert.equal(s.lastSeen, new Date(100).toISOString());
});

test('buildSkillsView: plugin:name label form matches the installed skill', () => {
  const inventory = inv([{ name: 'brainstorming', description: 'explore ideas', plugin: 'superpowers', path: 'D:\\p\\SKILL.md' }]);
  const events = [{ kind: 'skill', lane: 'context', label: 'superpowers:brainstorming', path: null, ts: 200, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  assert.equal(view.skills.length, 1);
  assert.equal(view.skills[0].uses, 1);
  assert.equal(view.skills[0].installed, true);
});

test('buildSkillsView: SKILL.md-path-shaped label matches via last-segment resolution', () => {
  const inventory = inv([{ name: 'diagnose', description: 'debug loop', plugin: 'project', path: 'D:/x/.agents/skills/diagnose/SKILL.md' }]);
  const events = [{ kind: 'skill', lane: 'context', label: 'D:/x/.agents/skills/diagnose', path: null, ts: 300, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  assert.equal(view.skills.length, 1);
  assert.equal(view.skills[0].name, 'diagnose');
  assert.equal(view.skills[0].uses, 1);
  assert.equal(view.skills[0].installed, true);
});

test('buildSkillsView: a SKILL.md file path label also resolves to the parent dir name', () => {
  const inventory = inv([{ name: 'diagnose', description: 'debug loop', plugin: 'project', path: 'D:/x/.agents/skills/diagnose/SKILL.md' }]);
  const events = [{ kind: 'skill', lane: 'context', label: 'D:/x/.agents/skills/diagnose/SKILL.md', path: 'D:/x/.agents/skills/diagnose/SKILL.md', ts: 300, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  assert.equal(view.skills.length, 1);
  assert.equal(view.skills[0].name, 'diagnose');
  assert.equal(view.skills[0].uses, 1);
});

test('buildSkillsView: installed skill with zero matching events appears in neverUsed', () => {
  const inventory = inv([
    { name: 'brainstorming', description: 'explore ideas', plugin: 'superpowers', path: 'D:\\p\\SKILL.md' },
    { name: 'dcf', description: 'discounted cash flow', plugin: 'financial-analysis', path: 'D:\\q\\SKILL.md' },
  ]);
  const events = [{ kind: 'skill', lane: 'context', label: 'brainstorming', path: null, ts: 100, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  assert.equal(view.neverUsed.length, 1);
  assert.equal(view.neverUsed[0].name, 'dcf');
  assert.equal(view.neverUsed[0].uses, 0);
});

test('buildSkillsView: an event matching no installed skill still appears, installed:false, excluded from neverUsed', () => {
  const inventory = inv([{ name: 'brainstorming', description: 'explore ideas', plugin: 'superpowers', path: 'D:\\p\\SKILL.md' }]);
  const events = [{ kind: 'skill', lane: 'context', label: 'some-uninstalled-skill', path: null, ts: 100, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  const observed = view.skills.find(s => s.name === 'some-uninstalled-skill');
  assert.ok(observed, 'observed-only skill should appear in skills[]');
  assert.equal(observed.installed, false);
  assert.equal(observed.uses, 1);
  assert.ok(!view.neverUsed.some(s => s.name === 'some-uninstalled-skill'));
  // the installed skill (brainstorming) had no events -> neverUsed
  assert.equal(view.neverUsed.length, 1);
  assert.equal(view.neverUsed[0].name, 'brainstorming');
});

test('buildSkillsView: multiple events, uses count correct, lastSeen is the max across mixed numeric/ISO ts', () => {
  const inventory = inv([{ name: 'brainstorming', description: 'explore ideas', plugin: 'superpowers', path: 'D:\\p\\SKILL.md' }]);
  const events = [
    { kind: 'skill', lane: 'context', label: 'brainstorming', path: null, ts: '2026-01-01T00:00:00Z', sessionId: 's1' },
    { kind: 'skill', lane: 'context', label: 'superpowers:brainstorming', path: null, ts: Date.parse('2026-06-01T00:00:00Z'), sessionId: 's1' },
    { kind: 'skill', lane: 'context', label: 'brainstorming', path: null, ts: '2026-03-01T00:00:00Z', sessionId: 's1' },
  ];
  const view = buildSkillsView(inventory, events);
  assert.equal(view.skills.length, 1);
  assert.equal(view.skills[0].uses, 3);
  assert.equal(view.skills[0].lastSeen, new Date(Date.parse('2026-06-01T00:00:00Z')).toISOString());
});

test('buildSkillsView: skills sorted by uses descending, then name ascending', () => {
  const inventory = inv([
    { name: 'zeta', description: '', plugin: 'p', path: 'D:\\z\\SKILL.md' },
    { name: 'alpha', description: '', plugin: 'p', path: 'D:\\a\\SKILL.md' },
    { name: 'beta', description: '', plugin: 'p', path: 'D:\\b\\SKILL.md' },
  ]);
  const events = [
    { kind: 'skill', lane: 'context', label: 'beta', path: null, ts: 1, sessionId: 's1' },
    { kind: 'skill', lane: 'context', label: 'beta', path: null, ts: 2, sessionId: 's1' },
    { kind: 'skill', lane: 'context', label: 'alpha', path: null, ts: 3, sessionId: 's1' },
  ];
  const view = buildSkillsView(inventory, events);
  assert.deepEqual(view.skills.map(s => s.name), ['beta', 'alpha', 'zeta']);
});

test('buildSkillsView: same-named skills from different plugins both counted for an ambiguous bare-name event (known v1 limitation)', () => {
  const inventory = inv([
    { name: 'earnings-analysis', description: 'from earnings-reviewer', plugin: 'earnings-reviewer', path: 'D:\\a\\SKILL.md' },
    { name: 'earnings-analysis', description: 'from equity-research', plugin: 'equity-research', path: 'D:\\b\\SKILL.md' },
  ]);
  const events = [{ kind: 'skill', lane: 'context', label: 'earnings-analysis', path: null, ts: 1, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  const matches = view.skills.filter(s => s.name === 'earnings-analysis');
  assert.equal(matches.length, 2);
  assert.ok(matches.every(s => s.uses === 1 && s.installed === true));
  assert.equal(view.neverUsed.length, 0);
});

test('buildSkillsView: installedAvailable is false and neverUsed is empty when inventory.skills is empty/missing', () => {
  const view1 = buildSkillsView(inv([]), [{ kind: 'skill', lane: 'context', label: 'ghost-skill', path: null, ts: 1, sessionId: 's1' }]);
  assert.equal(view1.installedAvailable, false);
  assert.deepEqual(view1.neverUsed, []);

  const view2 = buildSkillsView({}, [{ kind: 'skill', lane: 'context', label: 'ghost-skill', path: null, ts: 1, sessionId: 's1' }]);
  assert.equal(view2.installedAvailable, false);
  assert.deepEqual(view2.neverUsed, []);
});

test('buildSkillsView: empty/malformed input never throws, returns the empty-safe shape', () => {
  assert.deepEqual(buildSkillsView(undefined, undefined), { skills: [], neverUsed: [], installedAvailable: false });
  assert.deepEqual(buildSkillsView({}, []), { skills: [], neverUsed: [], installedAvailable: false });
  assert.deepEqual(buildSkillsView({ skills: [] }, undefined), { skills: [], neverUsed: [], installedAvailable: false });

  // malformed events: missing label/ts/path must not throw
  const inventory = inv([{ name: 'brainstorming', description: '', plugin: 'superpowers', path: 'D:\\p\\SKILL.md' }]);
  const malformed = [
    {},
    { kind: 'skill' },
    { kind: 'skill', label: null, ts: null, path: null },
    { kind: 'skill', label: 'brainstorming' }, // no ts
  ];
  assert.doesNotThrow(() => buildSkillsView(inventory, malformed));
  const view = buildSkillsView(inventory, malformed);
  const b = view.skills.find(s => s.name === 'brainstorming');
  assert.equal(b.uses, 1); // only the last malformed event carries a resolvable label
  assert.equal(b.lastSeen, null); // no parseable ts among matching events
});


test('buildSkillsView: each row gets a stable lowercased plugin:name id', () => {
  const inventory = inv([{ name: 'Brainstorming', description: '', plugin: 'Superpowers', path: 'D:\\p\\SKILL.md' }]);
  const view = buildSkillsView(inventory, []);
  assert.equal(view.skills[0].id, 'superpowers:brainstorming');
});

test('buildSkillsView: an observed-only (uninstalled) row still gets an id, with an empty plugin segment', () => {
  const events = [{ kind: 'skill', lane: 'context', label: 'ghost-skill', path: null, ts: 1, sessionId: 's1' }];
  const view = buildSkillsView(inv([]), events);
  const observed = view.skills.find(s => s.name === 'ghost-skill');
  assert.equal(observed.id, ':ghost-skill');
});

test('buildSkillsView: matches an installed skill purely via event.path normalization', () => {
  const inventory = inv([{ name: 'diagnose', description: '', plugin: 'project', path: 'D:\\x\\.agents\\skills\\diagnose\\SKILL.md' }]);
  const events = [{ kind: 'skill', lane: 'context', label: 'unrelated-label-text', path: 'd:/x/.agents/skills/diagnose/SKILL.md', ts: 5, sessionId: 's1' }];
  const view = buildSkillsView(inventory, events);
  const d = view.skills.find(s => s.name === 'diagnose');
  assert.ok(d);
  assert.equal(d.installed, true);
  assert.equal(d.uses, 1);
});
