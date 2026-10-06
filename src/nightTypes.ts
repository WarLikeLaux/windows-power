import { z } from 'zod';

export const NightPlanSchema = z.object({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    afterUtc: z.string().datetime(),
    deadlineUtc: z.string().datetime(),
    checkEveryMinutes: z.number().int().min(1).max(60),
    machineId: z.string().min(1),
    configPath: z.string().min(1),
    launchArguments: z.string().min(1),
    wakeComputer: z.boolean()
});

export type NightPlan = z.infer<typeof NightPlanSchema>;

export const NightCheckSchema = z.object({
    revision: z.string(),
    checkedAt: z.number(),
    idleSince: z.number().nullable(),
    state: z.enum(['waiting_for_work', 'confirming_idle', 'hapi_unavailable', 'shutdown_requested', 'expired']),
    blockers: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })),
    error: z.string().optional()
});

export type NightCheck = z.infer<typeof NightCheckSchema>;

export const NightConfigSchema = z.object({
    id: z.string().uuid(),
    apiUrl: z.string().url(),
    accessToken: z.string().min(1),
    headers: z.record(z.string(), z.string())
});

export type NightConfig = z.infer<typeof NightConfigSchema>;
