import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialFolderSelection } from '@/lib/rootLanding';

// ── What these tests are guarding ─────────────────────────────────────────
//
// "A bare root URL selects nothing" is a safety property that reads like a
// regression. Anyone profiling the app later will notice that returning readers
// have to click an entity after opening the port, and the obvious "fix" is to
// restore the remembered folder. These tests are here to make that change fail
// loudly and say why, rather than quietly re-opening a log in front of someone
// who is not cleared to read it.
//
// Requested by Lizard-kun: he may need to open an install where he is cleared
// to update one inhabitant's soul and explicitly asked not to read another's
// conversation. Before this, the port put him somewhere on arrival, and the
// somewhere was decided by whoever used the browser last.

const IDS = ['Навигатор', 'Аналитик', 'Cairn'];

test('bare root selects nothing even when a folder is remembered', () => {
  // THE case this exists for. localStorage says "Навигатор" because that is
  // where the browser was last, and the answer is still null.
  assert.equal(
    initialFolderSelection({
      arrivedViaDeepLink: false,
      linkedFolderId: null,
      rememberedFolderId: 'Навигатор',
      folderIds: IDS,
    }),
    null,
  );
});

test('bare root selects nothing rather than falling back to the first folder', () => {
  // The other half of the old chain: with nothing remembered it took
  // folderIds[0]. Sidebar order is not consent either.
  assert.equal(
    initialFolderSelection({
      arrivedViaDeepLink: false,
      linkedFolderId: null,
      rememberedFolderId: null,
      folderIds: IDS,
    }),
    null,
  );
});

test('a deep link to an entity wins — the address is the consent', () => {
  assert.equal(
    initialFolderSelection({
      arrivedViaDeepLink: true,
      linkedFolderId: 'Аналитик',
      rememberedFolderId: 'Навигатор',
      folderIds: IDS,
    }),
    'Аналитик',
  );
});

test('a link naming a folder this install does not have is not honoured', () => {
  // Guards against trusting `linkedFolderId` blindly: the caller resolves the
  // name against /api/folders, and a stale or foreign name must not become a
  // selection that then fails to render.
  assert.equal(
    initialFolderSelection({
      arrivedViaDeepLink: true,
      linkedFolderId: 'SomeoneElse',
      rememberedFolderId: null,
      folderIds: IDS,
    }),
    IDS[0],
  );
});

test('a deep-link tab whose folder is gone falls back to the remembered one', () => {
  // This reader DID ask for an entity; the address just no longer resolves
  // (renamed or deleted). Landing somewhere is the pre-existing behaviour for
  // that path and is left alone — the change is scoped to the bare root.
  assert.equal(
    initialFolderSelection({
      arrivedViaDeepLink: true,
      linkedFolderId: null,
      rememberedFolderId: 'Cairn',
      folderIds: IDS,
    }),
    'Cairn',
  );
});

test('a remembered folder that no longer exists is skipped, not returned', () => {
  assert.equal(
    initialFolderSelection({
      arrivedViaDeepLink: true,
      linkedFolderId: null,
      rememberedFolderId: 'DeletedBeing',
      folderIds: IDS,
    }),
    IDS[0],
  );
});

test('an empty install returns null on every path', () => {
  // A fresh install has no inhabitants at all. Null here is what routes the
  // reader to the full user guide instead of the welcome pane.
  for (const arrivedViaDeepLink of [true, false]) {
    assert.equal(
      initialFolderSelection({
        arrivedViaDeepLink,
        linkedFolderId: 'Cairn',
        rememberedFolderId: 'Cairn',
        folderIds: [],
      }),
      null,
    );
  }
});
