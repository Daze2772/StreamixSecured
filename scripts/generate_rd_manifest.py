#!/usr/bin/env python3
"""
Generate Comet manifest URL for Real-Debrid.

Schema: Comet v2.x (effective 2026-05-26).

This script encodes the addon's CURRENT config-object shape into a
base64 segment and embeds it into the manifest URL that the Streamix
resolver reads from `RD_ADDON_MANIFEST_URL`.

If you ever see "OBSOLETE CONFIGURATION" in Comet's stream response
again, the schema has bumped — re-derive it from the live configurator:

    1. Open  https://comet.elfhosted.com/configure
    2. Fill in your RD key (and any options you care about)
    3. Click Install / Copy → grab the manifest URL
    4. base64-decode the path segment between
       `comet.elfhosted.com/` and `/manifest.json`
    5. Update the `config = { ... }` dict below to match the NEW
       keys / nesting / types Comet expects
    6. Update the date stamp at the top of this docstring

URL shape:
    https://comet.elfhosted.com/<urlsafe-b64 of JSON config>/manifest.json
(No `/s/` segment — that was the v1.x path and 404s now.)
"""

import base64
import json
import sys


def generate_comet_config(rd_api_key):
    """
    Build the v2.x Comet config object and return the manifest URL.
    Key order is preserved to match the configurator's output byte-for-byte.
    """
    config = {
        "maxResultsPerResolution": 5,
        "maxSize": 21474836480,                       # 20 GiB per file
        "cachedOnly": True,                           # never serve uncached debrid items
        "sortCachedUncachedTogether": False,
        "removeTrash": True,
        "resultFormat": ["all"],
        "debridServices": [
            {"service": "realdebrid", "apiKey": rd_api_key}
        ],
        "enableTorrent": False,
        "deduplicateStreams": False,
        "scrapeDebridAccountTorrents": False,
        "debridStreamProxyPassword": "",
        "languages": {
            "required": [],
            "allowed": [],
            "exclude": [],
            "preferred": ["en"],
        },
        "resolutions": {
            # `false` means "exclude". Anything not listed here is allowed
            # (so 2160p / 1080p / 720p / 480p stay in).
            "r576p": False,
            "r360p": False,
            "r240p": False,
            "unknown": False,
        },
        "options": {
            "remove_ranks_under": -10000000000,
            "allow_english_in_languages": True,
            "remove_unknown_languages": False,
        },
    }

    # Comet expects a compact, key-ordered JSON encoding.
    json_config = json.dumps(config, separators=(",", ":"))

    # URL-safe base64, no `=` padding (matches the configurator).
    encoded = base64.urlsafe_b64encode(json_config.encode()).decode().rstrip("=")

    return f"https://comet.elfhosted.com/{encoded}/manifest.json"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 generate_rd_manifest.py <RD_API_KEY>")
        sys.exit(1)

    rd_key = sys.argv[1]
    manifest_url = generate_comet_config(rd_key)
    print(f"Generated Manifest URL:\n{manifest_url}")
