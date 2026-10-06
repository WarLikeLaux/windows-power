#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WindowsPower } from './windowsPower.js';
import { NightShutdown } from './nightShutdown.js';

const VERSION = '0.2.0';
const MAX_DELAY_MINUTES = 365 * 24 * 60;
const power = new WindowsPower();

function toolResult(value: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: value as Record<string, unknown>
    };
}

function errorResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: 'text' as const, text: message }]
    };
}

function resolveEpoch(afterMinutes?: number, at?: string): number {
    if ((afterMinutes === undefined) === (at === undefined)) {
        throw new Error('Provide exactly one of afterMinutes or at.');
    }

    if (afterMinutes !== undefined) {
        return Math.floor(Date.now() / 1000) + afterMinutes * 60;
    }

    const epochMilliseconds = Date.parse(at!);
    if (!Number.isFinite(epochMilliseconds)) {
        throw new Error('at must be an RFC 3339 timestamp, including a timezone offset.');
    }
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(at!)) {
        throw new Error('at must include a timezone offset, for example 2026-09-14T03:30:00+06:00.');
    }
    return Math.floor(epochMilliseconds / 1000);
}

export function createServer(windowsPower: WindowsPower = power): McpServer {
    const server = new McpServer({ name: 'windows-power', version: VERSION });
    const night = new NightShutdown(windowsPower);

    server.registerTool('get_shutdown_status', {
        description: 'Read the Windows shutdown time, night window and latest HAPI check, including sessions that are still blocking shutdown.',
        inputSchema: {}
    }, async () => {
        try {
            return toolResult(await night.status());
        } catch (error) {
            return errorResult(error);
        }
    });

    server.registerTool('schedule_night_shutdown', {
        description: 'Set Windows volume to 0%, then shut down after HAPI agents on this computer finish, with an independent forced deadline. Checks every 15 minutes by default. Replaces the existing managed schedule.',
        inputSchema: {
            after: z.string().describe('Earliest shutdown time, RFC 3339 with timezone offset.'),
            deadline: z.string().describe('Forced shutdown deadline, RFC 3339 with timezone offset.'),
            checkEveryMinutes: z.number().int().min(1).max(60).default(15).describe('HAPI polling interval in minutes.'),
            wakeComputer: z.boolean().default(true).describe('Wake Windows to check HAPI and enforce the deadline.')
        }
    }, async (options) => {
        try { return toolResult(await night.schedule(options)); }
        catch (error) { return errorResult(error); }
    });

    server.registerTool('mute_audio', {
        description: 'Set all default Windows audio output roles to 0% and verify the volume.',
        inputSchema: {}
    }, async () => {
        try { return toolResult(await windowsPower.muteAudio()); }
        catch (error) { return errorResult(error); }
    });

    server.registerTool('schedule_shutdown', {
        description: 'Schedule a one-time Windows shutdown. Replaces an existing Windows Power MCP shutdown. Forced app closing can lose unsaved work.',
        inputSchema: {
            afterMinutes: z.number().int().min(1).max(MAX_DELAY_MINUTES).optional().describe('Minutes from now.'),
            at: z.string().optional().describe('RFC 3339 timestamp with timezone offset.'),
            forceCloseApps: z.boolean().default(true).describe('Force applications to close at shutdown.'),
            wakeComputer: z.boolean().default(true).describe('Ask Task Scheduler to wake the computer for this task.')
        }
    }, async ({ afterMinutes, at, forceCloseApps, wakeComputer }) => {
        try {
            const epochSeconds = resolveEpoch(afterMinutes, at);
            if (epochSeconds <= Math.floor(Date.now() / 1000) + 30) {
                throw new Error('Scheduled shutdown must be at least 30 seconds in the future.');
            }
            return toolResult(await windowsPower.schedule({ epochSeconds, forceCloseApps, wakeComputer }));
        } catch (error) {
            return errorResult(error);
        }
    });

    server.registerTool('postpone_shutdown', {
        description: 'Move the active Windows shutdown later or earlier by a signed number of minutes.',
        inputSchema: {
            minutes: z.number().int().min(-MAX_DELAY_MINUTES).max(MAX_DELAY_MINUTES).refine(value => value !== 0, 'minutes cannot be zero')
        }
    }, async ({ minutes }) => {
        try {
            return toolResult(await windowsPower.postpone(minutes));
        } catch (error) {
            return errorResult(error);
        }
    });

    server.registerTool('cancel_shutdown', {
        description: 'Cancel the shutdown managed by Windows Power MCP.',
        inputSchema: {}
    }, async () => {
        try {
            return toolResult(await windowsPower.cancel());
        } catch (error) {
            return errorResult(error);
        }
    });

    server.registerTool('shutdown_now', {
        description: 'Force Windows to shut down after five seconds. This can lose unsaved work and requires an exact confirmation string.',
        inputSchema: {
            confirmation: z.literal('SHUTDOWN NOW').describe('Must be exactly SHUTDOWN NOW, after explicit user confirmation.')
        }
    }, async ({ confirmation }) => {
        try {
            return toolResult(await windowsPower.shutdownNow(confirmation));
        } catch (error) {
            return errorResult(error);
        }
    });

    return server;
}

async function main(): Promise<void> {
    const [command, ...args] = process.argv.slice(2);
    if (command) {
        const night = new NightShutdown(power);
        let result: unknown;
        if (command === 'night') {
            const flags = z.object({ after: z.string(), deadline: z.string(), interval: z.coerce.number().int().min(1).max(60).optional() });
            const values: Record<string, string> = {};
            for (let i = 0; i < args.length; i += 2) {
                const name = args[i];
                if (!['--after', '--deadline', '--interval'].includes(name!) || !args[i + 1] || values[name!.slice(2)]) {
                    throw new Error('Usage: windows-power-mcp night --after <RFC3339> --deadline <RFC3339> [--interval <minutes>]');
                }
                values[name!.slice(2)] = args[i + 1]!;
            }
            const options = flags.parse(values);
            result = await night.schedule({ after: options.after, deadline: options.deadline, checkEveryMinutes: options.interval });
        } else if (command === 'postpone') {
            if (args.length !== 2 || args[0] !== '--minutes') throw new Error('Usage: windows-power-mcp postpone --minutes <signed minutes>');
            const minutes = z.coerce.number().int().min(-MAX_DELAY_MINUTES).max(MAX_DELAY_MINUTES).refine(value => value !== 0).parse(args[1]);
            result = await power.postpone(minutes);
        } else if (args.length) throw new Error('This command accepts no arguments.');
        else if (command === 'status') result = await night.status();
        else if (command === 'cancel') result = await power.cancel();
        else if (command === 'mute') result = await power.muteAudio();
        else throw new Error('Commands: night, status, postpone, cancel, mute. Run without arguments for MCP stdio.');
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

const isEntrypoint = process.argv[1]
    ? realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    : false;

if (isEntrypoint) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

export { resolveEpoch };
