#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WindowsPower } from './windowsPower.js';

const VERSION = '0.1.0';
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

    server.registerTool('get_shutdown_status', {
        description: 'Read the active Windows shutdown schedule and exact remaining time.',
        inputSchema: {}
    }, async () => {
        try {
            return toolResult(await windowsPower.status());
        } catch (error) {
            return errorResult(error);
        }
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
