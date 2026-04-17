const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;
const GITHUB_TOKENS = [
    process.env.GT, 
    process.env.GT2, 
    process.env.GT3, 
    process.env.GT4, 
    process.env.GT5, 
    process.env.GT6
].filter(t => t);

let tokenIndex = 0;

const SEARCH_KEYWORDS = process.env.KEY ? process.env.KEY.split(',') : [];
const START_DATE = moment().subtract(10, 'days');
const OUTPUT_FILE = '/tmp/s.json'; 
const MAX_RETRIES = 6;


function getNextConfig() {
    const token = GITHUB_TOKENS[tokenIndex];
    tokenIndex = (tokenIndex + 1) % GITHUB_TOKENS.length;
    return {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json'
        }
    };
}

async function fetchWithRetry(url, config, retries = MAX_RETRIES) {
    try {
        const response = await axios.get(url, config);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 403 && error.response.data.message.includes('rate limit')) {
            const retryAfter = parseInt(error.response.headers['retry-after'], 10) || 60;
            console.warn(`API rate limit exceeded. Waiting ${retryAfter} seconds before retrying...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            if (retries > 0) {

                return fetchWithRetry(url, config, retries - 1);
            } else {
                throw error;
            }
        } else if (retries > 0) {
            console.warn(`Request failed. Retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
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
    throw new Error('No commits found for this file.');
}

async function readJSONFile() {
    try {
        const data = await fs.readFile(OUTPUT_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function writeJSONFile(data) {
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

(async () => {
    let results = [];
    if (GITHUB_TOKENS.length === 0) {
        console.error("No GitHub Tokens found in environment variables.");
        return;
    }

    for (const keyword of SEARCH_KEYWORDS) {
        let page = 1;
        const query = keyword;
        while (true) {
            try {
                const data = await searchGitHubCode(query, page);
                if (!data.items || data.items.length === 0) break;

                for (const item of data.items) {
                    const fileUrl = item.html_url;
                    if (fileUrl.includes('url_check.txt')) continue;

                    const filePath = item.path;
                    const [owner, repo] = item.repository.full_name.split('/');

                    try {
                        const lastModifiedDate = await getFileLastModifiedDate(owner, repo, filePath);
                        const fileDate = moment(lastModifiedDate);
                        if (fileDate.isAfter(START_DATE)) {
                            results.push({
                                keyword: keyword,
                                date: fileDate.toISOString(),
                                url: fileUrl
                            });
                        }
                    } catch (error) {
                        console.error(`Failed to get date for ${fileUrl}:`, error.message);
                    }
                }
                page++;

                await new Promise(r => setTimeout(r, 1000)); 
            } catch (error) {
                if (error.response && error.response.status === 403) {
                    console.error('API rate limit hit during search. Current tokens might be exhausted.');
                    break;
                } else {
                    console.error('Search error:', error.message);
                    break;
                }
            }
        }
    }

    const existingData = await readJSONFile();
    const updatedData = [...existingData];
    results.forEach(result => {
        const existingEntryIndex = updatedData.findIndex(entry => entry.url === result.url);
        if (existingEntryIndex !== -1) {
            if (moment(updatedData[existingEntryIndex].date).isBefore(result.date)) {
                updatedData[existingEntryIndex] = result;
            }
        } else {
            updatedData.push(result);
        }
    });

    updatedData.sort((a, b) => moment(b.date).diff(moment(a.date)));
    await writeJSONFile(updatedData);
    console.log(`Job finished. Processed ${results.length} new/updated items.`);
})();
