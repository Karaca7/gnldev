/** GNL Studio theme tokens (index.css :root/[data-theme='light']) → Tailwind colors hsl(var(--x)).
 *  brand/primary = the single identity accent (sparse, high-impact); accent/success = the secondary accent. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        info: 'hsl(var(--info))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        brand: { DEFAULT: 'hsl(var(--brand))', foreground: 'hsl(var(--brand-foreground))' },
        // Deepest shell/sidebar background (App shell — will connect to D3).
        'surface-deep': 'hsl(var(--surface-deep))',
        'surface-1': 'hsl(var(--surface-1))',
      },
      // Additive only — `xs`/`sm`/`base`/`lg`/`xl`/`2xl` below are Tailwind's untouched defaults
      // (229 call sites rely on those exact values; overriding them would be a silent visual
      // regression jsdom can't catch). These two fill the gap for the two arbitrary sizes actually
      // in heavy use across the codebase (`text-[11px]` × 74, `text-[10px]` × 40) so future call
      // sites can reach for a named step instead of another one-off arbitrary value. Not a
      // migration of the existing 114 call sites — that's a separate, deliberate pass.
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
        '3xs': ['10px', { lineHeight: '14px' }],
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      fontFamily: {
        sans: ['Geist Variable', 'Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono Variable', 'Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
