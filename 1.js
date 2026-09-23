const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;

const TOKEN_NAMES = ["GT", "GT2", "GT3", "GT4", "GT5", "GT6", "GT7", "GT8", "GT9", "GT10"];
const GITHUB_TOKENS = TOKEN_NAMES.map(name => process.env[name]).filter(Boolean);

const SEARCH_KEYWORDS = process.env.KEY ? process.env.KEY.split(',').map(k => k.trim()).filter(Boolean) : [];
const SEARCH_KEYWORDS_O = process.env.KEY_O ? process.env.KEY_O.split(',').map(k => k.trim()).filter(Boolean) : [];

const URL_O = process.env.URL_O;
const MODEL_O = process.env.MODEL_O;
const MSG_O = process.env.MSG_O || "hi";

const NOW = moment();
const START_DATE = NOW.clone().subtract(360, 'minutes');
const OUTPUT_FILE_S = '/tmp/s.json';
const OUTPUT_FILE_O = '/tmp/o.json';
const MAX_RETRIES = 6;

let tokenIndex = 0;

function getNextConfig() {
    if (GITHUB_TOKENS.length === 0) {
        throw new Error("No GitHub tokens provided.");
    }
    const token = GITHUB_TOKENS[tokenIndex];
    const currentTokenName = TOKEN_NAMES[tokenIndex];
    const config = {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Scraper-Bot'
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
            console.warn(`[${config.tokenName}] Rate limit reached. Switching token...`);
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
    if (Array.isArray(data) && data.length > 0) {
        return {
            date: data[0].commit.committer.date,
            sha: data[0].sha
        };
    }
    return null;
}

async function getRawFileContent(owner, repo, sha, path) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`;
    try {
        const config = getNextConfig();
        const response = await axios.get(url, { 
            headers: config.headers,
            responseType: 'text'
        });
        return response.data;
    } catch (e) {
        return null;
    }
}

async function validateKey(apiKey) {
    if (!URL_O || !MODEL_O) return false;
    try {
        const response = await axios.post(
            URL_O,
            {
                model: MODEL_O,
                messages: [{ role: "user", content: MSG_O }]
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                timeout: 10000
            }
        );
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readJSONFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) { 
        return []; 
    }
}

async function writeJSONFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function processKeywords(keywords, isKeyO = false) {
    const results = [];

    for (const keyword of keywords) {
        let page = 1;
        while (page <= 10) {
            try {
                const data = await searchGitHubCode(keyword, page);
                if (!data || !data.items || data.items.length === 0) break;

                for (const item of data.items) {
                    if (item.html_url && item.html_url.includes('url_check.txt')) continue;

                    const [owner, repo] = item.repository.full_name.split('/');
                    try {
                        const commitInfo = await getFileLastCommit(owner, repo, item.path);
                        if (!commitInfo) continue;

                        const repoFullName = item.repository.full_name;
                        const itemPath = item.path;

                        if (isKeyO) {
                            const rawContent = await getRawFileContent(owner, repo, commitInfo.sha, itemPath);
                            if (rawContent && typeof rawContent === 'string') {

                                const escapedKeyword = escapeRegExp(keyword);
                                const regex = new RegExp(`(?<=^|[^a-zA-Z0-9_-])${escapedKeyword}[a-zA-Z0-9_-]{100,200}(?![a-zA-Z0-9_-])`, 'g');
                                const matches = [...new Set(rawContent.match(regex) || [])];

                                for (const apiKey of matches) {
                                    const isValid = await validateKey(apiKey);
                                    if (isValid) {
                                        results.push({
                                            key: `${repoFullName}/${itemPath}`,
                                            apiKey: apiKey,
                                            keyword: keyword,
                                            date: commitInfo.date,
                                            url: `https://github.com/${repoFullName}/blob/${commitInfo.sha}/${itemPath}`
                                        });
                                    }
                                }
                            }
                        } else {
                            results.push({
                                key: `${repoFullName}/${itemPath}`,
                                keyword: keyword,
                                date: commitInfo.date,
                                url: `https://github.com/${repoFullName}/blob/${commitInfo.sha}/${itemPath}`
                            });
                        }
                    } catch (e) {}
                }

                if (data.items.length < 100) break;
                page++;
            } catch (error) {
                break;
            }
        }
    }
    return results;
}


async function mergeAndSave(newResults, outputFile, isKeyO = false) {
    const existingData = await readJSONFile(outputFile);

    const updatedData = existingData.map(e => {
        if (e.key) return e;
        const m = e.url ? e.url.match(/github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)/) : null;
        return { ...e, key: m ? `${m[1]}/${m[2]}` : undefined };
    }).filter(e => e.key);

    newResults.forEach(result => {
        const idx = updatedData.findIndex(entry => 
            isKeyO 
                ? (entry.apiKey === result.apiKey && entry.key === result.key) 
                : entry.key === result.key
        );

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

    await writeJSONFile(outputFile, finalData);
}

(async () => {
    if (GITHUB_TOKENS.length === 0) {
        console.error("No GitHub tokens available.");
        return;
    }

    if (SEARCH_KEYWORDS.length > 0) {
        const resultsS = await processKeywords(SEARCH_KEYWORDS, false);
        await mergeAndSave(resultsS, OUTPUT_FILE_S, false);
    } else {
        await writeJSONFile(OUTPUT_FILE_S, []);
    }

    if (SEARCH_KEYWORDS_O.length > 0) {
        const resultsO = await processKeywords(SEARCH_KEYWORDS_O, true);
        await mergeAndSave(resultsO, OUTPUT_FILE_O, true);
    } else {
        await writeJSONFile(OUTPUT_FILE_O, []);
    }

    console.log(`\n--- Process Completed ---`);
})();
