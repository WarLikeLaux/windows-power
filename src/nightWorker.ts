import { checkNight } from './nightShutdown.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Night configuration path is required.');
checkNight(configPath).catch(() => {
    // Task Scheduler records the failure. The independent deadline remains armed.
    console.error('Windows Power night check failed.');
    process.exitCode = 1;
});
