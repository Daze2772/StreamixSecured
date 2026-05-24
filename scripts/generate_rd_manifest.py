#!/usr/bin/env python3
"""
Generate Comet manifest URL for Real-Debrid
This script creates the configuration token needed for Comet addon
"""

import json
import base64
import sys

def generate_comet_config(rd_api_key):
    """
    Generate Comet configuration for Real-Debrid
    """
    # Comet configuration structure
    config = {
        "debridServices": [
            {
                "service": "realdebrid",
                "apiKey": rd_api_key
            }
        ],
        "maxResults": 5,
        "resolutions": ["2160p", "1080p", "720p"],
        "languages": ["en"],
        "removeTrash": True,
        "showCachedOnly": False
    }
    
    # Convert to JSON and encode
    json_config = json.dumps(config, separators=(',', ':'))
    
    # Base64 encode (URL-safe)
    encoded = base64.urlsafe_b64encode(json_config.encode()).decode().rstrip('=')
    
    # Generate manifest URL
    manifest_url = f"https://comet.elfhosted.com/s/{encoded}/manifest.json"
    
    return manifest_url

if __name__ == "__main__":
    rd_key = "QGTCVVHPI7LDW4YUIZSQW5OB6G6BPDBOYRWVKAYMXNBTACO44NDA"
    
    manifest_url = generate_comet_config(rd_key)
    print(f"Generated Manifest URL:\n{manifest_url}")
