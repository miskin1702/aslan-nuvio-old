# Project Aslan: High-Performance Systems Architecture

**Document ID:** `ASLAN-ARCH-2026-V1`  
**Target Platform:** Nuvio Runtime & Android TV  
**Hardware Reference:** NVIDIA Shield TV Pro (Tegra X1+, 3GB LPDDR4, 64-bit ARM64 V8 Engine)  
**Execution Topology:** Fully Local / Zero-Server-Dependency (Client-Side JS Engine)  
**Origin Directives:** Clean-room synthesis from MoonCrown04, Wekmed, izlelan, Ripplay, and NuvioTR  

---

## 1. Executive Architecture & Mission Contract

Project Aslan is an enterprise-grade, high-performance streaming provider repository engineered specifically for client-side execution within Nuvio on Android TV environments. Traditional community scrapers suffer from severe memory bloat, high latency, unhandled promise rejections, and frequent UI freezes on Android TV devices. 

Aslan eliminates the intermediate server layer (Node/Vercel/Cloudflare Workers) entirely, executing scrapers directly inside the client JavaScript runtime (V8 / JavaScriptCore / QuickJS). Every provider scraper in Aslan is constrained by strict real-time execution budgets, bounded memory allocations, and resilient HTTP primitives designed to run on the NVIDIA Shield TV Pro hardware reference profile.

### Core Architectural Pillars
1. **Zero-Server Dependency**: Every scraper executes directly on the TV device. No proxy servers, no external middleware, no single point of network failure.
2. **Deterministic Micro-Parsing**: Heavy DOM parsers (e.g. `cheerio`, `jsdom`, `cheerio-without-node-native`) are banned. All DOM and HTML data is extracted using compiled, zero-allocation regular expressions and string slicers (<1ms CPU time per payload).
3. **Pre-Flight Stream Health Verification**: Dead streams, 404 links, expired tokenized MP4s, and geoblocked CDNs are filtered out via rapid pre-flight HTTP `HEAD` calls before reaching the Nuvio player interface.
4. **Normalized Audio & Subtitle Metadata**: Strict badges (`[🇹🇷 TR Dublaj]`, `[🌐 TR Altyazı]`, `[Dual Audio]`) and embedded WebVTT subtitle track resolution across all providers.

---

## 2. NVIDIA Shield TV Pro Optimization Specifications

The NVIDIA Shield TV Pro (ARM Cortex-A57 quad-core @ 1.9 GHz with Tegra X1+ GPU and 3GB LPDDR4 memory) serves as the primary hardware reference benchmark. The V8 engine running inside Android TV WebView or Hermit/QuickJS requires specialized engineering constraints:

```
+-------------------------------------------------------------------------------+
|                       NVIDIA Shield TV Pro Hardware Constraints               |
+-------------------------------------------------------------------------------+
| V8 Heap Headroom per Scrape:  <= 16 MB                                         |
| Parsing CPU Time Budget:      < 100 ms total thread execution                 |
| Fast Regex Micro-Parse Time:  < 1 ms per HTML document                        |
| Pre-flight HEAD Check:        <= 2500 ms per candidate endpoint               |
| Total Provider Batch Timeout: <= 8000 ms wall clock                           |
| Max Concurrency:              4 parallel provider dispatches                  |
+-------------------------------------------------------------------------------+
```

### 2.1. The Regex Micro-Parsing Mandate (<1ms Budget)
- **Problem**: Calling `cheerio.load(largeHtml)` allocates 40–120 MB of transient V8 heap, triggers immediate V8 GC (Garbage Collection) pauses on Android TV, causing visible audio stuttering or UI thread frame drops.
- **Rule**: NEVER import Cheerio or any virtual DOM parser.
- **Remediation**: Use `fastExtract(html, pattern, groupIndex)`. Compile regular expressions with strict bounds, avoid catastrophic backtracking (ReDoS), and search only necessary substrings.
- **Throughput Target**: A 500KB HTML payload must be scanned and extracted in `< 0.8ms` on Tegra X1+.

