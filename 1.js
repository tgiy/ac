const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;
const TOKEN_NAMES = ["GT", "GT2", "GT3", "GT4", "GT5", "GT6", "GT7", "GT8", "GT9"];
const GITHUB_TOKENS = TOKEN_NAMES.map(name => process.env[name]).filter(t => t);
let tokenIndex = 0;
const SEARCH_KEYWORDS = process.env.KEY ? process.env.KEY.split(',') : [];
const START_DATE = moment().subtract(10, 'days');
const OUTPUT_FILE = '/tmp/s.json'; 
const MAX_RETRIES = 6;
function getNextConfig() {
    const token = GITHUB_TOKENS[tokenIndex];
    const currentTokenName = TOKEN_NAMES[tokenIndex];
    const config = {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json'
        },
        tokenName: currentTokenName,
        tokenIdx: tokenIndex
    };
    tokenIndex = (tokenIndex + 1) % GITHUB_TOKENS.length;
    return config;
}
async function fetchWithRetry(url, config, type = "Request", retries = MAX_RETRIES) {
    try {
        console.log(`[${config.tokenName}] Performing ${type}...`);
        const response = await axios.get(url, { headers: config.headers });
        return response.data;
    } catch (error) {
        const isRateLimit = error.response && error.response.status === 403;
        if (isRateLimit && retries > 0) {
            console.warn(`[${config.tokenName}] Limit Hit. Switching immediately...`);
            const nextConfig = getNextConfig();
            if (nextConfig.tokenIdx === 0) {
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
            return fetchWithRetry(url, nextConfig, type, retries - 1);
        } else if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return fetchWithRetry(url, config, type, retries - 1);
        } else {
            throw error;
        }
    }
}
async function searchGitHubCode(query, page = 1) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&page=${page}&per_page=100`;
    return fetchWithRetry(url, getNextConfig(), "Search");
}
async function getFileLastModifiedDate(owner, repo, path) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}`;
    const data = await fetchWithRetry(url, getNextConfig(), "GetDate");
    if (data && data.length > 0) {
        return data[0].commit.committer.date;
    }
    throw new Error('No commit');
}
async function readJSONFile() {
    try {
        const data = await fs.readFile(OUTPUT_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) { return []; }
}
async function writeJSONFile(data) {
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
}
(async () => {
    let results = [];
    if (GITHUB_TOKENS.length === 0) return;
    for (const keyword of SEARCH_KEYWORDS) {
        let page = 1;
        while (true) {
            try {
                const data = await searchGitHubCode(keyword, page);
                if (!data || !data.items || data.items.length === 0) break;
                for (const item of data.items) {
                    if (item.html_url.includes('url_check.txt')) continue;
                    const [owner, repo] = item.repository.full_name.split('/');
                    try {
                        const lastModifiedDate = await getFileLastModifiedDate(owner, repo, item.path);
                        const fileDate = moment(lastModifiedDate);
                        if (fileDate.isAfter(START_DATE)) {
                            results.push({
                                keyword: keyword,
                                date: fileDate.toISOString(),
                                url: item.html_url
                            });
                        }
                    } catch (e) {}
                }
                page++;
                await new Promise(r => setTimeout(r, 500)); 
            } catch (error) { break; }
        }
    }
    const existingData = await readJSONFile();
    const updatedData = [...existingData];
    results.forEach(result => {
        const idx = updatedData.findIndex(entry => entry.url === result.url);
        if (idx !== -1) {
            if (moment(updatedData[idx].date).isBefore(result.date)) updatedData[idx] = result;
        } else {
            updatedData.push(result);
        }
    });
    updatedData.sort((a, b) => moment(b.date).diff(moment(a.date)));
    await writeJSONFile(updatedData);
    console.log(`\n--- Process Completed ---`);
    console.log(`Updated items: ${results.length}`);
})();
