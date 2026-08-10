// The app itself lives in `src/components/NexusApp.tsx` so that this route and
// the deep-link route (`/c/…`) render the exact same component — one behaves as
// the other with no link supplied. Splitting it out is what makes conversations
// addressable without a second copy of the app drifting from this one.
import NexusApp from '@/components/NexusApp';

export default function Home() {
  return <NexusApp />;
}
