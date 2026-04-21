const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;
const moment = require('moment');
const RSS_DATA = process.env.GRL || "";
const RSS_URLS = RSS_DATA.split(/[\n,]+/).map(url => url.trim()).filter(url => url.startsWith('http'));
async function parseRSS(url) {
    try {
        const { data } = await axios.get(url, { timeout: 15000 });
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(data);
        const entries = result.feed.entry || [];
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
        return [];
    }
}
(async () => {
    if (RSS_URLS.length === 0) {
        console.log("No RSS links found in secrets.");
        process.exit(0);
    }
    console.log(`Starting fetch for ${RSS_URLS.length} RSS feeds...`);
    const results = await Promise.all(RSS_URLS.map(url => parseRSS(url)));
    const flatResults = results.flat();
    const uniqueResults = Array.from(new Map(flatResults.map(item => [item.url, item])).values());
    uniqueResults.sort((a, b) => moment(b.time).valueOf() - moment(a.time).valueOf());
    await fs.writeFile('/tmp/g.json', JSON.stringify(uniqueResults, null, 2));
    console.log(`Done. Found ${uniqueResults.length} unique items.`);
})();
