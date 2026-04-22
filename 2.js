const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;
const moment = require('moment');
const RSS_DATA = process.env.GRL || "";
const RSS_URLS = RSS_DATA.split(/[\n,]+/).map(url => url.trim()).filter(url => url.startsWith('http'));
async function parseRSS(url) {
    const feedId = url.slice(-5);
    try {
        const response = await axios.get(url, { 
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        const entries = result.feed.entry || [];
        console.log(`[OK] Feed ${feedId} | HTTP ${response.status} | Found: ${entries.length}`);
        return entries.map(entry => {
            const rawUrl = entry.link[0].$.href;
            const cleanUrl = new URL(rawUrl).searchParams.get('url') || rawUrl;
            return {
                title: entry.title[0]._.replace(/<\/?[^>]+(>|$)/g, ""),
                url: cleanUrl,
                time: entry.published[0]
            };
        });
    } catch (e) {
        const status = e.response ? e.response.status : 'NETWORK_ERROR';
        console.log(`[ERR] Feed ${feedId} | Status: ${status} | Msg: ${e.message}`);
        return [];
    }
}
(async () => {
    console.log("--------------------------------------------------");
    console.log(`Time: ${moment().format('YYYY-MM-DD HH:mm:ss')}`);
    console.log(`Detected URL count: ${RSS_URLS.length}`);
    if (RSS_URLS.length === 0) {
        console.log("No RSS links found. Please check GRL secret.");
        process.exit(0);
    }
    console.log("Starting concurrent fetch...");
    const startTime = Date.now();
    const results = await Promise.all(RSS_URLS.map(url => parseRSS(url)));
    const duration = (Date.now() - startTime) / 1000;
    const flatResults = results.flat();
    const uniqueResults = Array.from(new Map(flatResults.map(item => [item.url, item])).values());
    uniqueResults.sort((a, b) => moment(b.time).valueOf() - moment(a.time).valueOf());
    await fs.writeFile('/tmp/g.json', JSON.stringify(uniqueResults, null, 2));
    console.log("--------------------------------------------------");
    console.log(`Execution Time: ${duration}s`);
    console.log(`Total Scraped: ${flatResults.length}`);
    console.log(`Unique Items: ${uniqueResults.length}`);
    console.log("--------------------------------------------------");
})();
