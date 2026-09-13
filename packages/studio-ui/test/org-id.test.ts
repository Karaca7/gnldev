// Organization id validation: pure logic, NODE environment — no DOM needed (only a function is imported).
import { describe, it, expect } from 'vitest';
import { validateOrgId, orgDisplayName, fmtUsd, fmtTok } from '../src/views/Organizations';

describe('validateOrgId', () => {
  it('a valid id (lowercase/digit/_/-) → null (no error)', () => {
    expect(validateOrgId('acme')).toBeNull();
    expect(validateOrgId('acme-corp')).toBeNull();
    expect(validateOrgId('acme_corp_2')).toBeNull();
    expect(validateOrgId('a1b2c3')).toBeNull();
  });

  it('leading/trailing whitespace is trimmed; null if valid after that', () => {
    expect(validateOrgId('  acme  ')).toBeNull();
  });

  it('empty id → error', () => {
    expect(validateOrgId('')).toBeTruthy();
    expect(validateOrgId('   ')).toBeTruthy();
  });

  it("an id containing ':' → error (collides with the journal prefix)", () => {
    expect(validateOrgId('t:acme')).toBeTruthy();
    expect(validateOrgId('acme:1')).toBeTruthy();
  });

  it('an id containing uppercase or a space/special character → error', () => {
    expect(validateOrgId('Acme')).toBeTruthy();
    expect(validateOrgId('acme corp')).toBeTruthy();
    expect(validateOrgId('acme/corp')).toBeTruthy();
    expect(validateOrgId('acme.corp')).toBeTruthy();
  });
});

// Table identity cell: fix for a bug where the label was collected but never shown in the UI (see server.ts GET /organizations).
describe('orgDisplayName', () => {
  it('when a label is present: primary=label, secondary=`org:<id>:` storage id', () => {
    expect(orgDisplayName({ id: 'acme', label: 'Acme Inc.' })).toEqual({ primary: 'Acme Inc.', secondary: 'org:acme:' });
  });

  it('when there is no label: only id as primary, no secondary (backward-compatible old behavior)', () => {
    expect(orgDisplayName({ id: 'acme' })).toEqual({ primary: 'acme' });
  });

  it("an empty string label ('') is also treated as absent → id as primary (falsy fallback)", () => {
    expect(orgDisplayName({ id: 'acme', label: '' })).toEqual({ primary: 'acme' });
  });
});

describe('budget formatting (BudgetMeter pure helpers)', () => {
  it('fmtUsd: 2 decimals + $ prefix', () => {
    expect(fmtUsd(10)).toBe('$10.00');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(3.5)).toBe('$3.50');
  });
  it('fmtTok: thousands separator follows the ACTIVE language, English by default', () => {
    // The product default is English: no language selected (i18next uninitialized in this node test)
    // must format as en-US. It used to be hardcoded 'tr-TR' and printed `1.000` in an English UI.
    expect(fmtTok(100)).toBe('100');
    expect(fmtTok(1000)).toBe('1,000');
    expect(fmtTok(1234567)).toBe('1,234,567');
  });
});
