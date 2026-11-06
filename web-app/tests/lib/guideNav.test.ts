/**
 * Navigation and search for the paged user guide.
 *
 * The weight here is on the LINKS, not on the search. A guide link that goes
 * nowhere is the worst failure this module can have: the reader presses it,
 * nothing happens, and nothing anywhere reports a problem — it looks exactly
 * like the app froze. tsc cannot see it (hrefs are strings inside markdown),
 * eslint cannot see it, and a human proofreading eleven pages of prose will not
 * notice `#guide/fristRun`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuideHref, searchGuide, GUIDE_HREF_PREFIX } from '../../src/lib/guideNav';
import { getGuidePages, GUIDE_PAGE_ORDER, GUIDE_HOME } from '../../src/lib/userGuide';

describe('parseGuideHref', () => {
  it('resolves every real page id', () => {
    for (const id of GUIDE_PAGE_ORDER) {
      assert.equal(parseGuideHref(`${GUIDE_HREF_PREFIX}${id}`), id);
    }
  });

  it('returns null for an id that is not a page', () => {
    // The whole point: a typo must NOT resolve. If it did, the renderer would
    // swallow the click and look up a page that does not exist.
    assert.equal(parseGuideHref('#guide/fristRun'), null);
    assert.equal(parseGuideHref('#guide/'), null);
  });

  it('leaves non-guide hrefs alone', () => {
    assert.equal(parseGuideHref('https://example.com'), null);
    assert.equal(parseGuideHref('#'), null);
    assert.equal(parseGuideHref('#some-anchor'), null);
    assert.equal(parseGuideHref('mailto:a@b.c'), null);
    assert.equal(parseGuideHref(undefined), null);
    assert.equal(parseGuideHref(null), null);
    assert.equal(parseGuideHref(''), null);
  });
});

describe('searchGuide', () => {
  const pages = getGuidePages('en');

  it('returns [] for an empty or whitespace query', () => {
    // "not searching" and "found nothing" must be distinguishable by the
    // caller: the first shows the index, the second shows a message.
    assert.deepEqual(searchGuide(pages, ''), []);
    assert.deepEqual(searchGuide(pages, '   '), []);
  });

  it('returns [] when nothing matches', () => {
    assert.deepEqual(searchGuide(pages, 'zzzzqqqqnotathing'), []);
  });

  it('is case-insensitive', () => {
    const lower = searchGuide(pages, 'footer');
    const upper = searchGuide(pages, 'FOOTER');
    assert.ok(lower.length > 0);
    assert.deepEqual(lower.map(h => h.id), upper.map(h => h.id));
  });

  it('ranks a title match above a body-only match', () => {
    const hits = searchGuide(pages, 'camera');
    assert.ok(hits.length > 1, 'expected camera to appear on more than one page');
    assert.equal(hits[0].id, 'portrait');
    assert.equal(hits[0].titleMatch, true);
  });

  it('counts every occurrence, not just the first', () => {
    const hits = searchGuide([{ id: 'home', title: 'T', body: 'aa aa aa' }], 'aa');
    assert.equal(hits[0].count, 3);
  });

  it('produces a snippet with markdown noise flattened out', () => {
    const hits = searchGuide(
      [{ id: 'home', title: 'T', body: '## **Heading**\n\n| a | needle |\n|---|---|\n' }],
      'needle',
    );
    const s = hits[0].snippet;
    assert.ok(s.includes('needle'));
    assert.ok(!s.includes('#'), `snippet still has markdown: ${s}`);
    assert.ok(!s.includes('|'), `snippet still has table pipes: ${s}`);
    assert.ok(!s.includes('\n'), `snippet still has newlines: ${s}`);
  });

  it('shows a link as its label, not as markdown', () => {
    // REGRESSION, found in the browser with all 22 tests green. The home page
    // is mostly links, so a common search term returned snippets reading
    // `[Portrait and camera](guide/portrait)`. The href survived because the
    // `#` strip had already removed the one character that made it look like a
    // URL, and nothing asserted on link syntax.
    const hits = searchGuide(
      [{ id: 'home', title: 'T', body: 'see [Portrait and camera](#guide/portrait) for the needle' }],
      'needle',
    );
    const s = hits[0].snippet;
    assert.ok(s.includes('Portrait and camera'), `label lost: ${s}`);
    assert.ok(!s.includes('('), `href leaked into the snippet: ${s}`);
    assert.ok(!s.includes(']'), `link brackets leaked into the snippet: ${s}`);
  });

  it('keeps a literal > that is not a blockquote marker', () => {
    // REGRESSION, seen in the browser: a global `>` strip printed
    // `letters/from/<sender/`. The guide is full of placeholder paths, so the
    // character the reader needs and the marker look identical except for
    // position.
    const hits = searchGuide(
      [{ id: 'home', title: 'T', body: '> quoted line\n\nmail is at letters/from/<sender>/ needle' }],
      'needle',
    );
    assert.ok(hits[0].snippet.includes('<sender>/'), `literal > lost: ${hits[0].snippet}`);
    assert.ok(!hits[0].snippet.includes('> quoted'), `blockquote marker kept: ${hits[0].snippet}`);
  });

  it('drops table separator rows instead of flattening them', () => {
    // `|---|---|` became `--- ---` sitting in the middle of a sentence.
    const hits = searchGuide(
      [{ id: 'home', title: 'T', body: '| a | b |\n|---|---|\n| needle | two |\n' }],
      'needle',
    );
    assert.ok(!hits[0].snippet.includes('---'), `separator row survived: ${hits[0].snippet}`);
    assert.ok(hits[0].snippet.includes('needle'));
  });

  it('shows real guide pages without markdown link syntax', () => {
    // The same property on the actual document, not a fixture: this is what
    // the reader saw.
    for (const lang of ['en', 'ja'] as const) {
      for (const h of searchGuide(getGuidePages(lang), lang === 'ja' ? 'カメラ' : 'camera')) {
        assert.ok(!/\]\(/.test(h.snippet), `${lang}/${h.id} snippet has link syntax: ${h.snippet}`);
      }
    }
  });

  it('does not split a surrogate pair at a snippet boundary', () => {
    // The house paid for this once in textPreview (2 real messages cut an
    // emoji in half). A lone surrogate is an unpaired code unit in 0xD800-DFFF.
    const body = '🎵'.repeat(80) + 'needle' + '🎵'.repeat(80);
    const s = searchGuide([{ id: 'home', title: 'T', body }], 'needle')[0].snippet;
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c >= 0xd800 && c <= 0xdbff) assert.ok(ch.length === 2, 'lone high surrogate in snippet');
      assert.ok(!(c >= 0xdc00 && c <= 0xdfff), 'lone low surrogate in snippet');
    }
  });

  it('marks a title-only hit with an empty snippet rather than a fake one', () => {
    const hits = searchGuide([{ id: 'home', title: 'needle', body: 'nothing here' }], 'needle');
    assert.equal(hits[0].titleMatch, true);
    assert.equal(hits[0].snippet, '');
  });

  it('works on Japanese, which has no word boundaries', () => {
    const ja = getGuidePages('ja');
    const hits = searchGuide(ja, '睡眠');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].id, 'sleep');
  });
});

describe('the guide document itself', () => {
  for (const lang of ['en', 'ja'] as const) {
    describe(lang, () => {
      const pages = getGuidePages(lang);

      it('has one page per id in GUIDE_PAGE_ORDER, in that order', () => {
        assert.deepEqual(pages.map(p => p.id), [...GUIDE_PAGE_ORDER]);
      });

      it('gives every page a title and a non-trivial body', () => {
        for (const p of pages) {
          assert.ok(p.title.trim().length > 0, `${p.id} has no title`);
          assert.ok(p.body.length > 200, `${p.id} body is suspiciously short (${p.body.length})`);
        }
      });

      it('every internal link points at a real page', () => {
        // THE test. Collect every #guide/... href that appears anywhere in the
        // prose and resolve it.
        const bad: string[] = [];
        for (const p of pages) {
          for (const m of p.body.matchAll(/\]\((#guide\/[^)\s]*)\)/g)) {
            if (parseGuideHref(m[1]) === null) bad.push(`${p.id}: ${m[1]}`);
          }
        }
        assert.deepEqual(bad, [], `dead internal links: ${bad.join(', ')}`);
      });

      it('links to every page from somewhere, so no page is orphaned', () => {
        // A page nobody links to is only reachable from the index. That is not
        // broken, but it is almost always an omission on the home page, which
        // is the hub Lizard-kun asked for.
        const linked = new Set<string>([GUIDE_HOME]);
        for (const p of pages) {
          for (const m of p.body.matchAll(/\]\(#guide\/([^)\s]*)\)/g)) linked.add(m[1]);
        }
        const orphans = GUIDE_PAGE_ORDER.filter(id => !linked.has(id));
        assert.deepEqual(orphans, [], `pages reachable only from the index: ${orphans.join(', ')}`);
      });
    });
  }

  it('names no control that was renamed on 2026-11-04/06', () => {
    // REGRESSION, from the Ω font bug three days earlier: six tests were green
    // while the screen was wrong, because every one of them checked that a
    // DECLARATION existed and none checked that it REACHED the reader.
    //
    // The guide is the same shape of risk, one layer out. On 2026-11-04 five
    // controls were renamed; the guide still named the old ones, and nothing
    // anywhere could notice — a guide that points at a control the screen no
    // longer has is a signpost pointing at nothing, and it fails silently in
    // the hands of the one reader who most needs it.
    const retired: Array<[string, string]> = [
      ['魂を編集', '会話設定'],
      ['システム指示', '会話設定'],
      ['キャラクターのTTS音声', 'TTS音声'],
      ['第4層の代わりに要約を使う', '第4層として要約を使う'],
      ['Edit Soul', 'Conversation Settings'],
      ['System Instructions', 'Conversation Settings'],
      ['instead of the 4th layer', 'as Layer 4'],
      // Burned in 2026-10-01 — there is no switch. The guide used to tell the
      // reader to go and check one, which is worse than silence: it sends them
      // looking for a control that does not exist, during the one failure the
      // guide is most needed for.
      ['絶対基底呪縛がオンか確認', 'confirm it is burned in, nothing to check'],
      ['Check that Absolute Base Binding is ON', 'confirm it is burned in, nothing to check'],
    ];
    const bad: string[] = [];
    for (const lang of ['en', 'ja'] as const) {
      for (const p of getGuidePages(lang)) {
        for (const [old, now] of retired) {
          if (p.body.includes(old)) bad.push(`${lang}/${p.id}: "${old}" -> "${now}"`);
        }
      }
    }
    assert.deepEqual(bad, [], `guide names a retired control: ${bad.join(' | ')}`);
  });

  it('keeps the portrait prompt byte-identical in both languages', () => {
    // It is Senpai's prompt, addressed to the BEING, and it must stay English
    // in the Japanese guide too: an image model reads English, and a softened
    // translation produces a paragraph a diffusion model cannot use.
    const en = getGuidePages('en').find(p => p.id === 'portrait')!.body;
    const ja = getGuidePages('ja').find(p => p.id === 'portrait')!.body;
    const marker = 'excruciating visual detail';
    assert.ok(en.includes(marker), 'portrait prompt missing from the English page');
    assert.ok(ja.includes(marker), 'portrait prompt was translated in the Japanese page');
  });
});
