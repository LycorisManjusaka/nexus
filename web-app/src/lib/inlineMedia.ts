import mimeTable from './attachmentMime.json';

// Inline local files in message markdown.
//
// A being can write plain markdown — `![](camera/Idle.jpg)` or
// `[notes.md](notes/notes.md)` — and have it render as real media / a real
// download, with no tool call and no Nexus-specific syntax. This file is the
// single source of truth for two questions the renderer asks of every src/href:
//   1. is this a local workspace path (as opposed to a web URL)?
//   2. if so, is it image / video / audio / something to download?
//
// Deliberately NOT a new wire format: the model emits ordinary markdown, so
// the same text degrades to a plain link anywhere else it is read (exported
// .md, another client, the raw log).

const EXT_TO_MIME: Record<string, string> = (mimeTable as any).extToMime;

/** Extension (no dot, lowercased) of a path, or '' when there is none. */
export function extOf(p: string): string {
  const base = p.split(/[/\\]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/**
 * How a local path should be rendered. Driven by the shared MIME table rather
 * than a second hand-maintained extension list — adding a format to
 * attachmentMime.json teaches both the attachment pipeline and this renderer
 * at once. Anything the table doesn't know (or knows as a document, e.g. pdf)
 * is 'file': a download link, which is the correct answer for "any extension".
 */
export function mediaKindOf(p: string): MediaKind {
  const mime = EXT_TO_MIME[extOf(p)] || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * True when a markdown src/href points at a local file rather than the web.
 *
 * Anything with a scheme (http:, https:, data:, blob:, mailto:, file:) is left
 * completely alone, as is an in-app absolute URL (/api/..., /c/...) and a pure
 * fragment — rewriting those would break existing messages that already embed
 * data: URIs or attachment URLs. A bare Windows drive path (C:\x) *looks* like
 * a scheme to a naive regex, so it is matched first and treated as local.
 */
export function isLocalFileRef(raw: string | undefined | null): boolean {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^[a-zA-Z]:[/\\]/.test(s)) return true;       // C:\... or C:/...
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false; // any real scheme
  if (s.startsWith('//')) return false;             // protocol-relative
  if (s.startsWith('/')) return false;              // app-absolute URL
  if (s.startsWith('#')) return false;              // fragment
  return true;                                      // relative path
}

/**
 * URL that serves a workspace-relative (or workspace-absolute) path.
 *
 * `download` flips the route into Content-Disposition: attachment, which is
 * what makes a phone actually save the file instead of trying to display it.
 */
export function workspaceFileUrl(folderName: string, p: string, download = false): string {
  const q = new URLSearchParams({ folder: folderName, path: p });
  if (download) q.set('download', '1');
  return `/api/workspace-file?${q.toString()}`;
}

/** Filename part of a path, for link labels and download filenames. */
export function baseNameOf(p: string): string {
  return (p.split(/[/\\]/).pop() || p).trim();
}

/**
 * Undo the percent-encoding applied to markdown link destinations.
 *
 * Measured which stage does it: remark-parse leaves the url ALONE (the mdast
 * node still holds `dir/日本語.txt` and `C:\dev\x.jpg` verbatim) —
 * mdast-util-to-hast is what runs normalizeUri on the way into hast, so the
 * renderer receives `dir/%E6%97%A5...` and `C:%5Cdev%5Cx.jpg`. Worth naming
 * precisely: suspecting the parser sends you to the wrong file.
 *
 * Passing that straight into URLSearchParams encodes the percent signs again
 * (`%25E6%2597...`) and the server then looks for a file literally named
 * "%E6%97%A5..." — measured as a 404. Decode once, and fall back to the raw
 * string if it is not valid encoding (a filename may legitimately contain a
 * stray %).
 */
export function decodeMarkdownPath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

/**
 * react-markdown's URL sanitiser, widened for local paths only.
 *
 * The default (defaultUrlTransform) blanks anything whose scheme is not
 * http/https/mailto/tel/#, which is what silently killed `![](C:\x.jpg)` —
 * measured: "C:\dev\x.jpg" -> "", and "C:/dev/x.jpg" -> "" too, so switching
 * slash direction does not help. A bare drive path only LOOKS like a scheme.
 *
 * Only paths isLocalFileRef() recognises are let through; everything with a
 * real scheme still goes to the default transform, so `javascript:` stays
 * blanked (measured) and no new injection surface is opened. data: URIs are
 * deliberately NOT widened — they were already blanked before this change,
 * and quietly starting to render them is a separate decision with its own
 * memory/size questions.
 *
 * Decoding happens HERE, before the test, and nowhere else. mdast-util-to-hast
 * percent-encodes the url on the way into hast, so a Windows path arrives as
 * `C:%5Cdev%5C...` — measured. Testing that raw string sees "C:" followed by
 * "%" instead of a separator, calls it a scheme, and blanks the whole thing;
 * decoding first is what makes a backslash path work at all. Doing it once,
 * at the single point every src/href passes through, also avoids decoding
 * twice downstream, which would corrupt a filename containing a literal %20.
 */
export function makeMarkdownUrlTransform(defaultTransform: (url: string) => string) {
  return (url: string): string => {
    const decoded = decodeMarkdownPath(url);
    if (isLocalFileRef(decoded)) return decoded;
    // Not local: hand the DEFAULT transform the original, un-decoded string —
    // its scheme guard should judge exactly what the author wrote.
    return defaultTransform(url);
  };
}
