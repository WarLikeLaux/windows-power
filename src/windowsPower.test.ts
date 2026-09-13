import { describe, expect, it, vi } from 'vitest';
import { WindowsPower, type CommandRunner } from './windowsPower.js';

function result(value: unknown) {
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
}

describe('WindowsPower', () => {
    it('reports no schedule', async () => {
        const runner: CommandRunner = vi.fn(async () => result({ scheduled: false, taskName: 'WindowsPowerMcpShutdown' }));
        await expect(new WindowsPower(runner).status()).resolves.toEqual({
            scheduled: false,
            taskName: 'WindowsPowerMcpShutdown'
        });
    });

    it('schedules and returns refreshed status', async () => {
        const runner = vi.fn<CommandRunner>()
            .mockResolvedValueOnce(result({ scheduled: false, taskName: 'WindowsPowerMcpShutdown' }))
            .mockResolvedValueOnce(result({ ok: true }))
            .mockResolvedValueOnce(result({
                scheduled: true,
                taskName: 'WindowsPowerMcpShutdown',
                nextRunUtc: '2026-09-14T00:00:00.000Z',
                remainingSeconds: 3600
            }));
        const power = new WindowsPower(runner);

        await expect(power.schedule({
            epochSeconds: 1_789_344_000,
            forceCloseApps: true,
            wakeComputer: true
        })).resolves.toMatchObject({ scheduled: true, replaced: false });

        expect(runner).toHaveBeenCalledTimes(3);
        expect(runner.mock.calls[1]![0]).toContain('shutdown.exe');
        expect(runner.mock.calls[1]![0]).toContain('/s /f /t 0');
        expect(runner.mock.calls[1]![0]).toContain('WakeToRun');
    });

    it('cancels an existing task', async () => {
        const runner: CommandRunner = vi.fn(async () => result({ canceled: true, taskName: 'WindowsPowerMcpShutdown' }));
        await expect(new WindowsPower(runner).cancel()).resolves.toMatchObject({ canceled: true });
    });

    it('preserves shutdown options while postponing', async () => {
        const runner = vi.fn<CommandRunner>()
            .mockResolvedValueOnce(result({
                scheduled: true,
                taskName: 'WindowsPowerMcpShutdown',
                nextRunUtc: new Date(Date.now() + 3_600_000).toISOString(),
                forceCloseApps: false,
                wakeComputer: false
            }))
            .mockResolvedValueOnce(result({
                scheduled: true,
                taskName: 'WindowsPowerMcpShutdown',
                nextRunUtc: new Date(Date.now() + 3_600_000).toISOString()
            }))
            .mockResolvedValueOnce(result({ ok: true }))
            .mockResolvedValueOnce(result({
                scheduled: true,
                taskName: 'WindowsPowerMcpShutdown',
                nextRunUtc: new Date(Date.now() + 5_400_000).toISOString(),
                forceCloseApps: false,
                wakeComputer: false
            }));

        await new WindowsPower(runner).postpone(30);

        expect(runner.mock.calls[2]![0]).toContain('/s /t 0');
        expect(runner.mock.calls[2]![0]).not.toContain('/s /f /t 0');
        expect(runner.mock.calls[2]![0]).toContain('if ($false)');
    });

    it('requires exact confirmation for immediate shutdown', async () => {
        const runner: CommandRunner = vi.fn();
        await expect(new WindowsPower(runner).shutdownNow('yes')).rejects.toThrow('SHUTDOWN NOW');
        expect(runner).not.toHaveBeenCalled();
    });

    it('surfaces PowerShell failures without parsing output', async () => {
        const runner: CommandRunner = vi.fn(async () => ({ stdout: '', stderr: 'Access denied', exitCode: 1 }));
        await expect(new WindowsPower(runner).status()).rejects.toThrow('Access denied');
    });
});
