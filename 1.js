const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;

const GITHUB_TOKEN = process.env.GT;
const SEARCH_KEYWORDS = process.env.KEY;
console.log('SEARCH_KEYWORDS:', SEARCH_KEYWORDS);
const START_DATE = moment('2024-09-01');
const OUTPUT_FILE = '/tmp/s.json'; 
const MAX_RETRIES = 5;

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
    const config = {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
        }
    };
    return fetchWithRetry(url, config);
}

async function getFileLastModifiedDate(owner, repo, path) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}`;
    const config = {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json'
        }
    };
    const data = await fetchWithRetry(url, config);
    const commit = data[0];
    return commit.commit.committer.date;
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
    for (const keyword of SEARCH_KEYWORDS) {
        let page = 1;
        const query = keyword;
        while (true) {
            try {
                const data = await searchGitHubCode(query, page);
                if (data.items.length === 0) break;
                for (const item of data.items) {
                    const fileUrl = item.html_url;
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
                        console.error(`Failed to get last modified date for ${fileUrl}:`, error.message);
                    }
                }
                page++;
            } catch (error) {
                if (error.response && error.response.status === 403 && error.response.data.message.includes('rate limit')) {
                    console.error('API rate limit exceeded during code search. Exiting.');
                    return;
                } else {
                    throw error;
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
    console.log('Filtered file URLs have been saved to', OUTPUT_FILE);
})();
