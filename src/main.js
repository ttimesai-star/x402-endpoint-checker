// Apify Actor entry point: unpaid check of a list of x402 endpoints.
import { Actor, log } from 'apify';
import { checkEndpoint } from './check.js';

const EVENT = 'endpoint-checked';
const MAX_URLS = 1000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    urls = [],
    method = 'AUTO',
    requestBody = null,
    checkBazaar = true,
    timeoutSecs = 20,
    maxConcurrency = 10,
} = input;

// Accept plain strings and { url } objects (requestListSources style), drop blanks and duplicates.
const raw = (Array.isArray(urls) ? urls : [])
    .map((u) => (typeof u === 'string' ? u : u?.url))
    .filter((u) => typeof u === 'string' && u.trim())
    .map((u) => u.trim());
const unique = [...new Set(raw)];
if (unique.length === 0) {
    await Actor.fail('Input "urls" is empty. Add at least one http(s) URL of an x402 endpoint.');
}
if (unique.length > MAX_URLS) log.warning(`Got ${unique.length} URLs, checking the first ${MAX_URLS}.`);
const list = unique.slice(0, MAX_URLS);

const valid = [];
for (const u of list) {
    let ok = false;
    try {
        ok = ['http:', 'https:'].includes(new URL(u).protocol);
    } catch { /* invalid */ }
    if (ok) valid.push(u);
    // Invalid input is reported but never charged.
    else await Actor.pushData({ url: u, status: 'invalid_input', error: 'not an http(s) URL', paymentSent: false });
}

const timeoutMs = Math.max(3, Math.min(Number(timeoutSecs) || 20, 120)) * 1000;
const globalLimit = Math.max(1, Math.min(Number(maxConcurrency) || 10, 50));
const perHost = 2; // be polite: never more than two parallel requests to one host
const charging = Actor.getChargingManager();

log.info(`Checking ${valid.length} endpoint(s); method=${method}, Bazaar cross-check=${checkBazaar}, timeout=${timeoutMs / 1000}s. No payments are sent.`);

const counts = {};
let stopped = false;
const hostOf = (u) => new URL(u).host;
const active = new Map();
let running = 0;
const queue = [...valid];

async function runOne(u) {
    if (stopped) return;
    if (charging.calculateMaxEventChargeCountWithinLimit(EVENT) <= 0) {
        if (!stopped) log.warning('The maximum cost per run set by the user is reached; stopping. Remaining URLs were not checked and not charged.');
        stopped = true;
        return;
    }
    const res = await checkEndpoint(u, { method, body: requestBody, checkBazaar, timeoutMs });
    counts[res.status] = (counts[res.status] ?? 0) + 1;
    const charged = await Actor.pushData(res, EVENT);
    if (charged?.eventChargeLimitReached) stopped = true;
}

await new Promise((resolve) => {
    const tick = () => {
        if ((queue.length === 0 || stopped) && running === 0) return resolve();
        for (let i = 0; i < queue.length && running < globalLimit && !stopped;) {
            const h = hostOf(queue[i]);
            if ((active.get(h) ?? 0) >= perHost) {
                i++;
                continue;
            }
            const u = queue.splice(i, 1)[0];
            running++;
            active.set(h, (active.get(h) ?? 0) + 1);
            runOne(u)
                .catch((e) => log.exception(e, `check failed for ${u}`))
                .finally(() => {
                    running--;
                    active.set(h, active.get(h) - 1);
                    tick();
                });
        }
    };
    tick();
});

const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'nothing checked';
log.info(`Done. ${summary}`);
await Actor.setStatusMessage(`Checked ${Object.values(counts).reduce((a, b) => a + b, 0)} endpoint(s). ${summary}`, { isStatusMessageTerminal: true });
await Actor.exit();
