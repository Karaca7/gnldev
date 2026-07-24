import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion';
import type { ComponentType, ReactNode } from 'react';

/**
 * GNL Studio motion layer — framer-motion wrappers (D-motion foundation).
 *
 * Signature principle (frontend-design + uipro): not a generic fade, but a single orchestrated
 * moment from GNL's "journal" world — page entry appears with a subtle upward slide like a
 * terminal prompt, list/table rows arrive as if being appended to the journal in sequence.
 * Durations stay in the 150-300ms band, ONLY transform/opacity (no layout thrash, GPU-friendly).
 *
 * prefers-reduced-motion: the global `* { transition-duration: 0.01ms }` in index.css only
 * stops CSS transitions — since framer-motion runs on JS/WAAPI it doesn't see that rule.
 * That's why EVERY wrapper here makes its own decision via `useReducedMotion()`: it renders a
 * plain `<div>` while reduced motion is on (no animation, no jump, DOM structure unaffected).
 *
 * Usage (for POLISH layers):
 *   <PageTransition routeKey={pathname}>...</PageTransition>   → App.tsx route/view transition
 *   <Stagger><StaggerItem>row 1</StaggerItem>...</Stagger>     → list/table journal-append
 *   <Reveal>...</Reveal>                                        → card/section appearing on scroll
 */

// "Signature" soft-settle ease — snappy but not harsh, fits the uipro 150-300ms band.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// ---- PageTransition: route/view transition (wraps App.tsx main content) --------------------
const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.14, ease: EASE_OUT } },
};

/** When the route changes, the current view fades subtly upward while the new one appears from
 *  below like a terminal prompt. When `routeKey` changes (e.g. `location.pathname`) it triggers
 *  the AnimatePresence exit→enter. `mode="wait"`: the new one doesn't enter until the old one
 *  has fully exited → no layout jump. */
export function PageTransition({ routeKey, children }: { routeKey: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={routeKey} variants={pageVariants} initial="initial" animate="animate" exit="exit" style={{ height: '100%' }}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ---- Stagger / StaggerItem: list & table rows appearing in sequence (journal-append) -------
const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
};
const staggerItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } },
};

type MotionTag = ComponentType<any>;

/** A list/table container whose children are `StaggerItem` — each row appears ~45ms apart
 *  (feels like being written to the journal in sequence). `as` can be given `motion.ul`/`motion.tbody`
 *  (default `motion.div`). Under reduced motion it's a plain container, no animation. */
export function Stagger({
  children, className, as,
}: { children: ReactNode; className?: string; as?: MotionTag }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  const Comp = as ?? motion.div;
  return (
    <Comp className={className} variants={staggerContainer} initial="hidden" animate="show">
      {children}
    </Comp>
  );
}

/** A single row/card inside `Stagger` — inherits its variant from the parent. `as` can be
 *  given `motion.li`/`motion.tr` (default `motion.div`). */
export function StaggerItem({
  children, className, as,
}: { children: ReactNode; className?: string; as?: MotionTag }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  const Comp = as ?? motion.div;
  return (
    <Comp className={className} variants={staggerItem}>
      {children}
    </Comp>
  );
}

// ---- Reveal: a single item appearing on scroll into view (card/section) ---------------------
/** Appears subtly upward when it enters the viewport, once (`viewport.once`) — doesn't
 *  re-trigger repeatedly and distract as the page is scrolled down. `delay` (s) is optional
 *  for a subtle stagger across sequential sections. */
export function Reveal({
  children, className, delay = 0,
}: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE_OUT, delay } }}
      viewport={{ once: true, margin: '-40px' }}
    >
      {children}
    </motion.div>
  );
}
