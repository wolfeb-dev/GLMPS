// server/test/mini-dom-fixture.test.js
// D-surface Task 7 fix round 1, ruling (b): server/test/fixtures/mini-dom.js
// gained a <select>.options getter and an index-aware remove(index) override
// (HTMLSelectElement.remove(index) removes an option, not the select itself -
// a different method from the generic Node.remove() every other element
// keeps). Covers both directly, and the shape web/orchestration/board.js's
// populateProjects() actually relies on: draining every option but the first
// via `while (sel.options.length > 1) sel.remove(1);`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

function addOption(select, value) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = value;
  select.appendChild(opt);
  return opt;
}

test('a <select> exposes .options as its live <option> children', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const select = document.createElement('select');
    assert.equal(select.options.length, 0);
    addOption(select, 'all');
    addOption(select, 'a');
    addOption(select, 'b');
    assert.equal(select.options.length, 3);
    assert.equal(select.options[1].value, 'a');
  } finally { dom.restore(); }
});

test('.options is undefined on a non-select element (matches real DOM)', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const div = document.createElement('div');
    assert.equal(div.options, undefined);
  } finally { dom.restore(); }
});

test('select.remove(index) removes the option at that index, not the select itself', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const select = document.createElement('select');
    document.body.appendChild(select);
    addOption(select, 'all');
    addOption(select, 'a');
    addOption(select, 'b');
    select.remove(1);
    assert.equal(select.options.length, 2);
    assert.deepEqual([...select.options].map((o) => o.value), ['all', 'b']);
    assert.equal(select.parentNode, document.body, 'the select itself must still be in the document');
  } finally { dom.restore(); }
});

test('draining a select down to its first option (the shape populateProjects uses)', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const select = document.createElement('select');
    addOption(select, 'all');
    addOption(select, 'a');
    addOption(select, 'b');
    addOption(select, 'c');
    while (select.options.length > 1) select.remove(1);
    assert.equal(select.options.length, 1);
    assert.equal(select.options[0].value, 'all');
  } finally { dom.restore(); }
});

test('a bare remove() on a select (no index) still self-removes, like any other element', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const select = document.createElement('select');
    document.body.appendChild(select);
    addOption(select, 'all');
    select.remove();
    assert.equal(select.parentNode, null);
  } finally { dom.restore(); }
});
