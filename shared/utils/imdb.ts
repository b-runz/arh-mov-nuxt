import dns from "node:dns";
import { fetchWithRetry } from "./fetchRetry";

dns.setDefaultResultOrder("ipv4first");

export interface ImdbData {
    rating: string;
    datePublished: string;
}

const MONTHS: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function formatOmdbDate(released?: string): string {
    if (!released || released === 'N/A') return '';
    const [day, monthStr, year] = released.split(' ');
    const month = MONTHS[monthStr];
    return year && month && day ? `${year}-${month}-${day.padStart(2, '0')}` : '';
}

export async function getRating(tt: string): Promise<ImdbData> {
    try {
        const apiKey = process.env.OMDB_API_KEY;
        if (!apiKey) {
            throw new Error('OMDB_API_KEY environment variable is not set');
        }

        const url = `https://omdbapi.com{encodeURIComponent(tt)}&apikey=${encodeURIComponent(apiKey)}`;
        const response = await fetchWithRetry(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'node-fetch'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as OmdbResponse;

        if (data.Response === 'False') {
            return { rating: '?', datePublished: '' };
        }

        return {
            rating: data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : '?',
            datePublished: formatOmdbDate(data.Released)
        };
    } catch (error) {
        const err = error as Error & { cause?: unknown };
        console.warn(`[imdb] rating lookup failed for ${tt}: ${err?.message ?? error}`, err?.cause ?? '');
        return { rating: '?', datePublished: '' };
    }
}

type OmdbResponse = {
    Released?: string;
    imdbRating?: string;
    Response: 'True' | 'False';
    Error?: string;
};
