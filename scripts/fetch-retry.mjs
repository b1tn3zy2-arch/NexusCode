// Shared fetch-with-retry for sidecar download scripts.
// GitHub/PyPI/python.org flake (rate limits, 5xx) must not kill a build:
// retry with backoff, then throw a clear error.
export async function fetchRetry(url, { what = "fetch", tries = 4, baseMs = 1500 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "nexuscode-build" } });
      if (res.ok) return res;
      // 429/5xx are retryable; 4xx (bad tag, gone asset) fail fast.
      if (res.status !== 429 && (res.status < 500 || res.status > 599)) {
        throw new Error(`${what}: HTTP ${res.status}`);
      }
      last = new Error(`${what}: HTTP ${res.status} (attempt ${i}/${tries})`);
    } catch (e) {
      last = e;
    }
    if (i < tries) {
      const wait = baseMs * 2 ** (i - 1);
      console.log(`[net] retry ${i}/${tries} in ${wait}ms: ${last.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last instanceof Error ? last : new Error(`${what}: failed`);
}

export async function fetchJson(url, what) {
  const res = await fetchRetry(url, { what });
  return res.json();
}

export async function fetchBuf(url, what) {
  const res = await fetchRetry(url, { what });
  return Buffer.from(await res.arrayBuffer());
}
