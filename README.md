# Audio Level Matcher

A WordPress plugin that automatically normalizes the loudness of all audio players on a page. Works with the built-in `[audio]` shortcode and any `<audio>` element.

## The problem

When hundreds of users upload audio files to your site, each file will be mastered at a different loudness level. Listeners are forced to constantly adjust their volume — or worse, get blasted by a loud track after a quiet one.

## How it works

1. **On page load**, the plugin discovers every `<audio>` element on the page and wires each one through a Web Audio API gain node.
2. **On first play**, it fetches the audio file, decodes it offline, and measures the RMS loudness of the first N seconds.
3. **It computes a gain correction** to bring the track to your configured target level (default: −18 dBFS RMS).
4. **The gain is applied in real-time** through the Web Audio API — the original files are never modified.

If anything fails (CORS issues, network errors, unsupported browser), the audio plays at its original level. No errors, no broken players.

## Installation

1. Upload the `audio-level-matcher` folder to `/wp-content/plugins/`.
2. Activate the plugin in **Plugins → Installed Plugins**.
3. Configure options in **Settings → Audio Level Matcher**.

## Settings

| Option | Default | Description |
|--------|---------|-------------|
| Target loudness | −18 dBFS | The RMS level all audio is normalized to. Presets: −14 (streaming), −16, −18, −20, −23 (broadcast). |
| Max boost | 12 dB | Maximum gain applied to quiet tracks. Higher values risk amplifying noise. |
| Max cut | 12 dB | Maximum reduction applied to loud tracks. |
| Analysis duration | 10 sec | How many seconds from the start of each file to measure. |
| One player at a time | On | Pauses other players when one starts. |
| Enabled | On | Master switch. When off, audio plays at original levels. |

## Requirements

- WordPress 5.8+
- PHP 7.4+
- Audio files must be served from the **same origin** as the site, or with proper CORS headers (the plugin automatically adds `crossorigin="anonymous"` to WordPress audio shortcodes).

## CORS notes

The Web Audio API requires CORS access to process audio data. The plugin handles this for WordPress `[audio]` shortcodes automatically. If you use a CDN, make sure it sends `Access-Control-Allow-Origin` headers for audio files.

## FAQ

**Can I change the target loudness?**
Yes — go to Settings → Audio Level Matcher and pick from the preset values (−14 to −23 dBFS). −14 is what most streaming platforms normalize to. −18 is a good default for web playback.

**Does this modify my audio files?**
No. Gain correction is applied in real-time in the browser. Your original files are untouched.

**What happens on mobile?**
Modern mobile browsers support Web Audio API. The plugin respects autoplay restrictions — analysis only runs when the user taps play.

**What if a track is extremely quiet or loud?**
The gain is clamped to the configured limits (default ±12 dB). Tracks outside that range will be partially corrected rather than over-amplified.

**Does it work with page builders / AJAX content?**
Yes. The plugin uses a MutationObserver to detect `<audio>` elements added after page load.

## File structure

```
audio-level-matcher/
├── audio-level-matcher.php   ← Main plugin file (settings + hooks)
├── js/
│   └── audio-level-matcher.js  ← Frontend script (all the audio logic)
└── README.md
```

## Development

### Repository

This plugin is version-controlled with Git. The repository includes development files like `.gitignore` and `.gitattributes` that are automatically excluded from production builds.

### Creating a Production Build

To create a production-ready zip file (without development files, git metadata, or system files):

```bash
git archive --format=zip --output=audio-level-matcher.zip HEAD
```

This creates a clean zip containing **only** the essential plugin files:
- `audio-level-matcher.php`
- `js/audio-level-matcher.js`

Files automatically excluded from the production build:
- `.git/` directory
- `.gitignore`
- `.gitattributes`
- `README.md`
- Any untracked or system files

The resulting zip can be uploaded directly to WordPress via **Plugins → Add New → Upload Plugin**.

## License

GPL-2.0-or-later
