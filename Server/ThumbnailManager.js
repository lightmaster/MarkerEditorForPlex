import { existsSync, mkdirSync, readFile, readFileSync, rmSync, statSync } from 'fs';
import { join, join as joinPath } from 'path';
import { execFileSync } from 'child_process';

import { Log } from '../Shared/ConsoleLog.js';
import DatabaseWrapper from './DatabaseWrapper.js';
import ServerError from './ServerError.js';
import { Config } from './IntroEditorConfig.js';


/**
 * Singleton thumbnail manager instance
 * @type {ThumbnailManager}
 * @readonly */
let Instance;

/**
 * The ThumbnailManager class provides the base interface for retrieving a thumbnail
 * for a specific timestamp in an episode. */
class ThumbnailManager {
    /** The Plex database connection.
     * @type {DatabaseWrapper} */
     database;

    /**
     * Create the singleton ThumbnailManager instance
     * @param {DatabaseWrapper} db The database connection
     * @param {string} metadataPath The path to the root of Plex's data directory */
    static async Create(db, metadataPath) {
        if (Instance != null) {
            Log.warn(`Thumbnail manager already initialized, we shouldn't be initializing it again`);
        }

        if (Config.usePreciseThumbnails()) {
            Instance = new FfmpegThumbnailManager(db);
            return Instance;
        }

        Instance = new BifThumbnailManager(db, metadataPath);
        return Instance;
    }

    /**
     * Clears out the thumbnail manager instance
     * @param {boolean} fullShutdown Whether this close is coming from a full shutdown request. */
    static Close(fullShutdown) { Instance?.close(fullShutdown); Instance = null; }

    /**
     * Verifies that we can find ffmpeg in our path */
    static TestFfmpeg() {
        try {
            execFileSync('ffmpeg', ['-version']);
            return true;
        } catch (err) {
            return false;
        }
    }

    constructor(db) {
        this.database = db;
    }

    /**
     * Determine if an episode has thumbnails available.
     * @param {number} metadataId The metadata id of the episode to check.
     * @returns {Promise<boolean>} */
    async hasThumbnails(metadataId) { Log.error(`ThumbnailManager.getThumbnail: This should not be called on the base class ${metadataId}`); }

    /**
     * Retrieve a thumbnail for an episode at a specific timestamp.
     *
     * If we have not yet determined if the episode has an associated thumbnail file,
     * check that before looking for the thumbnail itself.
     * @param {number} metadataId The metadata id for the episode.
     * @param {number} timestamp The timestamp of the thumbnail, in milliseconds.
     * @returns A `Promise` that will resolve to the thumbnail `Buffer` if the thumbnail
     * retrieval was successful, and `reject`ed if the thumbnail doesn't exist or we were
     * otherwise unable to retrieve it. */
    async getThumbnail(metadataId, timestamp) { Log.error(`ThumbnailManager.getThumbnail: This should not be called on the base class ${metadataId}:${timestamp}`); }

    close() {}
}

/**
 * The BifThumbnailManager class reads thumbnail preview files generated by Plex to
 * pull out individual thumbnails from specific timestamps.
 *
 * A caching mechanism is also built in so that reused thumbnails don't always
 * need to be re-read from disk. */
class BifThumbnailManager extends ThumbnailManager {

     /** The path the Plex's data directory.
      * @type {string} */
     #metadataPath;

    /** A map of episode metadataIds to the cached thumbnails of the episode.
     * @type {BifCacheMap} */
     #cache;

