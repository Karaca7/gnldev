// Radix-based primitives: Dialog/ConfirmDialog, DropdownMenu, Tooltip, Toast (sonner),
// CommandPalette (cmdk). Visual language: theme tokens (index.css) + microlabel.
// The lightweight pieces in components.tsx (Btn/Badge/…) stay as-is; this file is the overlay layer.
import { type ReactNode, useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Command } from 'cmdk';
import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, Btn } from './components';

// Every call site imports `toast` from here (not from 'sonner' directly), which is what lets this
// Wrapper apply a policy centrally instead of touching every `toast.error(...)` call site.
// Error toasts default to `duration: Infinity` — unlike success toasts, they interpolate raw
// Server error messages, which can run long, and sonner's plain 4s default risks the message
// Being missed with no way to get it back. Callers can still override by passing their own
// `duration`. Paired with `closeButton` on <Toaster> below, so an infinite-duration toast is
// Never one the user is stuck looking at.
const sonnerError = sonnerToast.error;
export const toast = Object.assign(sonnerToast, {
  error: (message: Parameters<typeof sonnerToast.error>[0], data?: Parameters<typeof sonnerToast.error>[1]) =>
    sonnerError(message, { duration: Infinity, ...data }),
});

/** App-wide toast bridge — colored using theme tokens (mounted once in main.tsx). */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      closeButton
      toastOptions={{
        // Ink surface + a thin lime identity line (left edge) on all toasts; overridden with
        // Success=Neon Green, error=destructive red (color + text double-coding is already preserved:
        // Sonner shows an icon+title together, color alone doesn't carry the meaning).
        style: {
          background: 'hsl(var(--popover))',
          color: 'hsl(var(--popover-foreground))',
          border: '1px solid hsl(var(--border))',
          borderLeft: '3px solid hsl(var(--brand))',
          fontSize: '13px',
          fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
        },
        classNames: {
          success: '!border-l-success',
          error: '!border-l-destructive',
        },
      }}
    />
  );
}

// ── Dialog ────────────────────────────────────────────────────────────────

export function Dialog({
  open, onOpenChange, title, children, footer, width = 'w-[28rem]', dismissible = true,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode;
  children?: ReactNode; footer?: ReactNode; width?: string;
  // When false, clicking the overlay or pressing Escape no longer closes the dialog — only an
  // Explicit Cancel/X/Save inside it can. Defaults to true so every existing call site (Organizations,
  // Agents, Inspector purge, ConfirmDialog, …) keeps Radix's default dismiss-on-outside-click behavior.
  dismissible?: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-auto',
            'rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none',
            width,
          )}
          onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
          onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <DialogPrimitive.Title className="text-sm font-bold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-sm p-0.5 text-muted-foreground hover:text-brand" aria-label={t('close')}>
              <X size={14} />
            </DialogPrimitive.Close>
          </div>
          {children}
          {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Replaces window.confirm: title + description + confirm/cancel. Use `destructive` when confirming is destructive. */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, destructive, onConfirm,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode;
  confirmLabel?: string; destructive?: boolean; onConfirm: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Btn variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Btn>
          <Btn variant={destructive ? 'deny' : 'default'} onClick={() => { onConfirm(); onOpenChange(false); }}>
            {confirmLabel ?? t('confirm')}
          </Btn>
        </>
      }
    >
      {description && <div className="text-sm text-muted-foreground">{description}</div>}
    </Dialog>
  );
}

// ── DropdownMenu ──────────────────────────────────────────────────────────

export function Dropdown({
  trigger, items, align = 'end',
}: {
  trigger: ReactNode;
  items: { label: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean }[];
  align?: 'start' | 'end';
}) {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          align={align}
          sideOffset={4}
          className="z-50 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {items.map((it, i) => (
            <DropdownPrimitive.Item
              key={i}
              disabled={it.disabled}
              onSelect={it.onSelect}
              className={cn(
                'cursor-default select-none rounded-sm border-l-2 border-l-transparent px-2 py-1.5 text-sm outline-none transition-colors',
                'data-[highlighted]:bg-muted data-[disabled]:opacity-50',
                // Selected/highlighted row edge line: lime for a neutral action ("active/selected state" rule),
                // Red for a destructive action — color always matches its own meaning.
                it.destructive
                  ? 'text-destructive data-[highlighted]:border-l-destructive data-[highlighted]:bg-destructive/10'
                  : 'data-[highlighted]:border-l-brand',
              )}
            >
              {it.label}
            </DropdownPrimitive.Item>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={300}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={5}
          className="z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ── Command palette (Ctrl/Cmd+K) ─────────────────────────────────────────

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  onSelect: () => void;
}

/** App command palette: opens with Ctrl/Cmd+K; navigation + actions in a single search box. */
export function CommandPalette({ items }: { items: CommandItem[] }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-24 z-50 w-[34rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 outline-none">
          <DialogPrimitive.Title className="sr-only">{t('commandPaletteLabel')}</DialogPrimitive.Title>
          <Command
            label={t('commandPaletteLabel')}
            className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
          >
            <Command.Input
              autoFocus
              placeholder={t('commandPalettePlaceholder')}
              // Index.css turns the border --ring on focus, which is exactly right here. `field-bare`
              // Drops only the 3px halo: this field has a BOTTOM border, so a box-shadow would ring the
              // Whole palette width instead of underlining it.
              className="field-bare w-full border-b border-border bg-transparent px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-72 overflow-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('noResults')}
              </Command.Empty>
              {/* D5-10: group by `hint` — each nav item's hint is already its nav-group name
                  ("Runs"/"Build"/"Operate"/"Governance", see App.tsx), and theme/logout carry their
                  own single-item groups ("theme"/"session") — so no item is ever without a group.
                  Grouping is built in first-seen order (a Map preserves insertion order), not sorted
                  alphabetically, so it mirrors the sidebar's nav order rather than scrambling it.
                  cmdk's Command.Group hides itself (and its heading) once filtering empties it out —
                  verified in node_modules/cmdk/dist/index.mjs — so search still narrows correctly. */}
              {Array.from(
                items.reduce((groups, it) => {
                  const key = it.hint ?? '';
                  (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
                  return groups;
                }, new Map<string, CommandItem[]>()),
              ).map(([key, groupItems]) => (
                <Command.Group
                  key={key || '_ungrouped'}
                  value={key}
                  heading={key ? <div className="microlabel px-2.5 pb-1 pt-2 text-muted-foreground">{key}</div> : undefined}
                >
                  {groupItems.map((it) => (
                    <Command.Item
                      key={it.id}
                      value={`${it.label} ${it.hint ?? ''}`}
                      onSelect={() => { setOpen(false); it.onSelect(); }}
                      className="flex cursor-default select-none items-center rounded-sm border-l-2 border-l-transparent px-2.5 py-1.5 text-sm transition-colors data-[selected=true]:border-l-brand data-[selected=true]:bg-muted"
                    >
                      {/* The hint used to also render inline here — now redundant once the group
                          heading above already names the group, so it's dropped to keep the row
                          single-purpose (it still lives on in the search `value` above). */}
                      <span>{it.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
