import { Fragment, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ChevronRight, MailWarning, RotateCcw, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMessage, isScopeRefused, useCapabilities, useDeadEventTopics, useDeadEvents, type DeadEvent } from '../api';
import { Badge, Btn, EmptyState, ErrorBox, JsonBlock, PageHeader, ScopeRefusedState, Spinner, StatStrip, cn } from '../components';
import { toast } from '../ui';
import { Stagger, StaggerItem } from '../motion';
// I18n init side effect: so useTranslation still works if this view is rendered directly
// (without App) (see src/i18n/index.ts) — main.tsx already does this, this re-guarantees it here.
import '../i18n';

// Same double-coding rule as the Jobs table: a decorative glyph beside a text Badge, never colour alone.
function tone(s: DeadEvent['status']) {
  return s === 'delivered' ? 'success' : s === 'released' ? 'warning' : 'destructive';
}
function StatusGlyph({ s }: { s: DeadEvent['status'] }) {
  if (s === 'delivered') return <span aria-hidden className="text-success">✓</span>;
  if (s === 'released') return <span aria-hidden className="text-warning">↻</span>;
  return <span aria-hidden className="text-destructive">✗</span>;
}

const fmtTime = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '—');

/**
 * Dead-letter (@gnldev/events quarantine): what a poison event cost, and the way back out.
 *
 * WHY THIS IS NOT THE JOBS VIEW WITH DIFFERENT NOUNS. A queue hands one job to one worker; a topic
 * FANS OUT, so an event that fails carries one dead-letter record PER CONSUMER and is addressed by
 * `(topic, consumer, id)`. That is why this page starts with a topic/consumer picker instead of a
 * list: there is no "all dead events" to show, and pretending otherwise would mean scanning every
 * topic log the deployment has.
 *
 * AND WHY IT DOES NOT AUTO-REFRESH. `listDeadEvents` reads the whole topic log with a `get` per event
 * — the O(n) scan @gnldev/events' cursor exists to keep out of the delivery path. `useJobs` polls
 * every 3s; doing that here would re-scan every event a topic has ever carried, twenty times a
 * minute, for as long as the tab is open. The Refresh button is the refresh.
 */
