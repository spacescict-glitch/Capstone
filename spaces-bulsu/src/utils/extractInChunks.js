export async function extractInChunks({
  rawText,
  endpoint,
  payload = {},
  maxChunkChars = 1500,
  onProgress,
}) {
  // Split by lines para hindi maputol ang isang schedule row
  const lines = rawText.split(/\r?\n/);
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if (current && (current.length + line.length + 1) > maxChunkChars) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) chunks.push(current);

  if (chunks.length === 1 && chunks[0].length > maxChunkChars * 2) {
    const big = chunks[0];
    chunks.length = 0;
    for (let i = 0; i < big.length; i += maxChunkChars) {
      chunks.push(big.slice(i, i + maxChunkChars));
    }
  }

  console.log(`📦 Split into ${chunks.length} chunk(s)`);

  const allSchedules = [];
  const MAX_TRIES = 6;

  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i + 1, chunks.length);

    let attempt = 0;
    let data = null;
    let lastErr = null;

    while (attempt < MAX_TRIES) {
      attempt++;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, rawText: chunks[i] }),
        });

        let parsed = null;
        try {
          parsed = await res.json();
        } catch {
          parsed = null;
        }

        // ✅ Retry sa: 404 (cold start), 500 (timeout), 502 (edge), 503 (busy), 429 (rate limit)
        if ([404, 500, 502, 503, 429].includes(res.status) && attempt < MAX_TRIES) {
          const waitMs = Math.min(800 * Math.pow(2, attempt), 8000);
          console.warn(
            `Chunk ${i + 1} got ${res.status}. Retry ${attempt}/${MAX_TRIES} in ${waitMs}ms...`
          );
          if (onProgress) onProgress(`retry-${attempt}`, chunks.length);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (!res.ok || !parsed?.success) {
          throw new Error(
            `Chunk ${i + 1}/${chunks.length}: ${
              parsed?.message || res.statusText || res.status
            }`
          );
        }

        data = parsed;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt >= MAX_TRIES) throw err;
        const waitMs = Math.min(800 * Math.pow(2, attempt), 8000);
        console.warn(
          `Chunk ${i + 1} error: ${err.message}. Retry ${attempt}/${MAX_TRIES} in ${waitMs}ms...`
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    if (!data) {
      throw new Error(
        `Chunk ${i + 1}/${chunks.length}: ${
          lastErr?.message || "Failed after retries."
        }`
      );
    }

    allSchedules.push(...(data.schedules || []));
  }

  // Dedupe
  const seen = new Set();
  const unique = [];
  for (const s of allSchedules) {
    const key = [
      (s.subject || "").toLowerCase().trim(),
      (s.section || "").toLowerCase().trim(),
      (s.day || "").toUpperCase().trim(),
      s.startTime || "",
      s.endTime || "",
      (s.room || "").toLowerCase().trim(),
      (s.faculty || "").toLowerCase().trim(),
    ].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(s);
    }
  }

  console.log(`✅ ${allSchedules.length} raw → ${unique.length} unique`);
  return unique;
}