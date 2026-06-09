import { pipeline } from "@huggingface/transformers";
import { DIM } from "./db.js";

const MODEL = process.env.RECALL_MODEL || "Xenova/bge-small-en-v1.5";

// transformers.js types are loose; treat the pipeline as a callable.
let _extractorP: Promise<any> | null = null;

function getExtractor(): Promise<any> {
  if (!_extractorP) _extractorP = pipeline("feature-extraction", MODEL);
  return _extractorP;
}

/** Pre-load the model so the first real request isn't slow. */
export async function warmup(): Promise<void> {
  await getExtractor();
}

const BATCH = 32;

/** Embed a batch of texts into normalized 384-dim vectors. Sub-batched so a
 *  huge transcript doesn't trigger one enormous forward pass. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const result: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const chunk = texts.slice(start, start + BATCH);
    const out = await extractor(chunk, { pooling: "mean", normalize: true });
    const data = out.data as Float32Array; // flat: chunk.length * DIM
    for (let i = 0; i < chunk.length; i++) {
      // copy each row into its own buffer so blobs are independent
      result.push(data.slice(i * DIM, (i + 1) * DIM));
    }
  }
  return result;
}

export async function embedOne(text: string): Promise<Float32Array> {
  return (await embed([text]))[0];
}