### 2.2. Pre-Flight HEAD Health Check Verification
- **Problem**: Free streaming providers frequently return 404 Not Found, 403 Forbidden (expired hash), or 503 Service Unavailable links. If Nuvio presents 10 dead links to the user, playback fails repeatedly.
- **Rule**: Every candidate video URL must undergo a lightweight pre-flight HTTP verification before being yielded to Nuvio.
- **Mechanism**:
  - Issue an HTTP `HEAD` request with a strict `2000ms - 2500ms` timeout using `AbortController`.
  - If the server responds with `405 Method Not Allowed`, issue a fallback `GET` request with header `Range: bytes=0-0`.
  - Accept HTTP status codes `200`, `206`, `301`, `302`, `307`, `308`. Reject `403`, `404`, `410`, `500`, `502`, `503`.

### 2.3. Memory Allocation and Garbage Collection Discipline
- Large HTML response bodies (`res.text()`) must not be stored in persistent variables or global state.
- Once the regex extraction is complete, nullify references to the raw HTML string so the V8 nursery collector can reclaim the memory instantly.
- Avoid nested closures that capture large surrounding lexical scopes.

---

## 3. Provider Contract Specifications

Every provider module in `aslan/providers/<id>.js` MUST implement and export the standardized asynchronous entrypoint `getStreams`.

### 3.1. Function Signature
```javascript
/**
 * Resolves media streams for the given TMDB media target.
 *
 * @param {string|number} tmdbId - TMDB Unique Identifier (e.g., 550 for Fight Club, 1399 for Game of Thrones).
 * @param {'movie'|'tv'} mediaType - Media category identifier.
 * @param {number|string} [seasonNum] - Season index (1-based), required when mediaType === 'tv'.
 * @param {number|string} [episodeNum] - Episode index (1-based), required when mediaType === 'tv'.
 * @returns {Promise<Array<NuvioStreamObject>>} - Resolves to an array of verified stream objects.
 */
async function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    // Implementation
}
```

### 3.2. Nuvio Stream Object Schema (`NuvioStreamObject`)
Each stream item returned in the array must conform to the following JSON structure:

```json
{
  "name": "Film / Dizi Adı",
  "title": "⌜ ASLAN ⌟ | Hdfilmcehennemi | 1080p | 🇹🇷 TR Dublaj",
  "url": "https://cdn.example.com/hls/master.m3u8",
  "quality": "1080p",
  "headers": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Referer": "https://hdfilmcehennemi.life/",
    "Origin": "https://hdfilmcehennemi.life"
  },
  "subtitles": [
    {
      "id": "tr",
      "lang": "Turkish",
      "label": "Türkçe",
      "url": "https://cdn.example.com/subs/turkish.vtt"
    }
  ],
  "behaviorHints": {
    "notWebReady": false,
    "bingeGroup": "aslan-hdfilmcehennemi"
  }
}
```

### 3.3. Quality Standard Values
The `quality` field must be normalized to one of:
- `"4K"` (or `"2160p"`)
- `"1080p"`
- `"720p"`
- `"480p"`
- `"Auto"` (default for adaptive HLS/DASH manifests)

---

## 4. Audio Tagging & Classification Rules

Turkish viewers on Nuvio demand explicit, accurate audio classification badges in the stream title. The title field must follow the standard typography:

$$\text{Format:} \quad \mathbf{\ulcorner \text{ PROVIDER } \urcorner \text{ | } \text{Source/Player} \text{ | } \text{Quality} \text{ | } \text{AudioBadge}}$$

