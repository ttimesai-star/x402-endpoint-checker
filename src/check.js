// One unpaid check of one x402 endpoint plus an optional Bazaar catalogue lookup.
// No payment header is ever sent; nothing is signed; no wallet is involved.
import { parseChallenge, validateChallenge, compareWithListing, normUrl, caip } from './x402.js';

export const UA = 'x402-endpoint-checker/0.1 (+https://apify.com/ttimesai/x402-endpoint-checker)';
export const BAZAAR_SEARCH = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Looks a resource up in the public x402 Bazaar (Coinbase CDP discovery API, no key).
 * Returns { checked, listed, ... }. "listed: false" means "not returned by Bazaar search",
 * which is a strong hint but not proof that the resource is absent from the catalogue.
 */
export async function bazaarLookup(url, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
    let query;
    try {
        const u = new URL(url);
        query = `${u.host}${u.pathname}`;
    } catch {
        return { checked: false, error: 'invalid URL' };
    }
    try {
        const r = await fetchImpl(`${BAZAAR_SEARCH}?query=${encodeURIComponent(query)}`, {
            headers: { 'user-agent': UA, accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) return { checked: false, error: `Bazaar search HTTP ${r.status}` };
        const d = await r.json();
        const want = normUrl(url);
        const wantNoQuery = want.split('?')[0];
        const hits = (d.resources ?? []).filter((x) => {
            const n = normUrl(x.resource);
            return n === want || n.split('?')[0] === wantNoQuery;
        });
        if (hits.length === 0) return { checked: true, listed: false, partialResults: !!d.partialResults };
        const it = hits[0];
        const info = it.extensions?.bazaar?.info?.input ?? {};
        return {
            checked: true,
            listed: true,
            resource: it.resource,
            serviceName: it.serviceName ?? null,
            description: String(it.description ?? '').slice(0, 300) || null,
            listedMethod: info.method ? String(info.method).toUpperCase() : null,
            listedExampleInput: info.body ?? info.queryParams ?? null,
            listedAccepts: (it.accepts ?? []).map((a) => ({
                scheme: a.scheme,
                network: caip(a.network),
                asset: a.asset,
                amount: String(a.amount ?? a.maxAmountRequired ?? ''),
                payTo: a.payTo,
            })),
            lastUpdated: it.lastUpdated ?? null,
        };
    } catch (e) {
        return { checked: false, error: e.name === 'TimeoutError' ? `Bazaar search timeout ${timeoutMs} ms` : String(e.message).slice(0, 200) };
    }
}

/** Builds the HTTP request for the probe. Example input from the catalogue is used only in AUTO mode. */
export function buildRequest(url, { method, body, listing, timeoutMs }) {
    let m = method === 'AUTO' ? (listing?.listedMethod ?? 'GET') : method;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) m = 'GET';
    const example = method === 'AUTO' && listing?.listedExampleInput && typeof listing.listedExampleInput === 'object' ? listing.listedExampleInput : null;
    const init = {
        method: m,
        headers: { 'user-agent': UA, accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    };
    let target = url;
    if (BODY_METHODS.has(m)) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body ?? example ?? {});
    } else if (example && !Array.isArray(example)) {
        const u = new URL(url);
        for (const [k, v] of Object.entries(example)) if (!u.searchParams.has(k) && v !== null && typeof v !== 'object') u.searchParams.set(k, String(v));
        target = u.toString();
    }
    return { target, init };
}

/** Classifies a finished check into one status string (see README). */
export function statusOf(out) {
    if (out.error) return 'unreachable';
    if (out.httpStatus === 402) return out.challenge?.valid ? 'valid_x402' : 'invalid_x402_challenge';
    if (out.httpStatus >= 200 && out.httpStatus < 300) return 'no_payment_required';
    return 'http_error';
}

export async function checkEndpoint(url, { method = 'AUTO', body = null, checkBazaar = true, timeoutMs = 20000, fetchImpl = fetch } = {}) {
    const out = { url, checkedAt: new Date().toISOString(), paymentSent: false };
    const listing = checkBazaar ? await bazaarLookup(url, { fetchImpl, timeoutMs }) : { checked: false };
    const { target, init } = buildRequest(url, { method, body, listing, timeoutMs });
    out.method = init.method;
    out.requestUrl = target !== url ? target : undefined;
    const t0 = performance.now();
    try {
        const r = await fetchImpl(target, init);
        out.latencyMs = Math.round(performance.now() - t0);
        out.httpStatus = r.status;
        out.finalUrl = r.url && r.url !== target ? r.url : undefined;
        out.https = new URL(r.url || target).protocol === 'https:';
        out.contentType = r.headers.get('content-type');
        const text = init.method === 'HEAD' ? '' : (await r.text()).slice(0, 65536);
        if (r.status === 402) {
            const ch = parseChallenge(r.headers, text);
            const v = validateChallenge(ch);
            out.challenge = { source: ch.source, x402Version: v.version, valid: v.ok, issues: v.issues.slice(0, 20), accepts: v.accepts };
            const priced = v.accepts.filter((a) => a.priceUsd !== null);
            out.minPriceUsd = priced.length ? Math.min(...priced.map((a) => a.priceUsd)) : null;
        } else {
            out.bodyPreview = text.slice(0, 200) || undefined;
        }
    } catch (e) {
        out.latencyMs = Math.round(performance.now() - t0);
        const c = e.cause ?? {};
        out.error = e.name === 'TimeoutError' ? `timeout ${timeoutMs} ms` : `${c.code ?? e.name}: ${c.message || e.message}`.slice(0, 200);
    }
    out.reachable = !out.error;
    out.status = statusOf(out);
    out.bazaar = listing;
    if (listing.listed && out.challenge) out.bazaar.match = compareWithListing(out.challenge.accepts, listing.listedAccepts);
    return out;
}
