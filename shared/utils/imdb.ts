import * as cheerio from 'cheerio';

export interface RatingData {
    rating: string;
}

// Track the last call time to implement rate limiting
let lastCallTime = 0;
const RATE_LIMIT_DELAY = 500; // 500ms delay between calls

// Helper function to wait for a specified amount of time
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function getRating(tt: string): Promise<string> {
    // Implement rate limiting
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;
    
    if (timeSinceLastCall < RATE_LIMIT_DELAY) {
        const waitTime = RATE_LIMIT_DELAY - timeSinceLastCall;
        await sleep(waitTime);
    }
    
    lastCallTime = Date.now();
    const imdbUrl = `https://www.imdb.com/title/${tt}/`;

    try {
        const html = await $fetch<string>(imdbUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
            }
        });
        
        const $ = cheerio.load(html);
        const rating = $('div[data-testid="hero-rating-bar__aggregate-rating__score"]:first span:nth-child(1)').text();

        return rating.trim() || '?';
    } catch (error: any) {
        // Handle 404 errors specifically
        if (error?.status === 404 || error?.statusCode === 404) {
            console.warn(`IMDB page not found for ${tt} (404)`);
            return '?';
        }
        
        console.warn(`Failed to fetch IMDB rating for ${tt}:`, error);
        return '?';
    }


    // return "?"
}