### 4.1. Badge Definitions
| Badge Token | Display Name | Heuristic Matches & Conditions |
|---|---|---|
| `[🇹🇷 TR Dublaj]` | Türkçe Dublaj | `dil=0`, `dublaj`, `tr-dublaj`, `turkce-dublaj`, `trdublaj`, `turkish dub` |
| `[🌐 TR Altyazı]` | Türkçe Altyazılı | `dil=1`, `altyazi`, `tr-altyazi`, `turkce-altyazi`, `traktyazi`, `subtitles` |
| `[Dual Audio]` | Dual (Dublaj + Altyazı) | `dual`, `cift-ses`, `multi-audio`, `multi`, contains both audio tracks |
| `[EN Orijinal]` | Orijinal Dil | Default fallback when stream contains only original English/foreign audio |

### 4.2. Detection Hierarchy
1. If the provider API explicitly partitions streams (e.g. SezonlukDizi `dil=0` vs `dil=1`), tag directly.
2. If HTML button/tab text contains `Türkçe Dublaj` or `Dublaj`, tag with `[🇹🇷 TR Dublaj]`.
3. If the URL contains `.tr.` or `dublaj` or `turkce`, assign `[🇹🇷 TR Dublaj]`.
4. If player manifest has multi-audio tracks or the site lists "Dual", assign `[Dual Audio]`.
5. If only subtitles are present and audio is native foreign, assign `[🌐 TR Altyazı]`.

---

## 5. Embedded VTT & SRT Subtitle Extraction Rules

Providers hosting original audio or dual audio streams often link external WebVTT (`.vtt`) or SubRip (`.srt`) tracks via player options or HTML5 `<track>` tags.

### 5.1. Extraction Mechanics
1. **HTML5 Video Track Scanning**:
   - Micro-parse tags matching: `/<track[^>]+(?:src=["']([^"']+)["'])[^>]*>/gi`.
   - Inspect `kind` attribute (`subtitles` or `captions`).
   - Extract `srclang` (`tr`, `tur`, `en`, `eng`) and `label` (`Türkçe`, `English`).
2. **Player JSON Config Scanning**:
   - Extract `tracks\s*:\s*(\[[^\]]+\])` or `subtitles\s*:\s*(\[[^\]]+\])`.
   - Parse relative links and convert them to absolute URLs using the provider iframe's origin.
3. **URL Normalization**:
   - Relative URLs (`/subs/movie.vtt`) must be resolved against `baseUrl` using `new URL(src, baseUrl).href`.
   - Protocol-relative URLs (`//example.com/subs.vtt`) must be prepended with `https:`.
4. **Header Propagation**:
   - Subtitle CDNs requiring specific `Referer` or `User-Agent` headers must have those headers documented in the subtitle metadata structure.

---

## 6. Strategic Provider Catalog (11 Providers)

Project Aslan implements 11 high-value, verified Turkish streaming providers:

```
+-----------------------------------------------------------------------------------------+
|                                11 STRATEGIC PROVIDERS                                   |
+----+--------------------+--------------+-------------------+----------------------------+
| #  | Provider ID        | Media Types  | Primary Domains   | Player / Resolver Engine   |
+----+--------------------+--------------+-------------------+----------------------------+
| 1  | hdfilmcehennemi    | movie, tv    | hdfilmcehennemi*  | VidMoly, Rapidrame, Pichive|
| 2  | fullhdfilmizlesene | movie        | fullhdfilmizlesene| Atom, Turbo API Decoder    |
| 3  | filmmakinesi       | movie        | filmmakinesi.ch   | FPlayer, HLS m3u8 Direct   |
| 4  | dizipal            | tv           | dizipal*, dizibal | Cloud HLS, M3U8 Direct     |
| 5  | webteizle          | movie, tv    | webteizle3.xyz    | VidMoly, Sibnet, Pixeldrain|
| 6  | jetfilmizle        | movie        | jetfilmizle.net   | Pixeldrain API, Jetv HLS   |
| 7  | sezonlukdizi       | tv           | sezonlukdizi8.com | ASP Ajax, Sibnet, VidMoly  |
| 8  | sinefy             | movie, tv    | sinefy3.com       | Direct HLS, Selcukflix CDN |
| 9  | dizimia            | tv           | dizimia.live      | Fast M3U8, Custom HLS      |
| 10 | filmekseni         | movie, tv    | filmekseni.vip    | Multi-source Embeds        |
| 11 | yabancidizi        | tv           | yabancidizi.co    | VidMixi, YouTube, Sibnet   |
+----+--------------------+--------------+-------------------+----------------------------+
```

