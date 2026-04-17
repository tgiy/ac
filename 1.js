const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;


const TOKEN_NAMES = ["GT", "GT2", "GT3", "GT4", "GT5", "GT6"];
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


async function fetchWithRetry(url, config, retries = MAX_RETRIES) {
    try {

        console.log(`[Request] Using ${config.tokenName} -> ${url.substring(0, 60)}...`);
        
        const response = await axios.get(url, {
            headers: config.headers
        });
        return response.data;
    } catch (error) {
        const isRateLimit = error.response && error.response.status === 403 && 
                           (error.response.data.message.includes('rate limit') || 
                            error.response.headers['x-ratelimit-remaining'] === '0');

        if (isRateLimit && retries > 0) {
            console.warn(`[Limit] ${config.tokenName} exhausted. Switching token immediately...`);
            

            const nextConfig = getNextConfig();
            

            if (nextConfig.tokenIdx === 0) {
                console.log("[Wait] All tokens might be limited. Sleeping 10s before next rotation...");
                await new Promise(resolve => setTimeout(resolve, 10000));
            }


            return fetchWithRetry(url, nextConfig, retries - 1);
        } else if (retries > 0 && (!error.response || error.response.status !== 403)) {

            console.warn(`[Error] ${config.tokenName} failed. Retrying in 1s...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return fetchWithRetry(url, config, retries - 1);
        } else {
            throw error;
        }
    }
}

async function searchGitHubCode(query, page = 1) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&page=${page}&per_page=100`;
    return fetchWithRetry(url, getNextConfig());
}

async function getFileLastModifiedDate(owner, repo, path) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}`;
    const data = await fetchWithRetry(url, getNextConfig());
    if (data && data.length > 0) {
        const commit = data[0];
        return commit.commit.committer.date;
    }
    throw new Error('No commits found');
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
    if (GITHUB_TOKENS.length === 0) {
        console.error("No Tokens found.");
        return;
    }

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
                    } catch (e) {
                        console.error(`[Skip] ${item.html_url}: ${e.message}`);
                    }
                }
                page++;

                await new Promise(r => setTimeout(r, 500)); 
            } catch (error) {
                console.error(`[Fatal] Stopping keyword ${keyword}: ${error.message}`);
                break;
            }
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
    console.log(`\n--- Finished ---`);
    console.log(`Total new items found: ${results.length}`);
})();
