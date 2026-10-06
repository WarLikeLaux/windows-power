import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { HapiClient } from './hapi.js';
import { NightCheckSchema, NightConfigSchema, NightPlanSchema, type NightCheck, type NightConfig } from './nightTypes.js';
import { WindowsPower, type ShutdownStatus } from './windowsPower.js';

async function readOptionalJson(path: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(`Cannot read configuration at ${path}.`);
    }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
}

function windowsArgument(value: string): string {
    // wsl.exe treats quoted option names as a Linux command, so quote only
    // arguments that actually need quoting.
    if (!/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

async function wslDistribution(): Promise<string> {
    if (process.env.WSL_DISTRO_NAME) return process.env.WSL_DISTRO_NAME;
    // HAPI runner processes may omit WSL_DISTRO_NAME. The UNC root still
    // identifies the registered distribution, even after an Ubuntu upgrade.
    try {
        const { stdout } = await promisify(execFile)('wslpath', ['-w', '/'], { timeout: 5000 });
        const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\/.exec(stdout.trim());
        if (match?.[1]) return match[1];
    } catch { /* The diagnostic below covers non-WSL hosts too. */ }
    throw new Error('Night shutdown must be configured from WSL.');
}

async function hapiConfiguration(): Promise<{ config: NightConfig; machineId: string }> {
    const home = (process.env.HAPI_HOME || join(homedir(), '.hapi')).replace(/^~(?=\/|$)/, homedir());
    const settings = z.object({
        cliApiToken: z.string().optional(), apiUrl: z.string().optional(), machineId: z.string().optional()
    }).parse(await readOptionalJson(join(home, 'settings.json')) ?? {});
    const accessToken = process.env.CLI_API_TOKEN || settings.cliApiToken;
    const machineId = process.env.WINDOWS_POWER_HAPI_MACHINE_ID || settings.machineId;
    if (!accessToken || !machineId) {
        throw new Error('HAPI access token and local machine identity are required. Use hapi auth login and the local HAPI runner.');
    }
    let headers: Record<string, string> = {};
    try {
        headers = z.record(z.string(), z.string()).parse(JSON.parse(process.env.HAPI_EXTRA_HEADERS_JSON || '{}'));
    } catch { throw new Error('HAPI_EXTRA_HEADERS_JSON must contain string header values.'); }
    return {
        config: NightConfigSchema.parse({
            id: randomUUID(),
            apiUrl: process.env.WINDOWS_POWER_HAPI_URL || process.env.HAPI_API_URL || settings.apiUrl || 'http://localhost:3006',
            accessToken, headers
        }),
        machineId
    };
}

export class NightShutdown {
    public constructor(private readonly power: WindowsPower = new WindowsPower()) {}

    public async schedule(options: { after: string; deadline: string; checkEveryMinutes?: number; wakeComputer?: boolean }): Promise<ShutdownStatus & { replaced: boolean; volumePercent: 0 }> {
        const { config, machineId } = await hapiConfiguration();
        const distro = await wslDistribution();
        const worker = fileURLToPath(new URL('./nightWorker.js', import.meta.url));
        await access(worker);
        const configPath = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'windows-power', 'night.json');
        const requestedAfter = parseTimestamp(options.after);
        const after = new Date(Math.max(Date.parse(requestedAfter), Date.now() + 60_000)).toISOString();
        const deadline = parseTimestamp(options.deadline);
        const plan = NightPlanSchema.parse({
            id: config.id, revision: randomUUID(), afterUtc: after, deadlineUtc: deadline,
            checkEveryMinutes: options.checkEveryMinutes ?? 15, machineId, configPath,
            launchArguments: ['--distribution', distro, '--user', userInfo().username, '--exec', process.execPath, worker, configPath].map(windowsArgument).join(' '),
            wakeComputer: options.wakeComputer ?? true
        });
        if (Date.parse(deadline) <= Date.parse(after)) {
            throw new Error('The night deadline must be later than the first check, at least one minute from now.');
        }
        if (Date.parse(deadline) - Date.parse(after) > 24 * 60 * 60_000) throw new Error('Night window cannot exceed 24 hours.');
        await new HapiClient(config).blockers(plan);
        const previous = await this.power.status();
        await this.power.muteAudio();
        await writePrivateJson(configPath, config);
        await chmod(dirname(configPath), 0o700);
        const status = await this.power.scheduleNight(plan);
        return { ...status, replaced: previous.scheduled, volumePercent: 0 };
    }

    public async status(): Promise<ShutdownStatus & { lastCheck?: NightCheck }> {
        const status = await this.power.status();
        if (!status.night) return status;
        const plan = NightPlanSchema.parse(status.night);
        const parsed = NightCheckSchema.safeParse(await readOptionalJson(`${plan.configPath}.status.json`));
        return parsed.success && parsed.data.revision === plan.revision ? { ...status, lastCheck: parsed.data } : status;
    }
}

function parseTimestamp(value: string): string {
    if (!z.string().datetime({ offset: true }).safeParse(value).success || !Number.isFinite(Date.parse(value))) {
        throw new Error('Night times must be RFC 3339 timestamps with timezone offsets.');
    }
    return new Date(value).toISOString();
}

export async function checkNight(configPath: string, power: WindowsPower = new WindowsPower()): Promise<NightCheck | undefined> {
    const config = NightConfigSchema.parse(await readOptionalJson(configPath));
    const status = await power.status();
    if (!status.scheduled || !status.night) return;
    const plan = NightPlanSchema.parse(status.night);
    if (plan.id !== config.id || plan.configPath !== configPath || Date.now() < Date.parse(plan.afterUtc)) return;
    const statusPath = `${configPath}.status.json`;
    const receipt: NightCheck = { revision: plan.revision, checkedAt: Date.now(), idleSince: null, state: 'expired', blockers: [] };
    if (Date.now() >= Date.parse(plan.deadlineUtc)) {
        await writePrivateJson(statusPath, receipt);
        return receipt;
    }
    try {
        const blockers = await new HapiClient(config).blockers(plan);
        receipt.blockers = blockers;
        receipt.checkedAt = Date.now();
        if (blockers.length) receipt.state = 'waiting_for_work';
        else {
            const previous = NightCheckSchema.safeParse(await readOptionalJson(statusPath));
            const samePlan = previous.success && previous.data.revision === plan.revision;
            const recent = samePlan && receipt.checkedAt - previous.data.checkedAt <= plan.checkEveryMinutes * 90_000;
            receipt.idleSince = recent && previous.data.state === 'confirming_idle'
                ? previous.data.idleSince ?? receipt.checkedAt : receipt.checkedAt;
            receipt.state = 'confirming_idle';
            if (receipt.checkedAt - receipt.idleSince >= plan.checkEveryMinutes * 60_000) {
                // Refresh the whole snapshot immediately before asking Windows to shut down.
                receipt.blockers = await new HapiClient(config).blockers(plan);
                if (receipt.blockers.length) {
                    receipt.state = 'waiting_for_work';
                    receipt.idleSince = null;
                } else if ((await power.shutdownNightIfCurrent(plan)).accepted) receipt.state = 'shutdown_requested';
            }
        }
    } catch (error) {
        receipt.state = 'hapi_unavailable';
        receipt.idleSince = null;
        receipt.error = error instanceof Error ? error.message : 'Night check failed.';
    }
    await writePrivateJson(statusPath, receipt);
    return receipt;
}
