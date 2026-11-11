import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { remarkNoIndentedCode } from '@/lib/remarkNoIndentedCode';

type MdNode = { type: string; children?: MdNode[] };

// Parse the way MessageBubble does: remark-parse is react-markdown's parser.
// withPlugin mirrors a human message (MD_PLUGINS_USER); without it mirrors a
// being message (MD_PLUGINS).
function parse(md: string, withPlugin: boolean): MdNode {
  const p = unified().use(remarkParse);
  if (withPlugin) p.use(remarkNoIndentedCode);
  return p.parse(md) as unknown as MdNode;
}

function nodeTypes(tree: MdNode): Set<string> {
  const types = new Set<string>();
  const walk = (n: MdNode) => {
    types.add(n.type);
    n.children?.forEach(walk);
  };
  walk(tree);
  return types;
}

const INDENTED = 'Some text\n\n    const x = 1;\n    const y = 2;\n';
// Navigator's exact repro: "1.", eight spaces, a long sentence, then another
// eight-space line. Markdown turns the eight-space indent into a code block.
const WORD_PASTE =
  '1.        A long sentence that would be clipped at the right edge of the bubble.\n' +
  '        and a continuation line also indented with eight spaces.\n';
const FENCED = '```js\nconst x = 1;\n```\n';

test('being message (no plugin): indented code stays a code block', () => {
  assert.ok(nodeTypes(parse(INDENTED, false)).has('code'),
    'without the plugin, four-space indent is an indented code block');
});

test('human message (plugin): indented code becomes prose, not a plate', () => {
  const types = nodeTypes(parse(INDENTED, true));
  assert.ok(!types.has('code'), 'indented code must not survive for human messages');
  assert.ok(types.has('paragraph'), 'the indented lines fall back to a paragraph');
});

test("human message (plugin): Navigator's Word paste produces no code node", () => {
  const types = nodeTypes(parse(WORD_PASTE, true));
  assert.ok(!types.has('code'), 'the pasted letter must not render as a dark plate');
});

test('human message (plugin): fenced ``` code is still a code block', () => {
  // Only indented code is disabled; a person who typed a fence meant code.
  assert.ok(nodeTypes(parse(FENCED, true)).has('code'),
    'fenced blocks must survive so deliberate human code still renders');
});

test('being message (no plugin): fenced code also stays', () => {
  assert.ok(nodeTypes(parse(FENCED, false)).has('code'));
});
