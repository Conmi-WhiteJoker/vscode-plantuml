const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const JAR_PATH = path.join(__dirname, '..', 'plantuml.jar');
const GITHUB_API = 'https://api.github.com/repos/plantuml/plantuml/releases/latest';

/**
 * Get proxy agent from environment variables
 */
function getProxyAgent() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (!proxyUrl) return null;
    try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
        console.warn('[download-jar] https-proxy-agent not installed, skipping proxy');
        return null;
    }
}

/**
 * Fetch JSON from a URL with optional proxy support
 */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const agent = getProxyAgent();
        const opts = { headers: { 'User-Agent': 'vscode-plantuml-build-script' } };
        if (agent) opts.agent = agent;
        https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                return fetchJson(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Failed to parse JSON response')); }
            });
        }).on('error', reject);
    });
}

/**
 * Download a file with optional proxy support and redirect following
 */
function downloadFile(url, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const agent = getProxyAgent();
        const opts = { headers: { 'User-Agent': 'vscode-plantuml-build-script' } };
        if (agent) opts.agent = agent;
        https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
                return downloadFile(res.headers.location, destPath, maxRedirects - 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Get the version of the existing PlantUML jar
 */
function getLocalJarVersion() {
    if (!fs.existsSync(JAR_PATH)) return null;
    try {
        const output = execSync(`java -jar "${JAR_PATH}" -version 2>&1`, { encoding: 'utf8', timeout: 30000 });
        const match = output.match(/PlantUML version (\S+)/);
        return match ? match[1] : null;
    } catch (e) {
        console.warn('[download-jar] Failed to get local jar version:', e.message);
        return null;
    }
}

/**
 * Compare two version strings (e.g., "1.2026.6" vs "1.2026.7")
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    const partsA = a.replace(/^v/, '').split('.');
    const partsB = b.replace(/^v/, '').split('.');
    const maxLen = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLen; i++) {
        const numA = parseInt(partsA[i] || '0', 10);
        const numB = parseInt(partsB[i] || '0', 10);
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

async function main() {
    console.log('[download-jar] Checking for latest PlantUML release...');

    // Get local version
    const localVersion = getLocalJarVersion();
    if (localVersion) {
        console.log(`[download-jar] Local jar version: ${localVersion}`);
    } else {
        console.log('[download-jar] No local jar found, will download');
    }

    // Get latest release info from GitHub
    let release;
    try {
        release = await fetchJson(GITHUB_API);
    } catch (e) {
        console.error(`[download-jar] Failed to fetch latest release info: ${e.message}`);
        console.error('[download-jar] Skipping jar download. Using existing jar if available.');
        return;
    }

    const latestTag = release.tag_name; // e.g., "v1.2026.6"
    const latestVersion = latestTag.replace(/^v/, ''); // e.g., "1.2026.6"
    console.log(`[download-jar] Latest release: ${latestTag} (${release.name || latestVersion})`);

    // Compare versions
    if (localVersion && compareVersions(localVersion, latestVersion) >= 0) {
        console.log('[download-jar] Local jar is up to date, skipping download');
        return;
    }

    // Build download URL
    const downloadUrl = `https://github.com/plantuml/plantuml/releases/download/${latestTag}/plantuml-${latestVersion}.jar`;
    console.log(`[download-jar] Downloading from: ${downloadUrl}`);
    console.log('[download-jar] This may take a moment...');

    // Download to temp file first, then rename
    const tmpPath = JAR_PATH + '.tmp';
    try {
        await downloadFile(downloadUrl, tmpPath);
        fs.renameSync(tmpPath, JAR_PATH);
        console.log(`[download-jar] Successfully downloaded PlantUML jar v${latestVersion}`);

        // Verify
        const newVersion = getLocalJarVersion();
        if (newVersion) {
            console.log(`[download-jar] Verified: PlantUML version ${newVersion}`);
        }
    } catch (e) {
        console.error(`[download-jar] Download failed: ${e.message}`);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        if (!fs.existsSync(JAR_PATH)) {
            console.error('[download-jar] ERROR: No plantuml.jar available! Build may fail.');
        } else {
            console.warn('[download-jar] WARNING: Using existing (possibly outdated) jar');
        }
    }
}

main();