     /**
      * Database query to retrieve the media hash for an episode,
      * used for finding the path to the generated index-sd.bif files.
     */
     static #hashQuery = `
         SELECT media_parts.id, media_parts.hash AS hash FROM media_parts
         INNER JOIN media_items ON media_parts.media_item_id=media_items.id
         INNER JOIN metadata_items ON media_items.metadata_item_id=metadata_items.id
         WHERE metadata_items.id=?
         ORDER BY media_parts.id ASC;`;

    /**
     * Create a new ThumbnailManager
     * @param {DatabaseWrapper} db The database connection
     * @param {string} metadataPath The path to the root of Plex's data directory */
     constructor(db, metadataPath) {
        super(db);
        this.#metadataPath = metadataPath;
        this.#cache = new BifCacheMap(200 /*maxCache*/);
    }

    /**
     * Determine if an episode has thumbnails generated by Plex.
     * @param {number} metadataId The metadata id of the episode to check.
     * @returns {Promise<boolean>} */
    async hasThumbnails(metadataId) {
        const cached = this.#cache.getItem(metadataId);
        if (cached) {
            return cached.hasThumbs;
        }

        const rows = await this.database.all(BifThumbnailManager.#hashQuery, [metadataId]);

        // Episodes with multiple versions may have multiple BIF files. Grab the newest one.
        let newest = { path : '', mtime : 0, found : 0 };
        for (const row of rows) {
            const bifPath = joinPath(this.#metadataPath, 'Media', 'localhost', row.hash[0], row.hash.substring(1) + '.bundle', 'Contents', 'Indexes', 'index-sd.bif');
            const stats = statSync(bifPath, { throwIfNoEntry : false });
            if (stats !== undefined) {
                if (stats.mtimeMs > newest.mtime) {
                    newest.path = bifPath;
                    newest.mtime = stats.mtimeMs;
                }

                ++newest.found;
            }
        }

        if (newest.path.length > 0) {
            const extra = newest.found > 1 ? ` (newest of ${newest.found})` : '';
            Log.verbose(newest.path, `Found thumbnail index file for ${metadataId}${extra}`);
            this.#cache.addItem(metadataId, true, newest.path);
            return true;
        }

        Log.verbose(`Did not find thumbnail index file for ${metadataId}`);
        this.#cache.addItem(metadataId, false);
        return false;
    }

    /**
     * Retrieve a generated thumbnail closest to the given timestamp, rounded down.
     * @param {number} metadataId The metadata id of the episode.
     * @param {number} timestamp The timestamp, in milliseconds */
    async getThumbnail(metadataId, timestamp) {
        // Use 1s as the smallest possible interval. 2 is the default, and I'd be very surprised
        // if anyone made is less than that, but better safe than sorry I guess.
        timestamp = Math.floor(timestamp / 1000);
        if (!this.#cache.getItem(metadataId)) {
            await this.hasThumbnails(metadataId);
        }

        return this.#getThumbnailCore(metadataId, timestamp);
    }

    /**
     * Checks the cache for the requested thumbnail and returns that if available.
     * Otherwise kicks off the process of reading the BIF file.
     *
     * Assumes `hasThumbnails` has been called for the given episode.
     * @param {number} metadataId The metadata id for the episode.
     * @param {number} timestamp The timestamp of the thumbnail, in seconds. */
    async #getThumbnailCore(metadataId, timestamp) {
        const thumbCache = this.#cache.getItem(metadataId);
        if (!thumbCache || !thumbCache.hasThumbs) {
            // We only expect to be called if thumbnails are actually available.
            throw new ServerError(`No thumbnails for ${metadataId}`);
        }

        let index;
        if (thumbCache.interval != 0) {
            index = Math.floor(timestamp / thumbCache.interval);
            let cachedData = this.#cache.tryGet(metadataId, index);
            if (cachedData) {
                Log.verbose(`Found cached thumbnail for ${metadataId}:${timestamp}.`);
                return cachedData;
            }
        }

        return this.#readThumbnail(metadataId, timestamp);
    }

    /**
     * Open the index-sd.bif file associated with the episode and extract the thumbnail
     * closest to the given timestamp (rounded down).
     * @param {number} metadataId The metadata id for the episode.
     * @param {number} timestamp The timestamp of the thumbnail, in seconds.
     * @returns {Promise<Buffer>}*/
    async #readThumbnail(metadataId, timestamp) {
        const thumbCache = this.#cache.getItem(metadataId);
        return new Promise((resolve, reject) => {

            // File layout:
            // Starts with magic 89 42 49 46 0D 0A 1A 0A (0x89 BIF \r\n\sub\n)
            // 32(?)-bit integer at offset 0xC indicating the number of thumbnails in the file
            // Index table starts at 0x40, with 8-byte records:
            //   * A 32-bit little-endian integer timestamp (in seconds) -> 02 00 00 00 -> 2 seconds
            //   * A 32-bit little-endian integer offset into the file indicating the start of the thumbnail.
            readFile(thumbCache.bifPath, (err, data) => {
                if (err) {
                    reject('Failed to read thumbnail file');
                    return;
                }

                const thumbnailCountOffset = 0xC;
                const indexTableStart = 0x40;
                const recordSize = 0x8;
                const timestampSize = 0x4;
                const getOffset = (index) => data.readInt32LE(indexTableStart + (index * recordSize) + timestampSize);
                const getTimestamp = (index) => data.readInt32LE(indexTableStart + (index * recordSize));

                if (thumbCache.interval == 0) {
                    const verify = getTimestamp(0);
                    if (verify != 0) {
                        reject('Unexpected thumbnail file contents');
                        return;
                    }

                    thumbCache.interval = getTimestamp(1);
                }

                let index = Math.floor(timestamp / thumbCache.interval);

                // Last index points to the end of the file, so the real max is the
                // number of indexes minus 1.
                const maxIndex = data.readInt32LE(thumbnailCountOffset) - 1;
                if (index > maxIndex) {
                    Log.warn('Received thumbnail request beyond max timestamp. Retrieving last thumbnail instead.');
                    index = maxIndex;
                } else if (index < 0) {
                    Log.warn('Received negative thumbnail request. Retrieving first thumbnail instead.');
                    index = 0;
                }

                const thumbStart = getOffset(index);
                const thumbEnd = index == maxIndex ? data.length : getOffset(index + 1);
                const thumbBuf = Buffer.alloc(thumbEnd - thumbStart);
                data.copy(thumbBuf, 0, thumbStart, thumbEnd);
                Log.verbose(`Thumbnail found, caching (${thumbEnd - thumbStart} bytes).`);
                this.#cache.add(metadataId, index, thumbBuf);
                resolve(thumbBuf);
            });
        });
    }
}

/**
 * Thumbnail manager for generating thumbnails on-the-fly with ffmpeg.
 * Requires a somewhat recent version of ffmpeg that exists in the user's path.
 */
class FfmpegThumbnailManager extends ThumbnailManager {
    /** Plex database query that finds the files associated with a metadata id. */
    static #fileQuery = `
    SELECT parts.file AS file, media.duration as duration FROM metadata_items metadata
    INNER JOIN media_items media ON media.metadata_item_id=metadata.id
    INNER JOIN media_parts parts ON parts.media_item_id=media.id
    WHERE metadata.id=?
    ORDER BY media.duration DESC;
    `;

    /** @type {FfmpegCacheMap} */
    #cache;

    /** Maximum size of our LRU cache before we start clearing space.
     * TODO: How useful is this with the file cache backup? Are load times
     * that noticeably different? */
    static #maxCache = 200;

    constructor(db) {
        super(db);
        this.#cache = new FfmpegCacheMap(FfmpegThumbnailManager.#maxCache);
    }

    /**
     * Determine whether any file associated with the given metadata id exists,
     * which indicates we can run ffmpeg on it to generate thumbnails.
     * @param {number} metadataId The episode metadata id. */
    async hasThumbnails(metadataId) {
        // Check whether the file exists/we have access to it.
        let cached = this.#cache.getItem(metadataId);
        if (cached) {
            return cached.hasThumbs;
        }

        const rows = await this.database.all(FfmpegThumbnailManager.#fileQuery, [metadataId]);

        for (const file of rows) {
            if (existsSync(file.file)) {
                Log.verbose(file.file, `Found file for ${metadataId}`);
                this.#cache.addItem(metadataId, true, file.file, file.duration);
                return true;
            }
        }

        Log.verbose(`No file found for ${metadataId}`);
        this.#cache.addItem(metadataId, false);
        return false;
    }

    /**
     * Retrieve the thumbnail for the given episode at the given timestamp (to the nearest tenth, rounded down).
     * @param {number} metadataId Episode metadata id.
     * @param {number} timestamp Timestamp, in milliseconds. */
    async getThumbnail(metadataId, timestamp) {
        if (!this.#cache.getItem(metadataId)) {
            await this.hasThumbnails(metadataId);
        }

        return this.#getThumbnailCore(metadataId, timestamp);
    }

    /**
     * Extract a precise thumbnail from the given file.
     * @param {number} metadataId Metadata id of the episode
     * @param {number} timestamp Timestamp, in milliseconds */
    async #getThumbnailCore(metadataId, timestamp) {
        if (!this.#cache.getItem(metadataId)?.hasThumbs) {
            throw new ServerError(`No thumbnails for ${metadataId}`);
        }

        const maxDuration = this.#cache.getItem(metadataId).duration;

        // Don't get _too_ accurate, round to the nearest tenth, which might help with caching too.
        // Also don''t get too close to the supposed end. There are a fair number of cases where our max
        // duration doesn't actually line up with the video stream of the file. Give ourselves some leeway
        // by grabbing a timestamp that's a bit earlier, and hopefully within the bounds of the stream.
        timestamp = Math.round(Math.min(maxDuration - 1000, Math.floor(timestamp / 100) * 100));

        const cachedThumb = this.#cache.tryGet(metadataId, timestamp);
        if (cachedThumb) {
            Log.tmi(`Found cached thumbnail for ${metadataId}:${timestamp}`);
            return cachedThumb;
        }

        return this.#fileCacheOrGenerate(metadataId, timestamp);
    }

    /**
     * Looks for a cached thumbnail file for the given timestamp, and if not found,
     * generates the thumbnail with ffmpeg.
     * @param {number} metadataId
     * @param {number} timestamp Timestamp, in milliseconds */
    #fileCacheOrGenerate(metadataId, timestamp) {
        const savePath = join(Config.projectRoot(), 'cache', `${metadataId}`);
        const saveFile = join(savePath, `${timestamp}.jpg`);
        if (existsSync(saveFile)) {
            Log.tmi(`Found cached thumbnail file for ${metadataId}:${timestamp}`);
            const data = readFileSync(saveFile);
            this.#cache.add(metadataId, timestamp, data);
            return data;
        }

        mkdirSync(savePath, { recursive : true });
        let episodeCache = this.#cache.getItem(metadataId);
        const execStart = performance.now();
        execFileSync('ffmpeg', [
            '-loglevel', 'error',         // We don't care about the output
            '-noaccurate_seek',           // Seek quickly, it's okay if we're slightly off
            '-ss', `${timestamp}ms`,      // NOTE: 000ms syntax requires a somewhat modern version of ffmpeg (>=4?)
            `-i`, episodeCache.filePath,
            '-vf', 'scale=240:-1',        // Thumbnails are displayed with a width of 240, no need to go over that.
            '-vframes', '1',              // Grab a single frame
            '-y',                         // Force overwrite (though we shouldn't get here if that's the case)
            saveFile],
            { timeout : 10000 });         // Give up if it takes more than 10 seconds.
        // It better exist now. Just throw if we fail and it will be caught by the caller.
        const data = readFileSync(saveFile);
        this.#cache.add(metadataId, timestamp, data);
        const execEnd = performance.now();
        Log.tmi(`Generated thumbnail ${metadataId}:${timestamp} in ${Math.round(execEnd - execStart)}ms`);
        return data;
    }

    /**
     * On full shutdown, wipe out the cache folder.
     * @param {boolean} fullShutdown Whether we're completely shutting down, or just suspended/restarting. */
    close(fullShutdown) {
        if (!fullShutdown) {
            Log.verbose(`FfmpegThumbnailManager: Not a full shutdown, not clearing cache.`);
            return;
        }

        const cacheRoot = join(Config.projectRoot(), 'cache');
        if (!existsSync(cacheRoot)) {
            // Nothing to clear
            return;
        }

        try {
            rmSync(cacheRoot, { recursive : true, force : true });
            Log.verbose(`FfmpegThumbnailManager: Successfully removed cached thumbnails.`);
        } catch (err) {
            Log.warn(err.message, `FfmpegThumbnailManager: Failed to clear cached thumbnails.`);
        }
    }
}

/**
 * Simple LRU-like cache that keeps track of cached thumbnails.
 */
class CacheMap {
    /** Maximum number of items allowed in the cache.
     * @type {number} */
    #maxCache;
    /** Current tick that increases after every get/add. Tracks when to prune the cache.
     * @type {number} */
    #tick = 0;
    /** Sets how many ticks pass before we prune the cache.
     * @type {number} */
    #maxTick = 20;
    /** @type {{[metadataId: number]: MediaItemCache}} */
    #cacheMap = {};

    /**
     * Construct a new cache.
     * @param {number} maxCache Maximum number of items in the cache. */
    constructor(maxCache) {
        this.#maxCache = maxCache;
    }

    /**
     * Internal base implementation called by derived classes.
     * @param {number} metadataId
     * @param {MediaItemCache} episodeCache */
    _addItem(metadataId, episodeCache) {
        this.#cacheMap[metadataId] = episodeCache;
    }

    /**
     * Add a new thumbnail to the cache
     * @param {number} metadataId Episode metadata id.
     * @param {number} timestamp Timestamp of the thumbnail.
     * @param {Buffer} buffer Thumbnail buffer. */
    add(metadataId, timestamp, buffer) {
        if (!this.#cacheMap[metadataId]) {
            Log.warn(`Unable to add thumbnail to cache, episode cache for ${metadataId} is not initialized!`);
            return;
        }

        this.#touch();
        this.#cacheMap[metadataId].cachedThumbnails[timestamp] = new CachedThumbnail(buffer, this.#maxCache + 1);
    }

    /**
     * Retrieve episode thumbnail information.
     * @param {number} metadataId Episode metadata id. */
    getItem(metadataId) {
        return this.#cacheMap[metadataId] || false;
    }

    /**
     * Attempt to retrieve a thumbnail for an episode at the given timestamp, returning `false` if it doesn't exist.
     * @param {number} metadataId Episode metadata id.
     * @param {number} timestamp Timestamp, in milliseconds
     * @returns {Buffer|false} */
    tryGet(metadataId, timestamp) {
        if (!this.#cacheMap[metadataId]) {
            return false;
        }

        if (!this.#cacheMap[metadataId].cachedThumbnails[timestamp]) {
            return false;
        }

        const thumbEntry = this.#cacheMap[metadataId].cachedThumbnails[timestamp];
        thumbEntry.rank = this.#maxCache + 1;
        this.#touch();
        return thumbEntry.data;
    }

    /**
     * Called after every successful add/get operation to update ranks/evict
     * stale thumbnails. */
    #touch() {
        // Iterating over all items on every access/add is inefficient,
        // only do it every 20 ticks, then bulk delete if necessary.
        if (++this.#tick != this.#maxTick) {
            return;
        }

        Log.tmi(`Updating thumbnail LRU cache`)
        this.#tick = 0;
        for (const cacheItem of Object.values(this.#cacheMap)) {
            for (const thumb of Object.keys(cacheItem.cachedThumbnails)) {
                if ((cacheItem.cachedThumbnails[thumb].rank -= this.#maxTick) <= 0) {
                    delete cacheItem.cachedThumbnails[thumb];
                }
            }
        }
    }
}

/**
 * Map of episodes to cached Plex-generated BIF thumbnails.
 */
class BifCacheMap extends CacheMap {
    constructor(maxCache) {
        super(maxCache);
    }

    addItem(metadataId, hasThumbs, bifPath='') {
        this._addItem(metadataId, new BifMediaItemCache(hasThumbs, bifPath));
    }

    /**
     * @param {number} metadataId
     * @returns {BifMediaItemCache} */
    getItem(metadataId) { return super.getItem(metadataId) } // Just for intellisense
}

/**
 * Map of episodes to cached ffmpeg JPG thumbnails.
 */
class FfmpegCacheMap extends CacheMap {
    constructor(maxCache) {
        super(maxCache);
    }

    addItem(metadataId, hasThumbs, filePath='', duration=0) {
        this._addItem(metadataId, new FfmpegMediaItemCache(hasThumbs, filePath, duration));
    }

    /**
     * @param {number} metadataId 
     * @returns {FfmpegMediaItemCache} */
    getItem(metadataId) { return super.getItem(metadataId) } // Just for intellisense
}

/** @typedef {{[timestamp: number]: CachedThumbnail}} ThumbnailMap */

/** Base interface that information about the thumbnail status for an episode, including any cached thumbnails. */
class MediaItemCache {
    /** Whether this episode has thumbnails available.
     * @type {boolean} */
    hasThumbs;

    /** The cache of current thumbnails.
     * @type {ThumbnailMap} */
    cachedThumbnails = {};

    constructor(hasThumbs) {
        this.hasThumbs = hasThumbs;
    }
}


/** Extension of EpisodeCache that adds information about the index-sd.bif file for an episode. */
class BifMediaItemCache extends MediaItemCache {

    /** The path to `index-sd.bif`, if `hasThumbs` is `true`.
     * @type {string} */
    bifPath;

    /** The number of seconds between thumbnails in `index-sd.bif`
     * @type {number} */
    interval = 0;

    /**
     * Construct an EpisodeCache.
     * @param {boolean} hasThumbs `true` if the episode has thumbnails, false otherwise.
     * @param {string} [bifPath=''] The path to the index-sd.bif file, if `hasThumbs` is true. */
    constructor(hasThumbs, bifPath='') {
        super(hasThumbs);
        this.bifPath = bifPath;
    }
}

/** Extension of EpisodeCache that adds information about the file path to an episode. */
class FfmpegMediaItemCache extends MediaItemCache {
    /** @type {string} */
    filePath;
    /** @type {number} */
    duration;

    constructor(hasThumbs, filePath='', duration=0) {
        super(hasThumbs);
        this.filePath = filePath;
        this.duration = duration;
    }
}

/** A cached thumbnail, along with its rank (to be used by cache pruning). */
class CachedThumbnail {
    /** The raw byte buffer of the thumbnail.
     * @type {Buffer} */
    data;

    /** The positing of the thumbnail in the LRU cache.
     * @type {number} */
    rank;

    /**
     * Construct a CachedThumbnail
     * @param {Buffer} buffer The raw byte buffer of the thumbnail
     * @param {number} rank The position of the thumbnail in the LRU cache. */
    constructor(buffer, rank) {
        this.data = buffer;
        this.rank = rank;
    }
}

export { ThumbnailManager, Instance as Thumbnails };
