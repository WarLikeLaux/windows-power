import { z } from 'zod';
import type { NightConfig, NightPlan, NightCheck } from './nightTypes.js';

const SummarySchema = z.object({
    id: z.string(),
    active: z.boolean(),
    thinking: z.boolean(),
    backgroundTaskCount: z.number().int().nonnegative(),
    pendingRequestsCount: z.number().int().nonnegative(),
    futureScheduledMessageCount: z.number().int().nonnegative(),
    nextScheduledAt: z.number().nullable(),
    metadata: z.object({
        machineId: z.string().optional(),
        name: z.string().optional(),
        lifecycleState: z.string().optional()
    }).nullable()
});

const ListSchema = z.object({ sessions: z.array(SummarySchema) });
const DetailSchema = z.object({ session: z.object({
    activeTurnStartedAt: z.number().nullable().optional(),
    thinking: z.boolean(),
    backgroundTaskCount: z.number().int().nonnegative(),
    agentState: z.object({ requests: z.record(z.string(), z.unknown()).nullish() }).nullable()
}) });

export class HapiClient {
    public constructor(private readonly config: NightConfig) {}

    private async request(path: string, jwt?: string): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(`${this.config.apiUrl.replace(/\/+$/, '')}${path}`, {
                method: jwt ? 'GET' : 'POST',
                headers: {
                    ...this.config.headers,
                    'Content-Type': 'application/json',
                    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
                },
                ...(jwt ? {} : { body: JSON.stringify({ accessToken: this.config.accessToken }) }),
                signal: AbortSignal.timeout(10_000),
                redirect: 'error'
            });
        } catch {
            throw new Error('HAPI could not be reached.');
        }
        if (!response.ok) throw new Error(`HAPI returned HTTP ${response.status}.`);
        try { return await response.json(); } catch { throw new Error('HAPI returned invalid JSON.'); }
    }

    public async blockers(plan: Pick<NightPlan, 'machineId' | 'deadlineUtc'>): Promise<NightCheck['blockers']> {
        // Exchange on each poll so the four-hour JWT expiry cannot stop an overnight check.
        const auth = z.object({ token: z.string().min(1) }).safeParse(await this.request('/api/auth'));
        if (!auth.success) throw new Error('HAPI authentication returned an unexpected response.');
        // An unbounded list includes every session in the configured namespace.
        const list = ListSchema.safeParse(await this.request('/api/sessions', auth.data.token));
        if (!list.success) throw new Error('HAPI session status is incomplete or incompatible.');
        const blockers: NightCheck['blockers'] = [];
        for (const session of list.data.sessions) {
            if (session.metadata?.machineId && session.metadata.machineId !== plan.machineId) continue;
            const name = session.metadata?.name ?? session.id;
            const scheduledBeforeDeadline = session.futureScheduledMessageCount > 0
                && (session.nextScheduledAt === null || session.nextScheduledAt <= Date.parse(plan.deadlineUtc));
            let reason: string | undefined;
            if (session.thinking) reason = 'agent is working';
            else if (session.backgroundTaskCount > 0) reason = 'background tasks are running';
            else if (session.pendingRequestsCount > 0) reason = 'agent is waiting for user input';
            else if (scheduledBeforeDeadline) reason = 'a message is scheduled before the deadline';
            else if (!session.metadata?.machineId && session.active) reason = 'active session has no machine identity';
            else if (session.active && session.metadata?.lifecycleState !== 'archived') {
                const detail = DetailSchema.safeParse(await this.request(`/api/sessions/${encodeURIComponent(session.id)}`, auth.data.token));
                if (!detail.success) throw new Error('HAPI session detail is incomplete or incompatible.');
                const live = detail.data.session;
                if (live.thinking || live.activeTurnStartedAt != null) reason = 'an agent turn is in progress';
                else if (live.backgroundTaskCount > 0) reason = 'background tasks are running';
                else if (Object.keys(live.agentState?.requests ?? {}).length > 0) reason = 'agent is waiting for user input';
            }
            if (reason) blockers.push({ id: session.id, name, reason });
        }
        return blockers;
    }
}
