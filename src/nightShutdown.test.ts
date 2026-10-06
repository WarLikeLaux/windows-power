import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NightShutdown, checkNight } from '../dist/nightShutdown.js';
import { WindowsPower } from '../dist/windowsPower.js';
import { createServer as createMcpServer } from '../dist/server.js';
import type { NightPlan } from '../dist/nightTypes.js';

const localIdle = {
    id: 'local-session', active: true, thinking: false, backgroundTaskCount: 0,
    pendingRequestsCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null,
    metadata: { machineId: 'this-pc', name: 'Local task', lifecycleState: 'running' }
};

describe('night shutdown via HAPI HTTP and persisted check state', () => {
    let server: Server;
    let directory: string;
    let configPath: string;
    let apiUrl: string;
    let plan: NightPlan;
    let sessions: unknown[];
    let detail: Record<string, unknown>;
    let httpStatus: number;
    let listRequests: number;
    let onList: (() => void) | undefined;
    let power: WindowsPower;
    let now: number;

    beforeEach(async () => {
        now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        directory = await mkdtemp(join(tmpdir(), 'windows-power-night-'));
        configPath = join(directory, 'night.json');
        sessions = [{ ...localIdle }];
        detail = { thinking: false, backgroundTaskCount: 0, activeTurnStartedAt: null, agentState: { requests: {} } };
        httpStatus = 200;
        listRequests = 0;
        onList = undefined;
        server = createServer((request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.statusCode = httpStatus;
            if (httpStatus !== 200) { response.end(JSON.stringify({ error: 'not available' })); return; }
            if (request.url === '/api/auth') { response.end(JSON.stringify({ token: 'jwt' })); return; }
            if (request.headers.authorization !== 'Bearer jwt') { response.statusCode = 401; response.end('{}'); return; }
            if (request.url === '/api/sessions') {
                listRequests++;
                onList?.();
                response.end(JSON.stringify({ sessions }));
            } else response.end(JSON.stringify({ session: detail }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTP fixture did not start');
        apiUrl = `http://127.0.0.1:${address.port}`;
        plan = {
            id: randomUUID(), revision: randomUUID(), afterUtc: new Date(now - 60_000).toISOString(),
            deadlineUtc: new Date(now + 3 * 60 * 60_000).toISOString(), checkEveryMinutes: 15,
            machineId: 'this-pc', configPath, launchArguments: 'worker', wakeComputer: true
        };
        await writeFile(configPath, JSON.stringify({ id: plan.id, apiUrl, accessToken: 'secret', headers: {} }), { mode: 0o600 });
        power = new WindowsPower();
        vi.spyOn(power, 'status').mockImplementation(async () => ({ scheduled: true, taskName: 'deadline', night: plan }));
        vi.spyOn(power, 'shutdownNightIfCurrent').mockResolvedValue({ accepted: true });
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
    });

    it('confirms 15 minutes of idle across invocations and refreshes HAPI before shutdown', async () => {
        expect((await checkNight(configPath, power))?.state).toBe('confirming_idle');
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
        now += 15 * 60_000;
        expect((await checkNight(configPath, power))?.state).toBe('shutdown_requested');
        expect(power.shutdownNightIfCurrent).toHaveBeenCalledOnce();
        expect(listRequests).toBe(3);
        const receipt = JSON.parse(await readFile(`${configPath}.status.json`, 'utf8'));
        expect(receipt.state).toBe('shutdown_requested');
        expect((await stat(`${configPath}.status.json`)).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(receipt)).not.toContain('secret');
    });

    it.each([
        ['agent work', { thinking: true }],
        ['background work', { backgroundTaskCount: 1 }],
        ['user input', { pendingRequestsCount: 1 }],
        ['scheduled night message', { futureScheduledMessageCount: 1, nextScheduledAt: Date.now() + 60_000 }],
        ['unknown active machine', { metadata: { lifecycleState: 'running' } }]
    ])('waits for %s, even after an earlier idle observation', async (_name, fields) => {
        await checkNight(configPath, power);
        now += 15 * 60_000;
        sessions = [{ ...localIdle, ...fields }];
        const receipt = await checkNight(configPath, power);
        expect(receipt?.state).toBe('waiting_for_work');
        expect(receipt?.blockers).toHaveLength(1);
        expect(receipt?.idleSince).toBeNull();
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
    });

    it('counts unfinished turns from full session details', async () => {
        detail.activeTurnStartedAt = now - 1000;
        expect((await checkNight(configPath, power))?.state).toBe('waiting_for_work');
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
    });

    it('ignores other computers and messages scheduled beyond the deadline', async () => {
        sessions = [
            { ...localIdle, id: 'remote', thinking: true, metadata: { machineId: 'remote-pc' } },
            { ...localIdle, futureScheduledMessageCount: 1, nextScheduledAt: now + 4 * 60 * 60_000 }
        ];
        expect((await checkNight(configPath, power))?.state).toBe('confirming_idle');
    });

    it.each([503, 'incomplete'])('resets idle confirmation when HAPI is %s', async (failure) => {
        await checkNight(configPath, power);
        now += 15 * 60_000;
        if (typeof failure === 'number') httpStatus = failure;
        else sessions = [{ id: 'missing-fields', thinking: false }];
        expect((await checkNight(configPath, power))?.state).toBe('hapi_unavailable');
        httpStatus = 200;
        sessions = [{ ...localIdle }];
        now += 15 * 60_000;
        expect((await checkNight(configPath, power))?.state).toBe('confirming_idle');
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
    });

    it('checks again when new work appears just before shutdown', async () => {
        await checkNight(configPath, power);
        now += 15 * 60_000;
        onList = () => { if (listRequests === 3) sessions = [{ ...localIdle, thinking: true }]; };
        expect((await checkNight(configPath, power))?.state).toBe('waiting_for_work');
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
    });

    it('starts confirmation again after a missed poll or a postponed window', async () => {
        await checkNight(configPath, power);
        now += 60 * 60_000;
        expect((await checkNight(configPath, power))?.state).toBe('confirming_idle');
        now += 15 * 60_000;
        plan.revision = randomUUID();
        expect((await checkNight(configPath, power))?.state).toBe('confirming_idle');
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'replaced', 'before-window', 'deadline'])('does no early shutdown when %s', async (condition) => {
        if (condition === 'cancelled') vi.mocked(power.status).mockResolvedValue({ scheduled: false, taskName: 'deadline' });
        if (condition === 'replaced') plan.id = randomUUID();
        if (condition === 'before-window') plan.afterUtc = new Date(now + 60_000).toISOString();
        if (condition === 'deadline') now = Date.parse(plan.deadlineUtc);
        await checkNight(configPath, power);
        expect(listRequests).toBe(0);
        expect(power.shutdownNightIfCurrent).not.toHaveBeenCalled();
    });

    it('reports refusal if Windows has cancelled the plan during an idle check', async () => {
        await checkNight(configPath, power);
        now += 15 * 60_000;
        vi.mocked(power.shutdownNightIfCurrent).mockResolvedValue({ accepted: false });
        expect((await checkNight(configPath, power))?.state).toBe('confirming_idle');
    });

    it('accepts a night command through MCP with the 15-minute default and immediate mute', async () => {
        await writeFile(join(directory, 'settings.json'), JSON.stringify({ cliApiToken: 'secret', machineId: 'this-pc', apiUrl }));
        vi.stubEnv('HAPI_HOME', directory);
        vi.stubEnv('XDG_STATE_HOME', directory);
        vi.stubEnv('CLI_API_TOKEN', '');
        vi.stubEnv('HAPI_API_URL', '');
        vi.stubEnv('WINDOWS_POWER_HAPI_URL', '');
        vi.stubEnv('WINDOWS_POWER_HAPI_MACHINE_ID', '');
        vi.stubEnv('HAPI_EXTRA_HEADERS_JSON', '{}');
        vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
        vi.spyOn(power, 'muteAudio').mockResolvedValue({ volumePercent: 0 });
        vi.spyOn(power, 'scheduleNight').mockImplementation(async (night) => {
            expect(power.muteAudio).toHaveBeenCalledOnce();
            const saved = JSON.parse(await readFile(night.configPath, 'utf8'));
            expect(saved.id).toBe(night.id);
            expect((await stat(night.configPath)).mode & 0o777).toBe(0o600);
            expect(night.checkEveryMinutes).toBe(15);
            expect(night.machineId).toBe('this-pc');
            return { scheduled: true, taskName: 'deadline', night };
        });
        const mcp = createMcpServer(power);
        const client = new Client({ name: 'night-command', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        try {
            const result = await client.callTool({ name: 'schedule_night_shutdown', arguments: {
                after: new Date(now + 60 * 60_000).toISOString(),
                deadline: new Date(now + 4 * 60 * 60_000).toISOString()
            } });
            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({ volumePercent: 0, night: { checkEveryMinutes: 15 } });
            expect(JSON.stringify(result)).not.toContain('secret');
        } finally {
            await client.close();
            await mcp.close();
        }
    });

    it.each(['hapi-down', 'deadline-before-start', 'missing-timezone'])('refuses scheduling without muting or registering tasks when %s', async (condition) => {
        await writeFile(join(directory, 'settings.json'), JSON.stringify({ cliApiToken: 'secret', machineId: 'this-pc', apiUrl }));
        vi.stubEnv('HAPI_HOME', directory);
        vi.stubEnv('CLI_API_TOKEN', '');
        vi.stubEnv('HAPI_API_URL', '');
        vi.stubEnv('WINDOWS_POWER_HAPI_URL', '');
        vi.stubEnv('WINDOWS_POWER_HAPI_MACHINE_ID', '');
        vi.stubEnv('HAPI_EXTRA_HEADERS_JSON', '{}');
        vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
        const mute = vi.spyOn(power, 'muteAudio');
        const register = vi.spyOn(power, 'scheduleNight');
        if (condition === 'hapi-down') httpStatus = 503;
        const after = new Date(now + 60 * 60_000).toISOString();
        const deadline = new Date(now + (condition === 'deadline-before-start' ? 30 : 240) * 60_000).toISOString();
        await expect(new NightShutdown(power).schedule({
            after: condition === 'missing-timezone' ? after.slice(0, -1) : after, deadline
        })).rejects.toThrow();
        expect(mute).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });
});
