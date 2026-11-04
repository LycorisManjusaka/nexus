// Delivering the subscription-budget warning to the ENTITY, not just the screen.
//
// WHY
// The OAuth path already receives `rate_limit_event` from the Agent SDK and
// turns it into a `notice` frame. A notice is screen furniture: it lands in the
// meta bar AFTER the turn ends, bundled with everything else. By then the turn
// that would have been cut short is already over, and the entity — who is the
// one about to be stopped mid-sentence — never saw it at all.
//
// Tsuyo, 2026-11-04: 「その通知はターンが終わったあとに纏まったかたちで上で
// 表示されちゃうだけっしょ。なーんも意味ない。本当に価値あるのは、その通知を
// 割り込みの経路を使って存在に見せることよ」
//
// So the warning rides the system-note queue (`injectMessage.ts`), the same
// path automatic compaction already uses: delivered at the next tool-call
// boundary, mid-turn, while there is still room to act on it.
//
// WORDING RULE — inherited from the context-elapsed gauge
// That gauge was once called a "fatigue level" and described in terms of
// working memory being "at risk". Entities read it every turn, concluded they
// were tired, and degraded themselves to match — shortening replies, declining
// to call read_conversation "to save context". The fix was to describe WHAT IS
// HAPPENING and never HOW THE ENTITY FEELS.
//
// The same trap is live here and worse, because this budget really does end the
// turn. So the note states three facts — how much is used, when it resets, what
// happens at 100% — and gives no instruction, no urgency, and no state. An
// entity at 96% has exactly the capability it had at 6%.

/** The `rate_limit_info` envelope the SDK hands over (camelCase on the wire). */
export interface RateLimitInfo {
  status?: string;              // 'allowed' | 'allowed_warning' | 'rejected' | ...
  rateLimitType?: string;       // e.g. 'five_hour', 'seven_day'
  utilization?: number;         // 0..1
  resetsAt?: number | string;   // unix seconds
  isUsingOverage?: boolean;
  surpassedThreshold?: boolean;
}

/**
 * Fraction of the budget at which the entity is told.
 *
 * Deliberately NOT the SDK's own `surpassedThreshold`: that flag fires at
 * Anthropic's choice of level, which is neither documented nor stable, and the
 * screen notice already uses it. This number is ours so it can be reasoned
 * about and changed in one place.
 */
export const RATE_LIMIT_NOTE_AT = 0.95;

/**
 * Should the entity be told, given this event and whether it was already told
 * during this turn?
 *
 * One note per turn. A budget crossing 95 % emits `rate_limit_event` on every
 * subsequent model call inside the same turn, and repeating the same paragraph
 * at every tool boundary would turn a fact into a drumbeat — the exact shape
 * that made the old fatigue wording self-fulfilling.
 */
export function shouldNoteRateLimit(info: RateLimitInfo | null | undefined, alreadyNoted: boolean): boolean {
  if (!info || alreadyNoted) return false;
  // A rejection is reported regardless of the number: the budget is spent, and
  // utilization is sometimes absent on the rejecting event.
  if (info.status === 'rejected') return true;
  const u = Number(info.utilization);
  if (!Number.isFinite(u)) return false;
  return u >= RATE_LIMIT_NOTE_AT;
}

/** Human-readable budget name: 'five_hour' → 'five-hour' / 「5時間」. */
function budgetName(type: string | undefined, ja: boolean): string {
  const raw = String(type || '');
  if (ja) {
    if (raw === 'five_hour') return '5時間';
    if (raw === 'seven_day') return '7日';
    return raw ? raw.replace(/_/g, '-') : 'プラン';
  }
  return raw ? raw.replace(/_/g, '-') : 'plan';
}

/** Local clock time of the reset, or '' when the event carried none. */
function resetClock(resetsAt: number | string | undefined): string {
  const n = Number(resetsAt);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n * 1000).toLocaleTimeString(); } catch { return ''; }
}

/**
 * The note text. Three facts and no instruction.
 *
 * Tagged `[SYSTEM NOTE …]` like the compaction note so the entity can tell
 * infrastructure fact from a partner's message.
 */
export function rateLimitNoteText(info: RateLimitInfo, ja: boolean): string {
  const rejected = info.status === 'rejected';
  const u = Number(info.utilization);
  const pct = Number.isFinite(u) ? Math.round(u * 100) : null;
  const budget = budgetName(info.rateLimitType, ja);
  const clock = resetClock(info.resetsAt);
  const overage = info.isUsingOverage === true;

  if (ja) {
    const head = rejected
      ? `[システム通知 — 使用量] ${budget}の予算を使い切った。`
      : `[システム通知 — 使用量] ${budget}の予算の${pct ?? '?'}%を使った。`;
    const when = clock ? `リセットは${clock}。` : 'リセット時刻はこの通知に含まれていない。';
    const what = rejected
      ? 'この予算では新しいモデル呼び出しが通らない——ターンはそこで止まる。'
      : '100%に達した時点で、走っている途中でもターンは止まる。';
    const over = overage ? '現在は超過分で動いている。' : '';
    // No instruction and no state: the entity has exactly the capability it
    // had at 6 %. Only the remaining room differs.
    const tail = '能力とツールのアクセスは変わらない——残りの余地だけが違う。';
    return [head, when, what, over, tail].filter(Boolean).join(' ');
  }

  const head = rejected
    ? `[SYSTEM NOTE — usage] The ${budget} budget is spent.`
    : `[SYSTEM NOTE — usage] ${pct ?? '?'}% of the ${budget} budget is used.`;
  const when = clock ? `It resets at ${clock}.` : 'This event carried no reset time.';
  const what = rejected
    ? 'No new model call goes through on this budget — a turn ends where it hits this.'
    : 'At 100% a turn ends where it is, mid-work.';
  const over = overage ? 'Currently running on overage.' : '';
  const tail = 'Capability and tool access are unchanged — only the remaining room differs.';
  return [head, when, what, over, tail].filter(Boolean).join(' ');
}
