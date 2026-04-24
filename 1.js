const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;
const TOKEN_NAMES = ["GT", "GT2", "GT3", "GT4", "GT5", "GT6", "GT7", "GT8", "GT9"];
const GITHUB_TOKENS = TOKEN_NAMES.map(name => process.env[name]).filter(t => t);
let tokenIndex = 0;
const SEARCH_KEYWORDS = process.env.KEY ? process.env.KEY.split(',') : [];
const NOW = moment();
const START_DATE = NOW.clone().subtract(360, 'minutes');
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
        const response = await axios.get(url, { headers: config.headers });
        return response.data;
    } catch (error) {
        const isRateLimit = error.response && (error.response.status === 403 || error.response.status === 429);
        if (isRateLimit && retries > 0) {
            console.warn(`[${config.tokenName}] Limit Hit. Switching token...`);
            const nextConfig = getNextConfig();
            if (nextConfig.tokenIdx === 0) await new Promise(res => setTimeout(res, 3000));
            return fetchWithRetry(url, nextConfig, type, retries - 1);
        } else if (retries > 0) {
            return fetchWithRetry(url, config, type, retries - 1);
        } else {
            return null; 
        }
    }
}
async function searchGitHubCode(query, page = 1) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&page=${page}&per_page=100`;
    return fetchWithRetry(url, getNextConfig(), "Search");
}
async function getFileLastCommit(owner, repo, path) {
    const sinceIso = START_DATE.toISOString();
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&since=${sinceIso}`;
    const data = await fetchWithRetry(url, getNextConfig(), "GetCommit");
    if (data && data.length > 0) {
        return {
            date: data[0].commit.committer.date,
            sha: data[0].sha
        };
    }
    return null; 
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
        while (page <= 10) {
            try {
                const data = await searchGitHubCode(keyword, page);
                if (!data || !data.items || data.items.length === 0) break;
                for (const item of data.items) {
                    if (item.html_url.includes('url_check.txt')) continue;
                    const [owner, repo] = item.repository.full_name.split('/');
                    try {
                        const commitInfo = await getFileLastCommit(owner, repo, item.path);
                        if (commitInfo) {
                            results.push({
                                key: `${item.repository.full_name}/${item.path}`,
                                keyword: keyword,
                                date: commitInfo.date,
                                url: `https://github.com/${item.repository.full_name}/blob/${commitInfo.sha}/${item.path}`
                            });
                        }
                    } catch (e) {}
                }
                if (data.items.length < 100) break;
                page++;
            } catch (error) { break; }
        }
    }
    const existingData = await readJSONFile();
    const updatedData = existingData.map(e => {
        if (e.key) return e;
        const m = e.url.match(/github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)/);
        return { ...e, key: m ? `${m[1]}/${m[2]}` : undefined };
    }).filter(e => e.key);
    results.forEach(result => {
        const idx = updatedData.findIndex(entry => entry.key === result.key);
        if (idx !== -1) {
            if (moment(result.date).isAfter(updatedData[idx].date)) {
                updatedData[idx].date = result.date;
                updatedData[idx].url = result.url;
            }
        } else {
            updatedData.push(result);
        }
    });
    const finalData = updatedData.filter(entry => moment(entry.date).isAfter(START_DATE));
    finalData.sort((a, b) => {
        const diff = moment(b.date).diff(moment(a.date));
        return diff !== 0 ? diff : a.key.localeCompare(b.key);
    });
    await writeJSONFile(finalData);
    console.log(`\n--- Process Completed ---`);
})();