### 6.1. Provider Detail Profiles
1. **Hdfilmcehennemi**:
   - Largest Turkish movie and television catalog.
   - Embeds: VidMoly, Rapidrame, Pichive (`four.pichive.online`).
   - Strategy: Resolves TMDB ID to Turkish localized slug, extracts embedded iframe, decodes player payload.
2. **FullHDFilmizlesene**:
   - Premier movie archive with pristine 1080p Turkish dubbing.
   - Embeds: Atom player (RapidVid Base64 cipher) and Turbo player (`turbo.imgz.me`).
   - Strategy: Decodes dynamic XOR/shift cipher on video stream URLs.
3. **FilmMakinesi**:
   - Ultra-fast server response times, high availability.
   - Embeds: FPlayer custom HLS direct stream.
   - Strategy: Regex extracts `file: "(https?://[^"]+\.m3u8)"`.
4. **Dizipal / Dizibal**:
   - Rapid release cycle for ongoing TV series and global originals.
   - Embeds: Direct HLS manifests with rotating edge domains.
   - Strategy: Handles dynamic mirror domain redirection and cookies.
5. **Webteizle**:
   - Comprehensive historical archive of Turkish and foreign cinema.
   - Embeds: VidMoly, Sibnet, Netu, Pixeldrain.
   - Strategy: Subtitle extraction from iframe track declarations.
6. **JetFilmizle**:
   - High-speed Pixeldrain direct MP4 downloads and Jetv HLS streams.
   - Embeds: Pixeldrain API (`/api/file/{id}/info`) and Jetv embed player.
   - Strategy: Micro-parsing metadata to determine file size, 4K/1080p quality, and direct MP4 URL.
7. **SezonlukDizi**:
   - Cleanest dual-audio TV series source.
   - Embeds: `dataAlternatif.asp` and `dataEmbed.asp` endpoints.
   - Strategy: Parallel queries for `dil=0` (Dublaj) and `dil=1` (Altyazı), extracting Sibnet and VidMoly embeds.
8. **Sinefy / Selcukflix**:
   - Modern HLS video streaming infrastructure.
   - Embeds: Dedicated Selcukflix / Sinefy edge players.
   - Strategy: Tokenized master playlist resolution.
9. **Dizimia**:
   - Specialized foreign and domestic series provider.
   - Embeds: Native HLS m3u8 streams with dual audio channels.
   - Strategy: Slug generation with Turkish character normalization.
10. **Filmekseni**:
    - High-bitrate video encodings with fallback mirrors.
    - Embeds: VidMoly, UpStream, FileLions.
    - Strategy: Parallel embed resolution with priority queue.
11. **YabanciDizi**:
    - Complete season/episode TV catalog.
    - Embeds: VidMixi, Sibnet, DailyMotion.
    - Strategy: Episode list regex extraction and iframe resolution.

---

## 7. Error Handling, Resilience & Compliance

1. **Defensive Async Execution**:
   - Scrapers MUST wrap network and parsing routines in `try ... catch` blocks.
   - A single provider failure must NEVER throw an uncaught promise rejection. If a provider fails, it must resolve to `[]` (an empty array).
2. **Timeout Enforcement**:
   - Every outbound fetch must be wrapped in `fetchWithTimeout(url, options, ms)` with default timeout between 4000ms and 8000ms.
3. **Headers Standard**:
   - Outbound requests must emulate standard browser User-Agents:
     `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36`
   - Referer and Origin must match the target site's host to avoid 403 hotlink blocks.
4. **Code Quality**:
   - Pure, self-contained JavaScript compatible with standard V8. No Node-only native C++ bindings. No heavy external dependencies.
