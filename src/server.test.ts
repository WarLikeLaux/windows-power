import { describe, expect, it, vi } from 'vitest';
import { resolveEpoch } from './server.js';

describe('resolveEpoch', () => {
    it('converts a relative delay', () => {
        vi.setSystemTime(new Date('2026-09-13T18:00:00Z'));
        expect(resolveEpoch(90, undefined)).toBe(1_789_327_800);
        vi.useRealTimers();
    });

    it('accepts an absolute timestamp with offset', () => {
        expect(resolveEpoch(undefined, '2026-09-14T03:30:00+06:00')).toBe(1_789_335_000);
    });

    it('rejects ambiguous local timestamps', () => {
        expect(() => resolveEpoch(undefined, '2026-09-14T03:30:00')).toThrow('timezone offset');
    });

    it('requires exactly one time form', () => {
        expect(() => resolveEpoch(undefined, undefined)).toThrow('exactly one');
        expect(() => resolveEpoch(30, '2026-09-14T03:30:00+06:00')).toThrow('exactly one');
    });
});
