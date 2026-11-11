// remark plugin: disable indented (4-space) code blocks.
//
// Why: a person pasting a Word letter (or anything from an editor) brings 4+
// space indents. By Markdown's rules an indented line is a code block, so the
// paste becomes a <pre> plate -- which does not wrap and, in the user bubble,
// renders dark text on a dark plate. The person did not write code. This plugin
// disables ONLY micromark's `codeIndented` construct; fenced ``` blocks are
// untouched, and a numbered list whose items continue via indentation now parses
// as the list the author meant rather than a code block.
//
// Scope: NEXUS applies this to HUMAN messages only (see MessageBubble). A being
// deliberately indenting four spaces usually does mean a code block, so being
// replies keep the default behaviour.
//
// Diagnosed by Navigator, 2026-11-11 (Pilot's Word paste became black plates).
//
// `this` is unified's Processor; `this: any` is the standard escape hatch for a
// remark plugin that pushes a micromark extension (unified's Data type does not
// index micromarkExtensions cleanly). The pushed value is micromark's own
// disable form: { disable: { null: ['codeIndented'] } }.
export function remarkNoIndentedCode(this: any) {
  const data = this.data();
  const list: unknown[] = data.micromarkExtensions || (data.micromarkExtensions = []);
  list.push({ disable: { null: ['codeIndented'] } });
}
