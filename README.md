# x402 Endpoint Checker

Check [x402](https://www.x402.org/) (HTTP 402 "Payment Required") API endpoints **without paying anything**. For every URL you give it, the Actor makes one ordinary request, reads the payment challenge the server returns, and tells you:

- **Is it up?** HTTP status, latency, TLS, redirects, or the network error.
- **Is the 402 challenge valid?** x402 version, where the challenge came from (v2 `PAYMENT-REQUIRED` header or v1 JSON body), and a list of concrete problems: unknown scheme, unrecognised network, malformed `payTo` or asset address, zero or non-integer amount, missing EIP-712 domain name for USDC, and so on.
- **What exactly does it ask for?** Scheme, network (CAIP-2 id and readable name), asset (USDC is recognised on Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche and Solana), raw amount, **price in USD**, `payTo` address, testnet flag.
- **Does it match its catalogue listing?** The URL is looked up in the public **x402 Bazaar** (Coinbase CDP discovery API). If it is listed, you get the service name, description and listed price, plus two checks: does the live `payTo` match the listing, and does the live price match the listing.

Typical uses:

- **Before an AI agent pays:** confirm the endpoint is alive and asks for the price and the address it advertises.
- **Sellers of x402 APIs:** smoke-test your own endpoints after a deploy (valid challenge, correct `payTo`, correct price on every network you accept).
- **Directory and marketplace operators:** clean a list of x402 endpoints, drop dead ones, flag listings whose live `payTo` or price differs.

## What it does not do

- It **never pays** and never sends a payment header. It cannot tell you whether the seller actually delivers after payment; that needs a real purchase.
- A matching `payTo` means "same address as the listing", not "this address belongs to who you think it does".
- Bazaar lookup uses the public search endpoint. `listed: false` means the search did not return this exact URL; it is a strong hint, not proof that the URL is absent from the catalogue.
- The validator checks the structure of the challenge. It does not query blockchains.

## Input

| Field | Default | Meaning |
|---|---|---|
| `urls` | required | Endpoint URLs, one per line (up to 1,000 per run; duplicates are removed). |
| `method` | `AUTO` | `AUTO` uses the method and example input from the endpoint's Bazaar listing (or `GET` if not listed). Pick a fixed method to override. |
| `requestBody` | empty | JSON body for POST/PUT/PATCH. Empty: the Bazaar example (in `AUTO`) or `{}`. |
| `checkBazaar` | `true` | Look each URL up in the x402 Bazaar and compare `payTo` and price. |
| `timeoutSecs` | `20` | Per-request timeout. |
| `maxConcurrency` | `10` | Total parallel requests. Never more than 2 at a time to one host. |

Example:

```json
{
  "urls": [
    "https://x402.tbs-digital.com/company/resolve",
    "https://your-api.example.com/v1/paid-endpoint"
  ],
  "method": "AUTO",
  "checkBazaar": true
}
```

## Output

One dataset item per URL. The `status` field is one of:

| `status` | Meaning |
|---|---|
| `valid_x402` | Answered 402 with a challenge in which at least one payment option is fully valid. |
| `invalid_x402_challenge` | Answered 402, but no payment option is valid. See `challenge.issues`. |
| `no_payment_required` | Answered 2xx without payment (the endpoint is free, or the paywall is not active). |
| `http_error` | Any other HTTP status (404, 500, ...). |
| `unreachable` | DNS error, refused connection, TLS error or timeout. See `error`. |
| `invalid_input` | Not an http(s) URL. Not charged. |

A real item from a test run on 14 October 2026 (abridged):

```json
{
  "url": "https://x402.tbs-digital.com/company/resolve",
  "status": "valid_x402",
  "method": "GET",
  "requestUrl": "https://x402.tbs-digital.com/company/resolve?country=fr&name=TotalEnergies",
  "httpStatus": 402,
  "latencyMs": 574,
  "minPriceUsd": 0.002,
  "paymentSent": false,
  "challenge": {
    "source": "header",
    "x402Version": 2,
    "valid": true,
    "issues": [],
    "accepts": [
      {
        "scheme": "exact",
        "network": "eip155:8453",
        "networkName": "Base",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "assetSymbol": "USDC",
        "amount": "2000",
        "priceUsd": 0.002,
        "payTo": "0xd6fCE15298Fc9D60f867d9455D497177Da9BFB0a",
        "testnet": false,
        "ok": true
      }
    ]
  },
  "bazaar": {
    "checked": true,
    "listed": true,
    "serviceName": "TBS Company SIREN/VAT/LEI API",
    "match": { "payToMatch": true, "priceMatch": true }
  }
}
```

An invalid challenge looks like this:

```json
{
  "url": "https://keyring-agent.blockchhub.link/api/swap-token",
  "status": "invalid_x402_challenge",
  "httpStatus": 402,
  "challenge": {
    "valid": false,
    "issues": ["accepts[0].amount \"0\" is not a positive integer"]
  },
  "bazaar": { "listed": true, "match": { "payToMatch": true, "priceMatch": false } }
}
```

The full sample is in [`examples/output_sample.json`](https://github.com/ttimesai-star/x402-endpoint-checker/blob/main/examples/output_sample.json).

## Pricing

Right now the Actor has no fee of its own: you pay only Apify platform usage. In our test run on Apify, checking 7 endpoints used $0.00015 of platform usage. Invalid input lines are skipped.

## How it works

1. (Optional) Bazaar search for the URL's host and path; exact URL match only.
2. One HTTP request to the endpoint with the method and example input from the listing (or your own).
3. If the answer is 402: parse the v2 `PAYMENT-REQUIRED` header (base64 JSON) or the v1 JSON body, validate every `accepts` entry, compute the USD price for known USDC contracts, compare with the listing.

The validation code comes from **Delivery Score**, an open-source (MIT) project that, in October 2026, probed 15,498 of the 32,585 x402 endpoints listed in the Bazaar (up to 100 per host, 2,185 hosts). Source of this Actor: [github.com/ttimesai-star/x402-endpoint-checker](https://github.com/ttimesai-star/x402-endpoint-checker).

## Status and support

Version 0.1, early release. It is tested with unit tests and on live endpoints, but it has few users so far. If a result looks wrong, open an issue on the Actor's Issues tab with the URL and the run ID.
