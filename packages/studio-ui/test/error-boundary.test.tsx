// @vitest-environment jsdom
// F6.6: ErrorBoundary catches a render error → the whole SPA doesn't go blank-white, shows an error card instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ErrorBoundary } from '../src/App';

// A component that throws during render (the error type React's boundary catches).
function Boom() {
  throw new Error('boom');
  return null; // unreachable
}

afterEach(cleanup);

describe('ErrorBoundary (F6.6)', () => {
  it('catches a render error → error card + message + "reload" (no blank white screen)', () => {
    // React dumps the caught error to console.error → suppress the noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy(); // error message inside the <pre>
    expect(screen.getByText('Reload')).toBeTruthy();
    spy.mockRestore();
  });

  it('renders children as-is when there is no error', () => {
    render(<ErrorBoundary><div>content</div></ErrorBoundary>);
    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
