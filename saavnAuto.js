// saavnAuto.js - Complete Saavn to Telegram Automation with Bot Commands

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

// Import from telegram.js
const { bot, Saavan, channelId } = require('./telegram');

// ============ Configuration ============
const API_BASE = 'https://saavn.sumit.co';
const DOWNLOAD_DIR = './downloads';
const TEMP_DIR = './temp';
const MAX_SIZE_MB = 50;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const DELAY_BETWEEN_SONGS = 500;
const PROGRESS_UPDATE_INTERVAL = 3; // Update progress every N songs

// Create directories
[DOWNLOAD_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Track active downloads to prevent duplicates
const activeDownloads = new Map();

// ============ Helper Functions ============
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHTMLEntities(text) {
    if (!text) return '';
    const entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
        '&#039;': "'", '&#39;': "'", '&nbsp;': ' '
    };
    return text.replace(/&[#\w]+;/g, entity => entities[entity] || entity);
}

function escapeFFmpegMetadata(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "'").replace(/[\n\r]/g, ' ');
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function cleanupFiles(...files) {
    files.forEach(file => {
        try {
            if (file && fs.existsSync(file)) fs.unlinkSync(file);
        } catch (err) { }
    });
}

function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function progressBar(current, total, length = 20) {
    const percent = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * length);
    const empty = length - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

// ============ Download File ============
function downloadFile(url, filepath, maxSize = null) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        const protocol = url.startsWith('https') ? https : http;
        let downloadedBytes = 0;

        const request = protocol.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                cleanupFiles(filepath);
                downloadFile(response.headers.location, filepath, maxSize).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                file.close();
                cleanupFiles(filepath);
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const contentLength = parseInt(response.headers['content-length'], 10);
            if (maxSize && contentLength && contentLength > maxSize) {
                file.close();
                cleanupFiles(filepath);
                reject(new Error(`File too large: ${(contentLength / 1024 / 1024).toFixed(2)} MB`));
                return;
            }

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (maxSize && downloadedBytes > maxSize) {
                    request.destroy();
                    file.close();
                    cleanupFiles(filepath);
                    reject(new Error(`Exceeded size limit`));
                }
            });

            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', (err) => { file.close(); cleanupFiles(filepath); reject(err); });
        });

        request.on('error', (err) => { file.close(); cleanupFiles(filepath); reject(err); });
        request.setTimeout(60000, () => { request.destroy(); file.close(); cleanupFiles(filepath); reject(new Error('Timeout')); });
    });
}

// ============ Update Progress Message ============
async function updateProgressMessage(chatId, messageId, progressData) {
    const { 
        type, name, current, total, 
        currentSong, stats, status 
    } = progressData;

    const typeEmoji = type === 'artist' ? '🎤' : '📋';
    const typeLabel = type === 'artist' ? 'Artist' : 'Playlist';

    let text = `${typeEmoji} *${typeLabel}:* ${escapeMarkdown(name)}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `📊 *Progress:* ${current}/${total}\n`;
    text += `${progressBar(current, total)}\n\n`;

    if (currentSong) {
        text += `🎵 *Current:* ${escapeMarkdown(currentSong)}\n`;
        text += `📍 *Status:* ${status}\n\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `✅ Success: ${stats.success}\n`;
    text += `⏭️ Skipped: ${stats.skipped}\n`;
    text += `❌ Failed: ${stats.failed}\n`;

    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'MarkdownV2'
        });
    } catch (err) {
        // Ignore "message not modified" errors
        if (!err.message.includes('message is not modified')) {
            console.error('Progress update error:', err.message);
        }
    }
}

