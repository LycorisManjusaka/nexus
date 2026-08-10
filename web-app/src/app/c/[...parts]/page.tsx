import NexusApp from '@/components/NexusApp';
import { parseDeepLinkParts } from '@/lib/deepLink';

// Deep-link route. Renders the same app as `/`, with an initial target:
//
//   /c/<folder>                          → folder, top conversation in the list
//   /c/<folder>/<convoId>                → that conversation
//   /c/<folder>/<convoId>/m/<messageId>  → that conversation, scrolled to a message
//
// Anything unparseable resolves to `null` and the app opens exactly as `/` does,
// so a mangled or truncated link is never a crash.

export const dynamic = 'force-dynamic';

export default async function DeepLinkPage({
  params,
}: {
  // Next 16: route params arrive as a Promise and must be awaited.
  params: Promise<{ parts?: string[] }>;
}) {
  const { parts } = await params;
  return <NexusApp deepLink={parseDeepLinkParts(parts)} />;
}
