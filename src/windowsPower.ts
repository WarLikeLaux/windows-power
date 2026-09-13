import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

const TASK_NAME = 'WindowsPowerMcpShutdown';
const DEFAULT_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const DEFAULT_WINDOWS_CWD = '/mnt/c';

export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type CommandRunner = (script: string) => Promise<CommandResult>;

export interface ShutdownStatus {
    scheduled: boolean;
    taskName: string;
    state?: string;
    nextRunLocal?: string;
    nextRunUtc?: string;
    remainingSeconds?: number;
    forceCloseApps?: boolean;
    wakeComputer?: boolean;
    lastRunLocal?: string;
    lastTaskResult?: number;
}

export interface ScheduleOptions {
    epochSeconds: number;
    forceCloseApps: boolean;
    wakeComputer: boolean;
}

function encodePowerShell(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

async function executablePath(): Promise<string> {
    const override = process.env.WINDOWS_POWER_POWERSHELL?.trim();
    if (override) return override;

    try {
        await access(DEFAULT_POWERSHELL, constants.X_OK);
        return DEFAULT_POWERSHELL;
    } catch {
        return 'powershell.exe';
    }
}

async function windowsCwd(): Promise<string | undefined> {
    try {
        await access(DEFAULT_WINDOWS_CWD, constants.R_OK);
        return DEFAULT_WINDOWS_CWD;
    } catch {
        return undefined;
    }
}

export const runPowerShell: CommandRunner = async (script) => {
    const prelude = [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        '$OutputEncoding = [Console]::OutputEncoding'
    ].join('\n');

    const child = spawn(await executablePath(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(`${prelude}\n${script}`)
    ], {
        cwd: await windowsCwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code ?? 1));
    });

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
};

function psBoolean(value: boolean): string {
    return value ? '$true' : '$false';
}

function parseJsonResult<T>(result: CommandResult): T {
    if (result.exitCode !== 0) {
        const detail = result.stderr || result.stdout || `PowerShell exited with code ${result.exitCode}`;
        throw new Error(`Windows command failed: ${detail}`);
    }

    const line = result.stdout.split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new Error('Windows command returned no result.');

    try {
        return JSON.parse(line) as T;
    } catch {
        throw new Error(`Windows command returned invalid JSON: ${line}`);
    }
}

export class WindowsPower {
    public constructor(private readonly runner: CommandRunner = runPowerShell) {}

    public async status(): Promise<ShutdownStatus> {
        const script = `
$taskName = '${TASK_NAME}'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [pscustomobject]@{ scheduled = $false; taskName = $taskName } | ConvertTo-Json -Compress
    exit 0
}
$info = Get-ScheduledTaskInfo -TaskName $taskName
$nextLocal = [DateTime]::SpecifyKind($info.NextRunTime, [DateTimeKind]::Local)
$nextOffset = [DateTimeOffset]$nextLocal
$remaining = [Math]::Max(0, [Math]::Floor(($nextOffset - [DateTimeOffset]::Now).TotalSeconds))
$scheduled = $nextOffset -gt [DateTimeOffset]::Now -and [string]$task.State -ne 'Disabled'
[pscustomobject]@{
    scheduled = $scheduled
    taskName = $taskName
    state = [string]$task.State
    nextRunLocal = $nextOffset.ToString('o')
    nextRunUtc = $nextOffset.ToUniversalTime().ToString('o')
    remainingSeconds = [int64]$remaining
    forceCloseApps = [bool]($task.Actions.Arguments -match '(^| )/f( |$)')
    wakeComputer = [bool]$task.Settings.WakeToRun
    lastRunLocal = $info.LastRunTime.ToString('o')
    lastTaskResult = $info.LastTaskResult
} | ConvertTo-Json -Compress
`;
        return parseJsonResult<ShutdownStatus>(await this.runner(script));
    }

    public async schedule(options: ScheduleOptions): Promise<ShutdownStatus & { replaced: boolean }> {
        if (!Number.isSafeInteger(options.epochSeconds)) throw new Error('Shutdown timestamp must be an integer.');
        const previous = await this.status();
        const forceArgument = options.forceCloseApps ? '/s /f /t 0' : '/s /t 0';
        const script = `
$taskName = '${TASK_NAME}'
$runAt = [DateTimeOffset]::FromUnixTimeSeconds(${options.epochSeconds}).LocalDateTime
if ($runAt -le [DateTime]::Now) { throw 'Shutdown time must be in the future.' }
$action = New-ScheduledTaskAction -Execute \"$env:SystemRoot\\System32\\shutdown.exe\" -Argument '${forceArgument} /d p:0:0 /c \"Scheduled by Windows Power MCP\"'
$trigger = New-ScheduledTaskTrigger -Once -At $runAt
$settingsArgs = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    StartWhenAvailable = $true
}
if (${psBoolean(options.wakeComputer)}) { $settingsArgs.WakeToRun = $true }
$settings = New-ScheduledTaskSettingsSet @settingsArgs
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'One-time shutdown managed by Windows Power MCP.' -Force | Out-Null
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
        parseJsonResult<{ ok: boolean }>(await this.runner(script));
        return { ...(await this.status()), replaced: previous.scheduled };
    }

    public async postpone(minutes: number): Promise<ShutdownStatus> {
        const current = await this.status();
        if (!current.scheduled || !current.nextRunUtc) throw new Error('No active Windows shutdown is scheduled.');

        const nextEpoch = Math.floor(new Date(current.nextRunUtc).getTime() / 1000) + minutes * 60;
        if (nextEpoch <= Math.floor(Date.now() / 1000)) {
            throw new Error('The adjusted shutdown time must remain in the future.');
        }

        const result = await this.schedule({
            epochSeconds: nextEpoch,
            forceCloseApps: current.forceCloseApps ?? true,
            wakeComputer: current.wakeComputer ?? true
        });
        const { replaced: _replaced, ...status } = result;
        return status;
    }

    public async cancel(): Promise<{ canceled: boolean; taskName: string }> {
        const script = `
$taskName = '${TASK_NAME}'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [pscustomobject]@{ canceled = $false; taskName = $taskName } | ConvertTo-Json -Compress
    exit 0
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
[pscustomobject]@{ canceled = $true; taskName = $taskName } | ConvertTo-Json -Compress
`;
        return parseJsonResult<{ canceled: boolean; taskName: string }>(await this.runner(script));
    }

    public async shutdownNow(confirmation: string): Promise<{ accepted: true; delaySeconds: 5 }> {
        if (confirmation !== 'SHUTDOWN NOW') {
            throw new Error('Immediate shutdown requires confirmation exactly equal to "SHUTDOWN NOW".');
        }

        const script = `
$taskName = '${TASK_NAME}'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
& \"$env:SystemRoot\\System32\\shutdown.exe\" /s /f /t 5 /d p:0:0 /c \"Requested through Windows Power MCP\"
if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe exited with code $LASTEXITCODE\" }
[pscustomobject]@{ accepted = $true; delaySeconds = 5 } | ConvertTo-Json -Compress
`;
        return parseJsonResult<{ accepted: true; delaySeconds: 5 }>(await this.runner(script));
    }
}

export { TASK_NAME };
