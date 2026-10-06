import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { muteAudioScript } from './audio.js';
import { NightPlanSchema, type NightPlan } from './nightTypes.js';

const TASK_NAME = 'WindowsPowerMcpShutdown';
const NIGHT_TASK_NAME = 'WindowsPowerMcpHapiCheck';
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
    night?: NightPlan | null;
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
        encodePowerShell(`${prelude}\n$mutex = [Threading.Mutex]::new($false, 'Local\\WindowsPowerMcp')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Windows Power operation is still running.' }
    ${script}
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}`)
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

function psString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
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
$nightTask = Get-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -ErrorAction SilentlyContinue
$night = if ($null -ne $nightTask -and [string]$nightTask.State -ne 'Disabled') { $nightTask.Description | ConvertFrom-Json } else { $null }
$hasNext = $null -ne $info.NextRunTime -and $info.NextRunTime -ne [DateTime]::MinValue -and [string]$info.NextRunTime -ne ''
$nextRunLocal = $null
$nextRunUtc = $null
$remaining = $null
$scheduled = $false
if ($hasNext) {
    $nextLocal = [DateTime]::SpecifyKind($info.NextRunTime, [DateTimeKind]::Local)
    $nextOffset = [DateTimeOffset]$nextLocal
    $remaining = [int64][Math]::Max(0, [Math]::Floor(($nextOffset - [DateTimeOffset]::Now).TotalSeconds))
    $scheduled = $nextOffset -gt [DateTimeOffset]::Now -and [string]$task.State -ne 'Disabled'
    $nextRunLocal = $nextOffset.ToString('o')
    $nextRunUtc = $nextOffset.ToUniversalTime().ToString('o')
}
$hasLast = $null -ne $info.LastRunTime -and $info.LastRunTime -ne [DateTime]::MinValue -and [string]$info.LastRunTime -ne ''
$lastRunLocal = if ($hasLast) {
    ([DateTimeOffset][DateTime]::SpecifyKind($info.LastRunTime, [DateTimeKind]::Local)).ToString('o')
} else { $null }
[pscustomobject]@{
    scheduled = $scheduled
    taskName = $taskName
    state = [string]$task.State
    nextRunLocal = $nextRunLocal
    nextRunUtc = $nextRunUtc
    remainingSeconds = $remaining
    forceCloseApps = [bool]($task.Actions.Arguments -match '(^| )/f( |$)')
    wakeComputer = [bool]$task.Settings.WakeToRun
    lastRunLocal = $lastRunLocal
    lastTaskResult = $info.LastTaskResult
    night = $night
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
    StartWhenAvailable = $false
}
if (${psBoolean(options.wakeComputer)}) { $settingsArgs.WakeToRun = $true }
$settings = New-ScheduledTaskSettingsSet @settingsArgs
Unregister-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'One-time shutdown managed by Windows Power MCP.' -Force | Out-Null
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
        parseJsonResult<{ ok: boolean }>(await this.runner(script));
        return { ...(await this.status()), replaced: previous.scheduled };
    }

    public async postpone(minutes: number): Promise<ShutdownStatus> {
        const current = await this.status();
        if (!current.scheduled || !current.nextRunUtc) throw new Error('No active Windows shutdown is scheduled.');

        if (current.night) {
            const plan = NightPlanSchema.parse(current.night);
            const deadline = Date.parse(plan.deadlineUtc) + minutes * 60_000;
            const after = Math.max(Date.now() + 60_000, Date.parse(plan.afterUtc) + minutes * 60_000);
            return this.scheduleNight({
                ...plan,
                revision: randomUUID(),
                afterUtc: new Date(after).toISOString(),
                deadlineUtc: new Date(deadline).toISOString()
            });
        }

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
$nightTask = Get-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -ErrorAction SilentlyContinue
if ($null -eq $task -and $null -eq $nightTask) {
    [pscustomobject]@{ canceled = $false; taskName = $taskName } | ConvertTo-Json -Compress
    exit 0
}
Unregister-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
if ($null -ne $task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
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
Unregister-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
& \"$env:SystemRoot\\System32\\shutdown.exe\" /s /f /t 5 /d p:0:0 /c \"Requested through Windows Power MCP\"
if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe exited with code $LASTEXITCODE\" }
[pscustomobject]@{ accepted = $true; delaySeconds = 5 } | ConvertTo-Json -Compress
`;
        return parseJsonResult<{ accepted: true; delaySeconds: 5 }>(await this.runner(script));
    }

    public async muteAudio(): Promise<{ volumePercent: 0 }> {
        return parseJsonResult<{ volumePercent: 0 }>(await this.runner(muteAudioScript));
    }

    public async scheduleNight(input: NightPlan): Promise<ShutdownStatus> {
        const plan = NightPlanSchema.parse(input);
        const after = Date.parse(plan.afterUtc);
        const deadline = Date.parse(plan.deadlineUtc);
        if (after < Date.now() + 30_000 || deadline <= after) {
            throw new Error('Night window must start at least 30 seconds from now and end after its start.');
        }
        const script = `
$after = [DateTimeOffset]::Parse(${psString(plan.afterUtc)}).LocalDateTime
$deadline = [DateTimeOffset]::Parse(${psString(plan.deadlineUtc)}).LocalDateTime
if ($after -le [DateTime]::Now -or $deadline -le $after) { throw 'Night window is no longer in the future.' }
$deadlineAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\shutdown.exe" -Argument '/s /f /t 0 /d p:0:0 /c "Windows Power MCP night deadline"'
$deadlineTrigger = New-ScheduledTaskTrigger -Once -At $deadline
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable:$false -WakeToRun:${psBoolean(plan.wakeComputer)}
$checkAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\wsl.exe" -Argument ${psString(plan.launchArguments)}
$interval = [TimeSpan]::FromMinutes(${plan.checkEveryMinutes})
$repeatDuration = $deadline - $after
if ($repeatDuration -lt $interval) { $repeatDuration = $interval }
$checkTrigger = New-ScheduledTaskTrigger -Once -At $after -RepetitionInterval $interval -RepetitionDuration $repeatDuration
$checkTrigger.EndBoundary = $deadline.ToString('s')
$checkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun:${psBoolean(plan.wakeComputer)} -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2))
Unregister-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $deadlineAction -Trigger $deadlineTrigger -Settings $settings -Description 'Forced night deadline managed by Windows Power MCP.' -Force | Out-Null
try {
    Register-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -Action $checkAction -Trigger $checkTrigger -Settings $checkSettings -Description ${psString(JSON.stringify(plan))} -Force | Out-Null
} catch {
    Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
    throw
}
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
        parseJsonResult<{ ok: boolean }>(await this.runner(script));
        const status = await this.status();
        if (!status.scheduled || status.night?.revision !== plan.revision) {
            throw new Error('Windows did not confirm the night schedule.');
        }
        return status;
    }

    public async shutdownNightIfCurrent(plan: NightPlan): Promise<{ accepted: boolean }> {
        const script = `
$check = Get-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -ErrorAction SilentlyContinue
$deadlineTask = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
$current = if ($null -ne $check) { $check.Description | ConvertFrom-Json } else { $null }
$now = [DateTimeOffset]::Now
if ($null -eq $current -or $null -eq $deadlineTask -or [string]$check.State -eq 'Disabled' -or [string]$deadlineTask.State -eq 'Disabled' -or $current.id -ne ${psString(plan.id)} -or $current.revision -ne ${psString(plan.revision)} -or $now -lt [DateTimeOffset]::Parse($current.afterUtc) -or $now -ge [DateTimeOffset]::Parse($current.deadlineUtc)) {
    [pscustomobject]@{ accepted = $false } | ConvertTo-Json -Compress
    exit 0
}
# Immediate shutdown can terminate WSL before the next instruction. Retire
# both tasks first, and refuse shutdown if cleanup fails.
Unregister-ScheduledTask -TaskName '${NIGHT_TASK_NAME}' -Confirm:$false -ErrorAction Stop
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop
& "$env:SystemRoot\\System32\\shutdown.exe" /s /f /t 0 /d p:0:0 /c "HAPI agents finished their night work"
if ($LASTEXITCODE -ne 0) { throw "shutdown.exe exited with code $LASTEXITCODE" }
[pscustomobject]@{ accepted = $true } | ConvertTo-Json -Compress
`;
        return parseJsonResult<{ accepted: boolean }>(await this.runner(script));
    }
}

export { TASK_NAME, NIGHT_TASK_NAME };