export function DeadEvents() {
  const { t } = useTranslation('deadEvents');
  const caps = useCapabilities();
  const qc = useQueryClient();
  const topics = useDeadEventTopics();
  const [topic, setTopic] = useState('');
  const [consumer, setConsumer] = useState('');
  // What the list is actually SHOWING, as opposed to what is typed in the two boxes. Kept separate on
  // purpose: the fetch is expensive, so it must be an explicit act. Binding the query straight to the
  // inputs would fire a whole-log scan on every keystroke of a hand-typed topic name.
  const [shown, setShown] = useState<{ topic: string; consumer: string } | null>(null);
  const dead = useDeadEvents(shown?.topic ?? null, shown?.consumer ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * ONE open row at a time, and the detail row is not rendered until it is opened.
   *
   * Not `truncate` + `title`: the last error is the page's main evidence, and a native tooltip is
   * delivered by hover — a keyboard or touch user could not read the end of it at all. Not an
   * always-mounted detail row either: this list has no upper bound, and 200 rows would mean 200
   * mounted `JsonBlock` trees for the one an operator is actually looking at.
   *
   * Both pieces of evidence in here — the error text and the body — can be withheld from a caller
   * without `payloads:read`, and the expander is where that is EXPLAINED rather than merely observed.
   */
  const [openRow, setOpenRow] = useState<number | null>(null);
  const canRelease = !!caps.data?.eventsManage;

  const consumerOptions = useMemo(
    () => topics.data?.find((x) => x.topic === topic)?.consumers ?? [],
    [topics.data, topic],
  );

  const load = () => {
    const tp = topic.trim();
    const cs = consumer.trim();
    if (!tp || !cs) return;
    setShown({ topic: tp, consumer: cs });
    // Row indices address the open row, and a new list renumbers them — leaving it open would expand
    // whichever record happens to land in that slot.
    setOpenRow(null);
    // Same pair as last time → `staleTime: Infinity` would otherwise serve the cached scan, so the
    // button would look like it did nothing. This is the ONE place a re-scan is wanted.
    qc.invalidateQueries({ queryKey: ['dead-events', tp, cs] });
  };

  const release = async (e: DeadEvent) => {
    if (busyId != null) return;
    setBusyId(e.id);
    try {
      await api.releaseDeadEvent(e.topic, e.consumer, e.id);
      toast.success(t('releaseSuccess', { id: e.id, consumer: e.consumer }));
      // The record is updated IN PLACE (it becomes `released`), so this refreshes one row's state —
      // it does not add a second one the way a job retry does.
      qc.invalidateQueries({ queryKey: ['dead-events', e.topic, e.consumer] });
    } catch (err) {
      toast.error(t('releaseError', { error: errMessage(err) }));
    } finally {
      setBusyId(null);
    }
  };

  if (caps.isLoading) return <Spinner />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  if (isScopeRefused(caps.data, 'deadEvents')) return <ScopeRefusedState icon={MailWarning} what="events" />;
  if (!caps.data?.deadEvents) {
    return <EmptyState icon={MailWarning} title={t('disabledTitle')} description={t('disabledDescription')} />;
  }

  const rows = dead.data ?? [];
  const cols = 6 + (canRelease ? 1 : 0);
  /**
   * `—` until a list has actually been scanned, never `0`.
   *
   * The server refuses a request that names no consumer for exactly this reason — "answering it with
   * an empty list would read as 'nothing is quarantined'" — and three zeroes on a page where nothing
   * has been loaded yet make that same claim in the largest type on the screen. The strip still
   * renders, so the list below it does not jump down the page once the scan lands.
   */
  const loaded = dead.data !== undefined && !dead.error;
  const count = (...ss: DeadEvent['status'][]) =>
    (loaded ? String(rows.filter((e) => ss.includes(e.status)).length) : '—');

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0">
        <PageHeader title={t('title')} description={t('description')} />
      </div>
      <StatStrip items={[
        { label: t('statQuarantined'), value: count('quarantined') },
        { label: t('statReleased'), value: count('released') },
        { label: t('statDelivered'), value: count('delivered') },
      ]} />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-0.5">
              <label htmlFor="dead-events-topic" className="microlabel text-muted-foreground">{t('topicLabel')}</label>
              {/* A datalist rather than a select: the host's `topics()` is optional, and when it
                  returns nothing the operator can still type a name instead of facing a dead
                  dropdown. One control, both cases. */}
              <input
                id="dead-events-topic" list="dead-events-topic-options" value={topic}
                onChange={(ev) => { setTopic(ev.target.value); setConsumer(''); }}
                placeholder={t('topicPlaceholder')}
                className="w-56 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none"
              />
              <datalist id="dead-events-topic-options">
                {topics.data?.map((x) => <option key={x.topic} value={x.topic} />)}
              </datalist>
            </div>
            <div className="flex flex-col gap-0.5">
              <label htmlFor="dead-events-consumer" className="microlabel text-muted-foreground">{t('consumerLabel')}</label>
              <input
                id="dead-events-consumer" list="dead-events-consumer-options" value={consumer}
                onChange={(ev) => setConsumer(ev.target.value)}
                placeholder={t('consumerPlaceholder')}
                className="w-56 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none"
              />
              <datalist id="dead-events-consumer-options">
                {consumerOptions.map((name) => <option key={name} value={name} />)}
              </datalist>
            </div>
            <Btn
              size="xs" variant="outline" busy={dead.isFetching}
              disabled={!topic.trim() || !consumer.trim()}
              onClick={load} title={t('loadTitle')}
            >
              <RefreshCw size={11} /> {shown ? t('refreshButton') : t('loadButton')}
            </Btn>
          </div>
          {/* Persistent, not a placeholder: the cost is the reason this page has a button at all. */}
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t('scanCostHelp')}</p>
        </div>

        {dead.error && <div className="mt-3"><ErrorBox error={dead.error} /></div>}

        {!shown && !dead.error && (
          <EmptyState icon={MailWarning} title={t('pickTitle')} description={t('pickDescription')} />
        )}

        {/* The longest wait in the application, and its only feedback used to be the button's own
            `aria-busy` — a screen reader was never told the list had arrived. `Spinner` carries
            `role="status"`, the same way `Jobs.tsx` announces its (far shorter) first load. */}
        {shown && dead.isLoading && !dead.error && <Spinner label={t('scanning')} />}

        {shown && !dead.error && !dead.isLoading && rows.length === 0 && (
          <EmptyState
            icon={MailWarning}
            title={t('emptyTitle', { topic: shown.topic, consumer: shown.consumer })}
            description={t('emptyDescription')}
          />
        )}

        {rows.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-md border border-border bg-background">
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pl-3 pr-3 font-medium">{t('colId')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('colStatus')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('colAttempts')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('colReleases')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('colQuarantinedAt')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('colError')}</th>
                  {canRelease && <th className="py-1.5 pr-3 font-medium" />}
                </tr>
              </thead>
              <Stagger as={motion.tbody}>
                {rows.map((e, i) => {
                  const open = openRow === i;
                  return (
                  <Fragment key={`${e.consumer}:${e.id}`}>
                  <StaggerItem as={motion.tr} className="border-b border-border/60 last:border-b-0">
                    <td className="py-1.5 pl-3 pr-3 text-xs">
                      {/* A REAL button, not the decorative `›` this replaces. It is the only way to
                          reach the untruncated error and the event body, so it has to be reachable by
                          keyboard and announce its state — which is also why it is a plain <button>
                          rather than <Btn>: Btn passes no `aria-expanded`/`aria-controls` through, and
                          a disclosure without them is a control a screen reader cannot read. */}
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={`dead-detail-${i}`}
                        onClick={() => setOpenRow(open ? null : i)}
                        title={open ? t('detailsHide') : t('detailsShow')}
                        className="inline-flex items-center gap-1 rounded-sm text-left transition-colors hover:text-brand focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"
                      >
                        <ChevronRight size={11} aria-hidden className={cn('shrink-0 text-brand transition-transform', open && 'rotate-90')} />
                        {e.id}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusGlyph s={e.status} />
                        <Badge tone={tone(e.status)}>{t(`status.${e.status}`)}</Badge>
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{e.attempts}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{e.releases ?? 0}</td>
                    <td className="py-1.5 pr-3 text-xs text-muted-foreground">{fmtTime(e.at)}</td>
                    {/* Still truncated, but no longer the ONLY copy: the expander below carries the
                        full text, so `title` is a convenience for a mouse rather than the sole way in.

                        `errorRestricted` renders as muted words rather than an empty cell, and the
                        distinction is the same one the body makes: a blank error column reads as "it
                        failed for no recorded reason", which is a claim about the RECORD, when the
                        truth is a fact about the VIEWER. The rest of the row — status, attempts,
                        releases, timestamp — still answers how much is stuck and whether releasing it
                        has helped. */}
                    {e.errorRestricted
                      ? <td className="max-w-[22rem] truncate py-1.5 pr-3 text-xs italic text-muted-foreground" title={t('errorRestricted')}>{t('errorRestrictedShort')}</td>
                      : <td className="max-w-[22rem] truncate py-1.5 pr-3 text-xs text-destructive" title={e.error}>{e.error}</td>}
                    {canRelease && (
                      <td className="py-1.5 pr-3">
                        {/* `delivered` is the ONE terminal state — the consumer saw the event, and
                            retryDeadEvent refuses it (the server turns that into a 409). `released`
                            still gets a button, and that is not a copy-paste slip: a release whose
                            rescan flag was swallowed by an in-flight poll leaves the event released
                            and unscanned, and re-asserting the release is the documented — and only —
                            way back out. It is labelled differently so it does not read as a
                            no-op repeat. */}
                        {e.status !== 'delivered' && (
                          /* `busy` as well as `disabled`, and they are not the same claim. `disabled`
                             on every row is what keeps a second release from starting; `busy` is what
                             says WHICH row is going — without it the only thing spinning was the
                             Refresh button at the top of the page, because that one is bound to
                             `dead.isFetching`. See Btn's own JSDoc: a greyed-out control with nothing
                             moving is indistinguishable from a page that stopped responding. */
                          <Btn
                            size="xs" variant="outline" disabled={busyId !== null} busy={busyId === e.id}
                            onClick={() => void release(e)}
                            title={e.status === 'released' ? t('releaseAgainTitle') : t('releaseTitle')}
                          >
                            <RotateCcw size={11} /> {e.status === 'released' ? t('releaseAgainButton') : t('releaseButton')}
                          </Btn>
                        )}
                      </td>
                    )}
                  </StaggerItem>
                  {/* Mounted only while open — one JsonBlock, for the row being looked at. */}
                  {open && (
                    <tr id={`dead-detail-${i}`} className="border-b border-border/60 bg-muted/20 last:border-b-0">
                      <td colSpan={cols} className="px-3 py-2">
                        <div className="microlabel mb-1 text-muted-foreground">{t('detailErrorLabel')}</div>
                        {/* Same rule as the body below: withheld is SAID, not left blank. */}
                        {e.errorRestricted
                          ? <p className="mb-3 text-[11px] text-muted-foreground">{t('errorRestricted')}</p>
                          : <pre className="mb-3 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] text-destructive">{e.error}</pre>}
                        <div className="microlabel mb-1 text-muted-foreground">{t('detailPayloadLabel')}</div>
                        {/* The body is what a release actually re-runs a handler on, so it is the one
                            piece of evidence this decision needs. The server withholds it from a
                            caller without `payloads:read` and says so per record — an absent `payload`
                            on its own could equally mean the event carried none. */}
                        {e.payloadRestricted
                          ? <p className="text-[11px] text-muted-foreground">{t('payloadRestricted')}</p>
                          : <JsonBlock value={e.payload} max={600} />}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </Stagger>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