// ============ Download & Process Single Song ============
async function downloadAndSendSong(songId, progressCallback = null) {
    const tempAudioPath = path.join(TEMP_DIR, `${songId}_temp.mp4`);
    const tempThumbPath = path.join(TEMP_DIR, `${songId}_thumb.jpg`);
    let filepath = null;

    try {
        // Check if already in DB
        const exists = await Saavan.findOne({ songId });
        if (exists) {
            if (progressCallback) progressCallback('Already exists, skipped');
            return { success: true, skipped: true, reason: 'exists' };
        }

        // Get song info
        if (progressCallback) progressCallback('Fetching info...');

        const response = await fetch(`${API_BASE}/api/songs/${songId}`);
        const data = await response.json();

        if (!data?.success || !data?.data?.[0]) {
            throw new Error('Song not found');
        }

        const song = data.data[0];
        const title = decodeHTMLEntities(song.name) || 'Unknown';
        const artists = song.artists?.primary?.map(a => a.name).join(', ') || 'Unknown';
        const album = decodeHTMLEntities(song.album?.name) || 'Unknown';
        const duration = song.duration || 0;
        const year = song.year || '';
        const language = song.language || '';
        const url = song.url || '';

        const thumbnail = song.image?.[2]?.url || song.image?.[1]?.url || null;
        const downloadUrl = song.downloadUrl?.[4]?.url || song.downloadUrl?.[3]?.url || song.downloadUrl?.[2]?.url;

        if (!downloadUrl) throw new Error('No download URL');

        // Skip if duration > 15 min
        if (duration > 900) {
            if (progressCallback) progressCallback('Too long, skipped');
            return { success: false, skipped: true, reason: 'too_long' };
        }

        // Download audio
        if (progressCallback) progressCallback('Downloading...');
        await downloadFile(downloadUrl, tempAudioPath, MAX_SIZE_BYTES);

        // Download thumbnail
        let hasThumb = false;
        if (thumbnail) {
            try {
                await downloadFile(thumbnail, tempThumbPath);
                hasThumb = fs.existsSync(tempThumbPath);
            } catch (e) { }
        }

        // Prepare output file
        const safeTitle = title.replace(/[<>:"$@/\\|?*]/g, '').trim().substring(0, 100);
        const safeArtist = artists.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 50);
        const filename = `${safeTitle} - ${safeArtist}.mp3`;
        filepath = path.join(DOWNLOAD_DIR, filename);

        // FFmpeg conversion
        if (progressCallback) progressCallback('Converting...');

        const meta = {
            title: escapeFFmpegMetadata(title),
            artist: escapeFFmpegMetadata(artists),
            album: escapeFFmpegMetadata(album),
            year: escapeFFmpegMetadata(year)
        };

        let ffmpegCmd = hasThumb
            ? `ffmpeg -y -i "${tempAudioPath}" -i "${tempThumbPath}" -map 0:a -map 1:0 -c:a libmp3lame -b:a 320k -c:v mjpeg -id3v2_version 3 -metadata:s:v title="Album cover" -metadata title="${meta.title}" -metadata artist="${meta.artist}" -metadata album="${meta.album}" -metadata date="${meta.year}" -metadata genre="${language}" "${filepath}"`
            : `ffmpeg -y -i "${tempAudioPath}" -c:a libmp3lame -b:a 320k -id3v2_version 3 -metadata title="${meta.title}" -metadata artist="${meta.artist}" -metadata album="${meta.album}" -metadata date="${meta.year}" -metadata genre="${language}" "${filepath}"`;

        await execPromise(ffmpegCmd);

        if (!fs.existsSync(filepath)) throw new Error('Conversion failed');

        const fileSize = fs.statSync(filepath).size;
        const fileSizeMB = fileSize / 1024 / 1024;

        if (fileSizeMB > MAX_SIZE_MB) {
            cleanupFiles(tempAudioPath, tempThumbPath, filepath);
            if (progressCallback) progressCallback('Too large, skipped');
            return { success: false, skipped: true, reason: 'too_large' };
        }

        // Send to Telegram
        if (progressCallback) progressCallback('Uploading...');

        const caption = `🎵 ${title}\n👤 ${artists}\n💿 ${album}\n📅 ${year || 'N/A'}`;

        const sent = await bot.sendAudio(channelId, filepath, {
            caption,
            title,
            performer: artists,
            duration
        });

        // Save to DB
        await Saavan.create({
            songId,
            title,
            artist: artists,
            messageId: sent.message_id,
            duration,
            saavnUrl: url,
            fileSize
        });

        // Cleanup
        cleanupFiles(tempAudioPath, tempThumbPath, filepath);

        if (progressCallback) progressCallback('✅ Done');
        return { success: true, skipped: false, title };

    } catch (err) {
        cleanupFiles(tempAudioPath, tempThumbPath, filepath);
        if (progressCallback) progressCallback(`❌ ${err.message}`);
        return { success: false, error: err.message };
    }
}

// ============ Fetch Artist Info ============
async function fetchArtistInfo(artistId) {
    try {
        const res = await fetch(`${API_BASE}/api/artists/${artistId}`);
        const data = await res.json();
        if (data.success && data.data) {
            return {
                name: data.data.name || 'Unknown Artist',
                image: data.data.image?.[2]?.url || null,
                followerCount: data.data.followerCount || 0
            };
        }
    } catch (e) { }
    return { name: 'Unknown Artist', image: null, followerCount: 0 };
}

// ============ Fetch Playlist Info ============
async function fetchPlaylistInfo(playlistId) {
    try {
        const res = await fetch(`${API_BASE}/api/playlists?id=${playlistId}`);
        const data = await res.json();
        if (data.success && data.data) {
            return {
                name: data.data.name || 'Unknown Playlist',
                image: data.data.image?.[2]?.url || null,
                songCount: data.data.songCount || 0
            };
        }
    } catch (e) { }
    return { name: 'Unknown Playlist', image: null, songCount: 0 };
}

// ============ Fetch All Artist Songs ============
async function fetchAllArtistSongs(artistId) {
    const allSongs = [];
    const seenIds = new Set();
    let page = 0;

    while (true) {
        try {
            const res = await fetch(`${API_BASE}/api/artists/${artistId}/songs?page=${page}`);
            const data = await res.json();

            if (!data.success) break;

            const songs = data.data?.songs || [];
            if (songs.length === 0) break;

            for (const song of songs) {
                if (!seenIds.has(song.id)) {
                    seenIds.add(song.id);
                    allSongs.push(song);
                }
            }

            page++;
            if (page > 500) break;

        } catch (err) {
            break;
        }
    }

    return allSongs;
}

// ============ Fetch All Playlist Songs ============
async function fetchAllPlaylistSongs(playlistId) {
    const allSongs = [];
    const seenIds = new Set();
    let page = 0;

    while (true) {
        try {
            const res = await fetch(`${API_BASE}/api/playlists?id=${playlistId}&page=${page}&limit=100`);
            const data = await res.json();

            if (!data.success) break;

            const songs = data.data?.songs || [];
            if (songs.length === 0) break;

            for (const song of songs) {
                if (!seenIds.has(song.id)) {
                    seenIds.add(song.id);
                    allSongs.push(song);
                }
            }

            if (songs.length < 100) break;
            page++;
            if (page > 100) break;

        } catch (err) {
            break;
        }
    }

    return allSongs;
}

// ============ Main Download Function with Progress ============
async function downloadWithProgress(chatId, type, id) {
    const downloadKey = `${type}_${id}`;

    // Check if already downloading
    if (activeDownloads.has(downloadKey)) {
        await bot.sendMessage(chatId, `⚠️ This ${type} is already being downloaded!`);
        return;
    }

    activeDownloads.set(downloadKey, true);

    try {
        // Get info and songs
        let info, songs;

        if (type === 'artist') {
            info = await fetchArtistInfo(id);
            songs = await fetchAllArtistSongs(id);
        } else {
            info = await fetchPlaylistInfo(id);
            songs = await fetchAllPlaylistSongs(id);
        }

        if (songs.length === 0) {
            await bot.sendMessage(chatId, `❌ No songs found for this ${type}!`);
            activeDownloads.delete(downloadKey);
            return;
        }

        // Send initial progress message
        const typeEmoji = type === 'artist' ? '🎤' : '📋';
        const initialText = `${typeEmoji} *${type === 'artist' ? 'Artist' : 'Playlist'}:* ${escapeMarkdown(info.name)}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📊 *Total Songs:* ${songs.length}\n` +
            `⏳ *Status:* Starting download\\.\\.\\.\n\n` +
            `${progressBar(0, songs.length)}`;

        const progressMsg = await bot.sendMessage(chatId, initialText, { parse_mode: 'MarkdownV2' });
        const messageId = progressMsg.message_id;

        // Process songs
        const stats = { success: 0, skipped: 0, failed: 0 };
        let lastUpdateTime = 0;

        for (let i = 0; i < songs.length; i++) {
            const song = songs[i];
            const songName = decodeHTMLEntities(song.name) || 'Unknown';

            let currentStatus = 'Starting...';

            const result = await downloadAndSendSong(song.id, (status) => {
                currentStatus = status;
            });

            // Update stats
            if (result.success && !result.skipped) stats.success++;
            else if (result.skipped) stats.skipped++;
            else stats.failed++;

            // Update progress message (throttled)
            const now = Date.now();
            if (now - lastUpdateTime > 2000 || i === songs.length - 1 || (i + 1) % PROGRESS_UPDATE_INTERVAL === 0) {
                lastUpdateTime = now;
                await updateProgressMessage(chatId, messageId, {
                    type,
                    name: info.name,
                    current: i + 1,
                    total: songs.length,
                    currentSong: songName,
                    stats,
                    status: currentStatus
                });
            }

            if (i < songs.length - 1) await delay(DELAY_BETWEEN_SONGS);
        }

        // Final message
        const finalText = `${typeEmoji} *${type === 'artist' ? 'Artist' : 'Playlist'}:* ${escapeMarkdown(info.name)}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `✅ *COMPLETED\\!*\n\n` +
            `${progressBar(songs.length, songs.length)}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 *Final Stats:*\n` +
            `✅ Success: ${stats.success}\n` +
            `⏭️ Skipped: ${stats.skipped}\n` +
            `❌ Failed: ${stats.failed}\n` +
            `📁 Total: ${songs.length}`;

        await bot.editMessageText(finalText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'MarkdownV2'
        });

    } catch (err) {
        console.error(`Download error:`, err);
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    } finally {
        activeDownloads.delete(downloadKey);
    }
}

// ============ Direct Function Calls (for automation) ============
async function downloadByArtist(artistId) {
    console.log('\n' + '═'.repeat(50));
    console.log(`🚀 Starting download for Artist ID: ${artistId}`);
    console.log('═'.repeat(50));

    const info = await fetchArtistInfo(artistId);
    console.log(`👤 Artist: ${info.name}`);

    const songs = await fetchAllArtistSongs(artistId);
    console.log(`📊 Total songs: ${songs.length}\n`);

    if (songs.length === 0) {
        console.log('❌ No songs found');
        return;
    }

    let stats = { success: 0, skipped: 0, failed: 0 };

    for (let i = 0; i < songs.length; i++) {
        console.log(`\n[${i + 1}/${songs.length}] ${songs[i].name}`);

        const result = await downloadAndSendSong(songs[i].id, (status) => {
            console.log(`   📍 ${status}`);
        });

        if (result.success && !result.skipped) stats.success++;
        else if (result.skipped) stats.skipped++;
        else stats.failed++;

        if ((i + 1) % 10 === 0) {
            console.log(`\n📊 Progress: ${i + 1}/${songs.length} | ✅ ${stats.success} | ⏭️ ${stats.skipped} | ❌ ${stats.failed}`);
        }

        if (i < songs.length - 1) await delay(DELAY_BETWEEN_SONGS);
    }

    console.log('\n' + '═'.repeat(50));
    console.log('✅ COMPLETED!');
    console.log(`   ✅ Success: ${stats.success}`);
    console.log(`   ⏭️ Skipped: ${stats.skipped}`);
    console.log(`   ❌ Failed: ${stats.failed}`);
    console.log('═'.repeat(50));
}

async function downloadByPlaylist(playlistId) {
    console.log('\n' + '═'.repeat(50));
    console.log(`🚀 Starting download for Playlist ID: ${playlistId}`);
    console.log('═'.repeat(50));

    const info = await fetchPlaylistInfo(playlistId);
    console.log(`📋 Playlist: ${info.name}`);

    const songs = await fetchAllPlaylistSongs(playlistId);
    console.log(`📊 Total songs: ${songs.length}\n`);

    if (songs.length === 0) {
        console.log('❌ No songs found');
        return;
    }

    let stats = { success: 0, skipped: 0, failed: 0 };

    for (let i = 0; i < songs.length; i++) {
        console.log(`\n[${i + 1}/${songs.length}] ${songs[i].name}`);

        const result = await downloadAndSendSong(songs[i].id, (status) => {
            console.log(`   📍 ${status}`);
        });

        if (result.success && !result.skipped) stats.success++;
        else if (result.skipped) stats.skipped++;
        else stats.failed++;

        if (i < songs.length - 1) await delay(DELAY_BETWEEN_SONGS);
    }

    console.log('\n' + '═'.repeat(50));
    console.log('✅ COMPLETED!');
    console.log(`   ✅ Success: ${stats.success}`);
    console.log(`   ⏭️ Skipped: ${stats.skipped}`);
    console.log(`   ❌ Failed: ${stats.failed}`);
    console.log('═'.repeat(50));
}

// ============ Bot Command Handlers ============
function setupBotCommands() {
    // /artist command
    bot.onText(/\/artist\s+(\S+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const artistId = match[1];

        console.log(`\n📥 Bot command: /artist ${artistId} from ${msg.from.username || msg.from.id}`);

        await bot.sendMessage(chatId, `🔍 Fetching artist info for ID: \`${artistId}\`...`, { parse_mode: 'Markdown' });

        // Start download in background
        downloadWithProgress(chatId, 'artist', artistId);
    });

    // /playlist command
    bot.onText(/\/playlist\s+(\S+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const playlistId = match[1];

        console.log(`\n📥 Bot command: /playlist ${playlistId} from ${msg.from.username || msg.from.id}`);

        await bot.sendMessage(chatId, `🔍 Fetching playlist info for ID: \`${playlistId}\`...`, { parse_mode: 'Markdown' });

        // Start download in background
        downloadWithProgress(chatId, 'playlist', playlistId);
    });

    // /status command
    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;

        if (activeDownloads.size === 0) {
            await bot.sendMessage(chatId, '✅ No active downloads');
        } else {
            const active = Array.from(activeDownloads.keys()).join('\n• ');
            await bot.sendMessage(chatId, `📥 *Active Downloads:*\n• ${active}`, { parse_mode: 'Markdown' });
        }
    });

    // /help command
    bot.onText(/\/help|\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const helpText = `
🎵 *Saavn Downloader Bot*

*Commands:*
/artist \`<artistId>\` \\- Download all songs by artist
/playlist \`<playlistId>\` \\- Download all songs from playlist
/status \\- Check active downloads
/help \\- Show this message

*Examples:*
\`/artist 455782\`
\`/playlist 159470188\`

Songs will be sent to the configured channel and saved to database\\.
        `;
        await bot.sendMessage(chatId, helpText, { parse_mode: 'MarkdownV2' });
    });

    console.log('🤖 Bot commands registered: /artist, /playlist, /status, /help');
}

// Initialize bot commands
setupBotCommands();

// ============ Exports ============
module.exports = { 
    downloadByArtist, 
    downloadByPlaylist,
    downloadAndSendSong,
    fetchArtistInfo,
    fetchPlaylistInfo,
    fetchAllArtistSongs,
    fetchAllPlaylistSongs
};
