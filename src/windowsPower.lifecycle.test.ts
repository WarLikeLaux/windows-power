import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WindowsPower, runPowerShell } from './windowsPower.js';
import type { NightPlan } from './nightTypes.js';

const hasPowerShell = process.platform === 'win32'
    || existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');

// Execute the generated scripts with real ScheduledTasks value constructors.
// Task storage and shutdown are replaced at the Windows boundary. The fake
// shutdown exits immediately, just as Windows can kill WSL during shutdown.
describe.skipIf(!hasPowerShell)('Windows task lifecycle in PowerShell', () => {
    let directory: string;
    let statePath: string;
    let windowsStatePath: string;
    let power: WindowsPower;
    let plan: NightPlan;
    let failRemoval: string;
    let shutdowns: string[][];

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'windows-power-lifecycle-'));
        statePath = join(directory, 'tasks.json');
        windowsStatePath = process.platform === 'win32' ? statePath
            : execFileSync('wslpath', ['-w', statePath], { encoding: 'utf8' }).trim();
        await writeFile(statePath, '{}');
        failRemoval = '';
        shutdowns = [];
        const now = Date.now();
        plan = {
            id: randomUUID(), revision: randomUUID(), afterUtc: new Date(now - 60_000).toISOString(),
            deadlineUtc: new Date(now + 3_600_000).toISOString(), checkEveryMinutes: 15,
            machineId: 'test-pc', configPath: '/test/night.json', launchArguments: 'test-worker', wakeComputer: false
        };
        power = new WindowsPower(async script => {
            const initial = JSON.parse(await readFile(statePath, 'utf8'));
            const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
            const fixture = `
Import-Module ScheduledTasks
$fixtureState = ${quote(JSON.stringify(initial))} | ConvertFrom-Json
$fixtureTasks = @{}
foreach ($property in $fixtureState.PSObject.Properties) { $fixtureTasks[$property.Name] = $property.Value }
function Save-FixtureTasks {
    $fixtureTasks | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath ${quote(windowsStatePath)} -Encoding UTF8
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) $fixtureTasks[$TaskName] }
function Get-ScheduledTaskInfo {
    param($TaskName)
    [pscustomobject]@{ NextRunTime = [DateTime]::Parse($fixtureTasks[$TaskName].StartBoundary); LastRunTime = [DateTime]::MinValue; LastTaskResult = 0 }
}
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Settings, $Description, [switch]$Force)
    $fixtureTasks[$TaskName] = [pscustomobject]@{
        State = 'Ready'; Description = $Description; Actions = @{ Arguments = $Action.Arguments }
        Settings = @{ StartWhenAvailable = [bool]$Settings.StartWhenAvailable; WakeToRun = [bool]$Settings.WakeToRun }
        StartBoundary = $Trigger.StartBoundary; EndBoundary = $Trigger.EndBoundary
    }
    Save-FixtureTasks
}
function Unregister-ScheduledTask {
    param($TaskName, $Confirm, $ErrorAction)
    if ($TaskName -eq ${quote(failRemoval)}) { throw 'Fixture task deletion failed' }
    $fixtureTasks.Remove($TaskName)
    Save-FixtureTasks
}
# Point every executable at a nonexistent root, so an interception failure
# cannot reach the real shutdown.exe.
$fixtureRoot = 'C:\\WindowsPowerMcpTest'
function global:C:\\WindowsPowerMcpTest\\System32\\shutdown.exe {
    [pscustomobject]@{ accepted = $true; tasksAtShutdown = @($fixtureTasks.Keys) } | ConvertTo-Json -Compress
    exit 0
}
`;
            const response = await runPowerShell(fixture + script.replaceAll('$env:SystemRoot', '$fixtureRoot'));
            await writeFile(statePath, (await readFile(statePath, 'utf8')).replace(/^\uFEFF/, ''));
            if (response.exitCode === 0) {
                const receipt = JSON.parse(response.stdout.split(/\r?\n/).at(-1)!);
                if (receipt.tasksAtShutdown) shutdowns.push(receipt.tasksAtShutdown);
            }
            return response;
        });
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    async function seedNight() {
        await writeFile(statePath, JSON.stringify({
            WindowsPowerMcpShutdown: { State: 'Ready' },
            WindowsPowerMcpHapiCheck: { State: 'Ready', Description: JSON.stringify(plan) }
        }));
    }

    it('removes both night tasks before Windows can terminate the shutdown process', async () => {
        await seedNight();
        await expect(power.shutdownNightIfCurrent(plan)).resolves.toMatchObject({ accepted: true });
        expect(shutdowns).toEqual([[]]);
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({});
    });

    it('does not shut down when task cleanup fails', async () => {
        await seedNight();
        failRemoval = 'WindowsPowerMcpShutdown';
        await expect(power.shutdownNightIfCurrent(plan)).rejects.toThrow('Fixture task deletion failed');
        expect(shutdowns).toEqual([]);
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toHaveProperty('WindowsPowerMcpShutdown');
    });

    it.each(['regular', 'night'])('never registers a %s shutdown to catch up after a missed trigger', async mode => {
        if (mode === 'regular') {
            await power.schedule({ epochSeconds: Math.floor(Date.now() / 1000) + 3600, forceCloseApps: true, wakeComputer: false });
        } else {
            await power.scheduleNight({ ...plan, afterUtc: new Date(Date.now() + 60_000).toISOString() });
        }
        const tasks = JSON.parse(await readFile(statePath, 'utf8'));
        expect(tasks.WindowsPowerMcpShutdown.Settings.StartWhenAvailable).toBe(false);
        expect(shutdowns).toEqual([]);
    });
});
