import sharp from 'sharp';

export interface ColorStats {
    totalPixels: number;
    uniqueColors: number;
    dominantColorCount: number;
}

// kino.dk's placeholder graphic (a flat card with black text explaining
// there's no poster) measures ~508 unique colors with ~77% of pixels being
// one flat background color. Real posters -- even minimalist ones -- come in
// far above both thresholds (measured 131k-283k unique colors, <2% dominant),
// so requiring both conditions leaves a wide safety margin against
// false-flagging a real poster with either a big flat background or a
// limited palette alone.
const DOMINANT_COLOR_RATIO_THRESHOLD = 0.5;
const UNIQUE_COLOR_THRESHOLD = 5000;

export function isPlaceholderStats(stats: ColorStats): boolean {
    if (stats.totalPixels === 0) return false;
    const dominantRatio = stats.dominantColorCount / stats.totalPixels;
    return dominantRatio >= DOMINANT_COLOR_RATIO_THRESHOLD && stats.uniqueColors < UNIQUE_COLOR_THRESHOLD;
}

export async function getColorStatsFromImageBuffer(buffer: Buffer): Promise<ColorStats> {
    const { data, info } = await sharp(buffer)
        .resize(100, 150, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });

    return computeColorStats(data, info.channels);
}

// Request a small, format-pinned thumbnail via Sanity's image API params
// instead of the full-size derivative used as the actual poster -- decoding a
// 100px-wide jpg is far cheaper than the 800-1500px original, and pinning the
// format means we only need to decode jpg regardless of what the feed's URL
// requested (some posters come through as .webp).
function buildProbeUrl(url: string): string {
    const probeUrl = new URL(url);
    probeUrl.searchParams.set('w', '100');
    probeUrl.searchParams.set('fm', 'jpg');
    return probeUrl.toString();
}

export async function isPlaceholderPosterUrl(url: string): Promise<boolean> {
    try {
        const response = await fetch(buildProbeUrl(url));
        if (!response.ok) return false;
        const buffer = Buffer.from(await response.arrayBuffer());
        const stats = await getColorStatsFromImageBuffer(buffer);
        return isPlaceholderStats(stats);
    } catch (error) {
        console.warn(`[posterPlaceholder] failed to check "${url}" (treating as a real poster): ${(error as Error)?.message ?? error}`);
        return false;
    }
}

export function computeColorStats(pixels: Buffer, channels: number): ColorStats {
    const counts = new Map<string, number>();
    let totalPixels = 0;

    for (let i = 0; i + channels <= pixels.length; i += channels) {
        const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        totalPixels++;
    }

    let dominantColorCount = 0;
    for (const count of counts.values()) {
        if (count > dominantColorCount) dominantColorCount = count;
    }

    return { totalPixels, uniqueColors: counts.size, dominantColorCount };
}
