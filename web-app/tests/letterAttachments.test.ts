import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  safeAttachmentName,
  uniqueAttachmentNames,
  normalizeAttachmentPaths,
  copyAttachmentsToDesk,
  letterFilesDir,
  letterAttachmentPath,
  LETTER_ATTACHMENTS_DESK_DIR,
} from '@/lib/letters';

test('safeAttachmentName keeps only the last segment and keeps Japanese', () => {
  assert.equal(safeAttachmentName('C:\\Users\\x\\desk\\蟹.jpg'), '蟹.jpg');
  assert.equal(safeAttachmentName('images/a/b.png'), 'b.png');
  assert.equal(safeAttachmentName('a:b?.txt'), 'a_b_.txt');
  assert.equal(safeAttachmentName('CON.txt'), '_CON.txt');
  assert.equal(safeAttachmentName('trail. '), 'trail');
  assert.equal(safeAttachmentName('..'), 'file');
});

test('uniqueAttachmentNames numbers duplicates case-insensitively', () => {
  assert.deepEqual(uniqueAttachmentNames(['a.png', 'A.png', 'a.png', 'b']), ['a.png', 'A (2).png', 'a (3).png', 'b']);
});

test('normalizeAttachmentPaths accepts the shapes models emit', () => {
  assert.deepEqual(normalizeAttachmentPaths(['x.png', 'y.png']), ['x.png', 'y.png']);
  assert.deepEqual(normalizeAttachmentPaths('x.png'), ['x.png']);
  assert.deepEqual(normalizeAttachmentPaths('["x.png","y.png"]'), ['x.png', 'y.png']);
  assert.deepEqual(normalizeAttachmentPaths(undefined), []);
  assert.deepEqual(normalizeAttachmentPaths(['x.png', 'x.png', '']), ['x.png']);
});

test('copyAttachmentsToDesk copies next-to-letter files into the reader desk, idempotently', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'letteratt-'));
  try {
    const letter = path.join(root, 'box', '2026-11-14_1600_abcd1234.md');
    await fs.mkdir(letterFilesDir(letter), { recursive: true });
    await fs.writeFile(letter, '---\ntitle: t\n---\n\nhi\n');
    await fs.writeFile(path.join(letterFilesDir(letter), '蟹.jpg'), Buffer.from([1, 2, 3]));
    const meta: any = { id: 'L-test000001', file: letter, attachments: ['蟹.jpg'] };
    const desk = path.join(root, 'desk');

    const out = await copyAttachmentsToDesk(meta, desk);
    assert.deepEqual(out, [{ rel: `${LETTER_ATTACHMENTS_DESK_DIR}/L-test000001/蟹.jpg`, bytes: 3 }]);
    const copied = await fs.readFile(path.join(desk, LETTER_ATTACHMENTS_DESK_DIR, 'L-test000001', '蟹.jpg'));
    assert.deepEqual([...copied], [1, 2, 3]);

    // Second read: same result, no error.
    assert.deepEqual(await copyAttachmentsToDesk(meta, desk), out);

    // The serving lookup accepts only names the letter carries.
    assert.ok(await letterAttachmentPath(meta, '蟹.jpg'));
    assert.equal(await letterAttachmentPath(meta, '../2026-11-14_1600_abcd1234.md'), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
