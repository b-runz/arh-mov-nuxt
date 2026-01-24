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
    console.log('Fetching rating for:', tt);
    // Implement rate limiting
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;
    
    if (timeSinceLastCall < RATE_LIMIT_DELAY) {
        const waitTime = RATE_LIMIT_DELAY - timeSinceLastCall;
        await sleep(waitTime);
    }
    
    lastCallTime = Date.now();
    const imdbUrl = `https://m.imdb.com/title/${tt}/`;

    try {
        const html = await makeHttpsRequest(imdbUrl);
        
        const $ = cheerio.load(html);
        const rating = $('div[data-testid="hero-rating-bar__aggregate-rating__score"]:first span:nth-child(1)').text();
        
        console.log('Extracted rating:', rating.trim() || 'Not found');
        return rating.trim() || '?';
    } catch (error: any) {
        // Handle 404 errors specifically
        if (error?.status === 404 || error?.statusCode === 404) {
            console.warn(`IMDB page not found for ${tt} (404)`);
            return '?';
        }
        
        console.warn(`Failed to fetch IMDB rating for ${tt}:`, error.message);
        return '?';
    }

// Helper function to make HTTPS requests with proper headers
async function makeHttpsRequest(url: string): Promise<string> {
    try {
        const response = await $fetch<string>(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            // Ensure we get the raw response as text
            parseResponse: (txt) => txt,
            // Handle different response types
            responseType: 'text'
        });
        
        return response;
    } catch (error: any) {
        // $fetch throws errors for HTTP error statuses
        if (error?.status || error?.statusCode) {
            throw new Error(`HTTP ${error.status || error.statusCode}: ${error.statusText || error.message}`);
        }
        throw error;
    }
}


    // return "?"
}