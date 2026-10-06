/** Browser decoder fallback; createImageBitmap decodes the first animation frame. */
export async function convertImageToPng(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof createImageBitmap === "undefined") throw new Error("This image format is not supported by the system decoder or this renderer");
  const header = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024)));
  const svg = /<svg[\s>]/i.test(header);
  const blob = new Blob([bytes], { type: svg ? "image/svg+xml" : "" });
  let bitmap: ImageBitmap | HTMLImageElement;
  let url: string | undefined;
  try { bitmap = await createImageBitmap(blob); }
  catch (error) {
    if (!svg) throw error;
    // Chromium's bitmap decoder may reject SVGs that its image element can render.
    url = URL.createObjectURL(blob);
    try {
      bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        const timer = setTimeout(() => { image.src = ""; reject(new Error("SVG decoding timed out")); }, 30000);
        image.onload = () => { clearTimeout(timer); resolve(image); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("SVG could not be decoded")); };
        image.src = url!;
      });
    } catch (svgError) { URL.revokeObjectURL(url); throw svgError; }
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap instanceof HTMLImageElement ? bitmap.naturalWidth : bitmap.width;
    canvas.height = bitmap instanceof HTMLImageElement ? bitmap.naturalHeight : bitmap.height;
    if (!canvas.width || !canvas.height) throw new Error("Image has no drawable dimensions");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG conversion is unavailable");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("PNG conversion failed")), "image/png"
    ));
    return png.arrayBuffer();
  } finally {
    if ("close" in bitmap) bitmap.close();
    if (url) URL.revokeObjectURL(url);
  }
}
