/** Results are always aligned with the input array, including failed images. */
export type OcrItemResult =
  | { index: number; status: "fulfilled"; value: string[]; resized?: boolean; rawLines?: string[] }
  | { index: number; status: "rejected"; reason: unknown };

export type OcrProgress = (done: number, total: number | undefined) => void;

export interface OcrEngine {
  readonly ready: boolean;
  initialize(): Promise<void>;
  batchRecognize(images: ArrayBuffer[], concurrency: number | "auto", onProgress?: OcrProgress): Promise<OcrItemResult[]>;
  destroy(): Promise<void>;
}
