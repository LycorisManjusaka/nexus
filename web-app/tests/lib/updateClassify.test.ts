/**
 * updateClassify — what /api/update must TELL the owner after a pull.
 *
 * Ported 2026-10-27 from workspace/import_probe/test_updateclassify.mjs
 * (2026-10-22). The flags decide whether the owner is told to run `npm ci` and
 * whether Next will restart itself, so a false negative here is a silent
 * half-updated install.
 *
 * The file lists are not invented: the first block is verbatim
 * `git diff --name-only` stdout captured from a throwaway clone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedFiles, parseChangedFiles } from '../../src/lib/updateClassify';

describe('parseChangedFiles — captured git stdout', () => {
  const GIT_STDOUT = 'b.txt\nnext.config.ts\nweb-app/package-lock.json\n';

  it('parses real stdout, trailing newline and all', () => {
    assert.deepEqual(parseChangedFiles(GIT_STDOUT), ['b.txt', 'next.config.ts', 'web-app/package-lock.json']);
  });

  it('handles CRLF', () => {
    assert.deepEqual(parseChangedFiles('a.ts\r\nb.ts\r\n'), ['a.ts', 'b.ts']);
  });

  it('does not invent files out of blank output', () => {
    assert.equal(parseChangedFiles('').length, 0);
    assert.equal(parseChangedFiles('\n  \n\n').length, 0);
  });

  it('accepts output with no trailing newline', () => {
    assert.equal(parseChangedFiles('only.ts').length, 1);
  });

  it('does not throw on undefined', () => {
    // The route always passes a string. A flag must never be the thing that
    // crashes the update.
    assert.equal(parseChangedFiles(undefined as never).length, 0);
  });

  it('composes with the classifier', () => {
    assert.equal(classifyChangedFiles(parseChangedFiles(GIT_STDOUT)).lockfileChanged, true);
  });
});

describe('classifyChangedFiles — lockfile', () => {
  it('finds it at the repo root and nested', () => {
    assert.equal(classifyChangedFiles(['package-lock.json']).lockfileChanged, true);
    assert.equal(classifyChangedFiles(['a/b/c/package-lock.json']).lockfileChanged, true);
  });

  it('is not fooled by a file merely NAMED like it', () => {
    assert.equal(classifyChangedFiles(['docs/about-package-lock.json.md']).lockfileChanged, false);
  });

  it('does not treat package.json as the lockfile', () => {
    assert.equal(classifyChangedFiles(['web-app/package.json']).lockfileChanged, false);
  });

  it('stays false for an ordinary code change', () => {
    const r = classifyChangedFiles(['web-app/src/lib/markdownLogic.ts', 'README.md']);
    assert.equal(r.lockfileChanged, false);
    assert.equal(r.nextConfigChanged, false);
  });
});

describe('classifyChangedFiles — next.config', () => {
  it('matches every extension Next accepts', () => {
    assert.equal(classifyChangedFiles(['next.config.mjs']).nextConfigChanged, true);
    assert.equal(classifyChangedFiles(['web-app/next.config.js']).nextConfigChanged, true);
    assert.equal(classifyChangedFiles(['next.config.cts']).nextConfigChanged, true);
  });

  it('does not match the type declaration or a path containing the name', () => {
    assert.equal(classifyChangedFiles(['next.config.d.ts']).nextConfigChanged, false);
    assert.equal(classifyChangedFiles(['docs/next.config.ts.md']).nextConfigChanged, false);
  });
});

describe('classifyChangedFiles — degenerate input', () => {
  it('reports nothing rather than throwing', () => {
    assert.equal(classifyChangedFiles([]).lockfileChanged, false);
    assert.equal(classifyChangedFiles(null as never).nextConfigChanged, false);
    assert.equal(classifyChangedFiles(['', '  ']).lockfileChanged, false);
  });
});
