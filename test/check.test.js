import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChallenge, validateChallenge, usdPrice, caip, normUrl, compareWithListing } from '../src/x402.js';
import { checkEndpoint, buildRequest, BAZAAR_SEARCH } from '../src/check.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea';
const OTHER = '0x1111111111111111111111111111111111111111';
const ok = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC_BASE, amount: '10000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const hdr = (v) => new Headers({ 'payment-required': b64(v) });

// Minimal fetch double: routes by URL prefix, records requests.
function fakeFetch(routes) {
    const calls = [];
    const f = async (url, init = {}) => {
        calls.push({ url, init });
        for (const [prefix, fn] of routes) if (url.startsWith(prefix)) return fn(url, init);
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'no route' } });
    };
    f.calls = calls;
    return f;
}
const resp = (status, body, headers = {}) => {
    const r = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
    return r;
};

describe('x402 challenge validation (ported from Delivery Score)', () => {
    it('accepts a well-formed v2 header challenge and prices it in USDC', () => {
        const v = validateChallenge(parseChallenge(hdr(ok), ''));
        assert.equal(v.ok, true);
        assert.equal(v.accepts[0].priceUsd, 0.01);
        assert.equal(v.accepts[0].assetSymbol, 'USDC');
        assert.equal(v.accepts[0].networkName, 'Base');
    });
    it('accepts a v1 body challenge with network names', () => {
        const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', asset: USDC_BASE, maxAmountRequired: '1000', payTo: PAY_TO, extra: { name: 'USD Coin' } }] });
        const v = validateChallenge(parseChallenge(new Headers(), body));
        assert.equal(v.ok, true);
        assert.equal(v.accepts[0].network, 'eip155:8453');
    });
    it('reports each malformed field as a fact', () => {
        const bad = { x402Version: 3, accepts: [{ scheme: 'magic', network: 'eip155:8453', asset: '0x12', amount: '0', payTo: '0x0000000000000000000000000000000000000000' }] };
        const v = validateChallenge(parseChallenge(hdr(bad), ''));
        assert.equal(v.ok, false);
        assert.equal(v.issues.length, 5);
    });
    it('a 402 with an HTML body is not a challenge', () => {
        const v = validateChallenge(parseChallenge(new Headers(), '<html>pay me</html>'));
        assert.equal(v.ok, false);
        assert.match(v.issues[0], /not JSON/);
    });
    it('does not crash on null entries or a non-object challenge', () => {
        assert.equal(validateChallenge({ value: { x402Version: 2, accepts: [null] } }).ok, false);
        assert.equal(validateChallenge({ value: 'x' }).ok, false);
    });
    it('flags a missing EIP-712 domain name on EVM USDC exact', () => {
        const v = validateChallenge(parseChallenge(hdr({ x402Version: 2, accepts: [{ ...ok.accepts[0], extra: {} }] }), ''));
        assert.equal(v.ok, false);
        assert.match(v.issues[0], /extra.name/);
    });
    it('prices only known USDC contracts', () => {
        assert.equal(usdPrice({ network: 'eip155:8453', asset: OTHER, amount: '1000' }), null);
        assert.equal(caip('solana'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    });
    it('normalises URLs for catalogue matching', () => {
        assert.equal(normUrl('https://API.example.com/a/'), 'https://api.example.com/a');
        assert.equal(normUrl('https://api.example.com/'), 'https://api.example.com');
        assert.equal(normUrl('https://api.example.com/a?x=1#f'), 'https://api.example.com/a?x=1');
    });
    it('compares live and listed payTo/price', () => {
        const live = validateChallenge(parseChallenge(hdr(ok), '')).accepts;
        assert.deepEqual(compareWithListing(live, [{ network: 'base', payTo: PAY_TO.toLowerCase(), amount: '10000' }]), { payToMatch: true, priceMatch: true });
        assert.deepEqual(compareWithListing(live, [{ network: 'eip155:8453', payTo: OTHER, amount: '20000' }]), { payToMatch: false, priceMatch: false });
    });
});

describe('checkEndpoint (no network, fake fetch)', () => {
    const EP = 'https://api.example.com/v1/quote';
    const bazaarHit = (accepts, method = 'GET', example = null) => [BAZAAR_SEARCH, () => resp(200, {
        partialResults: false,
        resources: [{ resource: EP, serviceName: 'Example', description: 'quotes', accepts, lastUpdated: '2026-10-01T00:00:00Z', extensions: { bazaar: { info: { input: { method, ...(example ? { body: example } : {}) } } } } }],
    })];

    it('valid 402 + Bazaar match, never sends a payment header', async () => {
        const f = fakeFetch([bazaarHit(ok.accepts), [EP, () => resp(402, '{}', { 'payment-required': b64(ok) })]]);
        const r = await checkEndpoint(EP, { fetchImpl: f });
        assert.equal(r.status, 'valid_x402');
        assert.equal(r.minPriceUsd, 0.01);
        assert.equal(r.bazaar.listed, true);
        assert.deepEqual(r.bazaar.match, { payToMatch: true, priceMatch: true });
        assert.equal(r.paymentSent, false);
        for (const c of f.calls) {
            const h = Object.keys(c.init.headers ?? {}).map((k) => k.toLowerCase());
            assert.ok(!h.includes('x-payment') && !h.includes('payment-signature'));
        }
    });
    it('AUTO uses the listed method and example body', async () => {
        const f = fakeFetch([bazaarHit(ok.accepts, 'POST', { q: 'x' }), [EP, () => resp(402, ok)]]);
        const r = await checkEndpoint(EP, { fetchImpl: f });
        assert.equal(r.method, 'POST');
        assert.equal(f.calls[1].init.body, JSON.stringify({ q: 'x' }));
        assert.equal(r.challenge.source, 'body');
    });
    it('reports payTo mismatch with the listing', async () => {
        const f = fakeFetch([bazaarHit([{ ...ok.accepts[0], payTo: OTHER }]), [EP, () => resp(402, '', { 'payment-required': b64(ok) })]]);
        const r = await checkEndpoint(EP, { fetchImpl: f });
        assert.equal(r.bazaar.match.payToMatch, false);
    });
    it('200 without payment is no_payment_required', async () => {
        const f = fakeFetch([[BAZAAR_SEARCH, () => resp(200, { resources: [] })], [EP, () => resp(200, { data: 1 })]]);
        const r = await checkEndpoint(EP, { fetchImpl: f });
        assert.equal(r.status, 'no_payment_required');
        assert.equal(r.bazaar.listed, false);
    });
    it('invalid challenge is reported with issues', async () => {
        const f = fakeFetch([[EP, () => resp(402, '<html>pay</html>')]]);
        const r = await checkEndpoint(EP, { fetchImpl: f, checkBazaar: false });
        assert.equal(r.status, 'invalid_x402_challenge');
        assert.ok(r.challenge.issues.length > 0);
    });
    it('DNS failure is unreachable, Bazaar outage does not break the check', async () => {
        const f = fakeFetch([[BAZAAR_SEARCH, () => resp(503, 'down')]]);
        const r = await checkEndpoint(EP, { fetchImpl: f });
        assert.equal(r.status, 'unreachable');
        assert.match(r.error, /ENOTFOUND/);
        assert.equal(r.bazaar.checked, false);
    });
    it('5xx is http_error', async () => {
        const f = fakeFetch([[EP, () => resp(500, 'boom')]]);
        const r = await checkEndpoint(EP, { fetchImpl: f, checkBazaar: false });
        assert.equal(r.status, 'http_error');
    });
    it('fixed GET does not take the example body; query example is added in AUTO only', () => {
        const listing = { listedMethod: 'GET', listedExampleInput: { city: 'Paris' } };
        assert.equal(buildRequest(EP, { method: 'AUTO', listing, timeoutMs: 1000 }).target, `${EP}?city=Paris`);
        assert.equal(buildRequest(EP, { method: 'GET', listing, timeoutMs: 1000 }).target, EP);
    });
});
