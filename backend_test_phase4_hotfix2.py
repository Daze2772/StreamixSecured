#!/usr/bin/env python3
"""
Backend test for Phase 4 Hotfix Issue 2 — Audio switch latency (probe cache + fast path)

Tests the new probe cache + fast-path optimization in:
- /app/lib/hls-sessions.js (sourceProbeCache)
- /app/app/api/stream/hls/session/route.js (fast path on cache hit)

Test plan:
A. Resolver regression check (GET /api/realdebrid/resolve)
B. Fast-path verification (POST /api/stream/hls/session with cached sourceUrl)
C. Playlist GET after fast-path POST
D. Cold-path correctness (cache miss)
E. Validation / security
"""

import requests
import time
import json
import sys
import os

# Backend URL from environment
BASE_URL = os.getenv('NEXT_PUBLIC_BASE_URL', 'http://localhost:3000')
API_BASE = f"{BASE_URL}/api"

def log(msg):
    print(f"[TEST] {msg}")

def test_resolver_regression():
    """A. Resolver regression check - verify resolver still works and populates cache"""
    log("=" * 80)
    log("TEST A: Resolver regression check (Fight Club)")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/realdebrid/resolve?type=movie&tmdb=550&imdb=tt0137523"
        log(f"GET {url}")
        
        start = time.time()
        resp = requests.get(url, timeout=60)
        elapsed = time.time() - start
        
        log(f"Status: {resp.status_code}, Time: {elapsed:.2f}s")
        
        if resp.status_code != 200:
            log(f"❌ FAILED: Expected 200, got {resp.status_code}")
            log(f"Response: {resp.text[:500]}")
            return None
        
        data = resp.json()
        
        # Verify response structure
        required_fields = ['success', 'streamUrl', 'streamType', 'directUrl', 
                          'audioStreams', 'selectedAudioIndex', 'sourceDuration', 'qualities']
        missing = [f for f in required_fields if f not in data]
        if missing:
            log(f"❌ FAILED: Missing fields: {missing}")
            return None
        
        if data.get('streamType') != 'hls':
            log(f"❌ FAILED: Expected streamType='hls', got '{data.get('streamType')}'")
            return None
        
        if not data.get('streamUrl', '').startswith('/api/stream/hls/'):
            log(f"❌ FAILED: streamUrl doesn't match HLS pattern: {data.get('streamUrl')}")
            return None
        
        if not isinstance(data.get('audioStreams'), list):
            log(f"❌ FAILED: audioStreams is not a list")
            return None
        
        if not isinstance(data.get('qualities'), list):
            log(f"❌ FAILED: qualities is not a list")
            return None
        
        # Extract directUrl for next tests
        direct_url = data.get('directUrl')
        if not direct_url or not direct_url.startswith('https://comet.elfhosted.com/playback/'):
            log(f"❌ FAILED: directUrl is not a valid Comet URL: {direct_url}")
            return None
        
        log(f"✅ PASSED: Resolver returned valid HLS response")
        log(f"   - streamType: {data.get('streamType')}")
        log(f"   - streamUrl: {data.get('streamUrl')}")
        log(f"   - audioStreams count: {len(data.get('audioStreams', []))}")
        log(f"   - selectedAudioIndex: {data.get('selectedAudioIndex')}")
        log(f"   - sourceDuration: {data.get('sourceDuration')}")
        log(f"   - qualities count: {len(data.get('qualities', []))}")
        log(f"   - directUrl: {direct_url[:80]}...")
        
        return direct_url
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return None

def test_fast_path_basic(source_url):
    """B. Fast-path verification - POST with cached sourceUrl should be < 1000ms"""
    log("\n" + "=" * 80)
    log("TEST B1: Fast-path basic (audioIndex=0)")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/stream/hls/session"
        payload = {
            "sourceUrl": source_url,
            "start": 60,
            "audioIndex": 0,
            "quality": "1080p"
        }
        
        log(f"POST {url}")
        log(f"Payload: {json.dumps(payload, indent=2)}")
        
        start = time.time()
        resp = requests.post(url, json=payload, timeout=30)
        elapsed = time.time() - start
        elapsed_ms = elapsed * 1000
        
        log(f"Status: {resp.status_code}, Time: {elapsed_ms:.0f}ms")
        
        if resp.status_code != 200:
            log(f"❌ FAILED: Expected 200, got {resp.status_code}")
            log(f"Response: {resp.text[:500]}")
            return None
        
        data = resp.json()
        
        # Verify response structure
        required_fields = ['success', 'sessionId', 'streamUrl', 'streamType', 
                          'startOffset', 'sourceDuration', 'audioStreams', 'selectedAudioIndex']
        missing = [f for f in required_fields if f not in data]
        if missing:
            log(f"❌ FAILED: Missing fields: {missing}")
            return None
        
        if not data.get('success'):
            log(f"❌ FAILED: success is not true")
            return None
        
        if data.get('streamType') != 'hls':
            log(f"❌ FAILED: Expected streamType='hls', got '{data.get('streamType')}'")
            return None
        
        if data.get('selectedAudioIndex') != 0:
            log(f"⚠️  WARNING: Expected selectedAudioIndex=0, got {data.get('selectedAudioIndex')}")
        
        # Check response time (target < 1000ms for fast path)
        if elapsed_ms > 1000:
            log(f"⚠️  WARNING: Response time {elapsed_ms:.0f}ms > 1000ms (expected fast path)")
        else:
            log(f"✅ Fast path confirmed: {elapsed_ms:.0f}ms < 1000ms")
        
        log(f"✅ PASSED: Fast-path POST returned valid response")
        log(f"   - sessionId: {data.get('sessionId')}")
        log(f"   - streamUrl: {data.get('streamUrl')}")
        log(f"   - startOffset: {data.get('startOffset')}")
        log(f"   - sourceDuration: {data.get('sourceDuration')}")
        log(f"   - audioStreams count: {len(data.get('audioStreams', []))}")
        log(f"   - selectedAudioIndex: {data.get('selectedAudioIndex')}")
        
        return data.get('streamUrl')
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return None

def test_fast_path_audio_switch(source_url):
    """B. Fast-path with different audioIndex"""
    log("\n" + "=" * 80)
    log("TEST B2: Fast-path audio switch (audioIndex=1)")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/stream/hls/session"
        payload = {
            "sourceUrl": source_url,
            "start": 60,
            "audioIndex": 1,
            "quality": "1080p"
        }
        
        log(f"POST {url}")
        log(f"Payload: {json.dumps(payload, indent=2)}")
        
        start = time.time()
        resp = requests.post(url, json=payload, timeout=30)
        elapsed = time.time() - start
        elapsed_ms = elapsed * 1000
        
        log(f"Status: {resp.status_code}, Time: {elapsed_ms:.0f}ms")
        
        if resp.status_code != 200:
            log(f"❌ FAILED: Expected 200, got {resp.status_code}")
            log(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        
        if not data.get('success'):
            log(f"❌ FAILED: success is not true")
            return False
        
        # Check response time
        if elapsed_ms > 1000:
            log(f"⚠️  WARNING: Response time {elapsed_ms:.0f}ms > 1000ms (expected fast path)")
        else:
            log(f"✅ Fast path confirmed: {elapsed_ms:.0f}ms < 1000ms")
        
        # selectedAudioIndex should be 1 if source has multiple tracks, else fallback
        selected_idx = data.get('selectedAudioIndex')
        audio_count = len(data.get('audioStreams', []))
        
        if audio_count > 1 and selected_idx != 1:
            log(f"⚠️  WARNING: Expected selectedAudioIndex=1 (multi-audio source), got {selected_idx}")
        elif audio_count == 1 and selected_idx != 0:
            log(f"⚠️  WARNING: Expected selectedAudioIndex=0 (single-audio fallback), got {selected_idx}")
        
        log(f"✅ PASSED: Fast-path audio switch returned valid response")
        log(f"   - selectedAudioIndex: {selected_idx} (audio tracks: {audio_count})")
        
        return True
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_fast_path_out_of_bounds(source_url):
    """B. Fast-path with out-of-bounds audioIndex"""
    log("\n" + "=" * 80)
    log("TEST B3: Fast-path out-of-bounds audioIndex (audioIndex=99)")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/stream/hls/session"
        payload = {
            "sourceUrl": source_url,
            "start": 60,
            "audioIndex": 99,
            "quality": "1080p"
        }
        
        log(f"POST {url}")
        
        start = time.time()
        resp = requests.post(url, json=payload, timeout=30)
        elapsed = time.time() - start
        elapsed_ms = elapsed * 1000
        
        log(f"Status: {resp.status_code}, Time: {elapsed_ms:.0f}ms")
        
        if resp.status_code != 200:
            log(f"❌ FAILED: Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        if not data.get('success'):
            log(f"❌ FAILED: success is not true")
            return False
        
        # Should fall back to cached default, not crash
        selected_idx = data.get('selectedAudioIndex')
        if selected_idx == 99:
            log(f"❌ FAILED: selectedAudioIndex should fall back, not use out-of-bounds 99")
            return False
        
        log(f"✅ PASSED: Out-of-bounds audioIndex handled gracefully")
        log(f"   - selectedAudioIndex: {selected_idx} (fallback)")
        
        return True
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_fast_path_negative(source_url):
    """B. Fast-path with negative audioIndex"""
    log("\n" + "=" * 80)
    log("TEST B4: Fast-path negative audioIndex (audioIndex=-1)")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/stream/hls/session"
        payload = {
            "sourceUrl": source_url,
            "start": 60,
            "audioIndex": -1,
            "quality": "1080p"
        }
        
        log(f"POST {url}")
        
        start = time.time()
        resp = requests.post(url, json=payload, timeout=30)
        elapsed = time.time() - start
        elapsed_ms = elapsed * 1000
        
        log(f"Status: {resp.status_code}, Time: {elapsed_ms:.0f}ms")
        
        if resp.status_code != 200:
            log(f"❌ FAILED: Expected 200, got {resp.status_code}")
            return False
        
        data = resp.json()
        
        if not data.get('success'):
            log(f"❌ FAILED: success is not true")
            return False
        
        # Should fall back to cached default
        selected_idx = data.get('selectedAudioIndex')
        log(f"✅ PASSED: Negative audioIndex handled gracefully")
        log(f"   - selectedAudioIndex: {selected_idx} (fallback)")
        
        return True
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_playlist_after_fast_path(stream_url):
    """C. Playlist GET after fast-path POST"""
    log("\n" + "=" * 80)
    log("TEST C: Playlist GET after fast-path POST")
    log("=" * 80)
    
    try:
        url = f"{BASE_URL}{stream_url}"
        log(f"GET {url}")
        
        start = time.time()
        resp = requests.get(url, timeout=30)
        elapsed = time.time() - start
        
        log(f"Status: {resp.status_code}, Time: {elapsed:.2f}s")
        
        if resp.status_code != 200:
            log(f"❌ FAILED: Expected 200, got {resp.status_code}")
            log(f"Response: {resp.text[:500]}")
            return False
        
        content_type = resp.headers.get('Content-Type', '')
        if 'application/vnd.apple.mpegurl' not in content_type:
            log(f"⚠️  WARNING: Expected Content-Type with 'application/vnd.apple.mpegurl', got '{content_type}'")
        
        body = resp.text
        
        # Verify HLS playlist structure
        if not body.startswith('#EXTM3U'):
            log(f"❌ FAILED: Playlist doesn't start with #EXTM3U")
            return False
        
        if '#EXT-X-PLAYLIST-TYPE:VOD' not in body and '#EXT-X-PLAYLIST-TYPE:EVENT' not in body:
            log(f"❌ FAILED: Playlist missing #EXT-X-PLAYLIST-TYPE")
            return False
        
        # Count segments
        import re
        segments = re.findall(r'seg_\d+\.ts', body)
        if not segments:
            log(f"❌ FAILED: No segments found in playlist")
            return False
        
        log(f"✅ PASSED: Playlist served correctly after fast-path POST")
        log(f"   - Content-Type: {content_type}")
        log(f"   - Segments: {len(segments)}")
        log(f"   - First 5 lines:")
        for line in body.split('\n')[:5]:
            log(f"     {line}")
        
        return True
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_validation_invalid_url():
    """E. Validation - invalid sourceUrl"""
    log("\n" + "=" * 80)
    log("TEST E1: Validation - invalid sourceUrl (not Comet)")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/stream/hls/session"
        payload = {
            "sourceUrl": "https://example.com/foo.mp4",
            "start": 60,
            "audioIndex": 0
        }
        
        log(f"POST {url}")
        
        resp = requests.post(url, json=payload, timeout=10)
        
        log(f"Status: {resp.status_code}")
        
        if resp.status_code != 400:
            log(f"❌ FAILED: Expected 400, got {resp.status_code}")
            return False
        
        data = resp.json()
        error_msg = data.get('error', '')
        
        if 'Comet' not in error_msg and 'playback' not in error_msg:
            log(f"⚠️  WARNING: Error message doesn't mention Comet/playback: {error_msg}")
        
        log(f"✅ PASSED: Invalid sourceUrl rejected with 400")
        log(f"   - Error: {error_msg}")
        
        return True
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_validation_missing_url():
    """E. Validation - missing sourceUrl"""
    log("\n" + "=" * 80)
    log("TEST E2: Validation - missing sourceUrl")
    log("=" * 80)
    
    try:
        url = f"{API_BASE}/stream/hls/session"
        payload = {
            "start": 60,
            "audioIndex": 0
        }
        
        log(f"POST {url}")
        
        resp = requests.post(url, json=payload, timeout=10)
        
        log(f"Status: {resp.status_code}")
        
        if resp.status_code != 400:
            log(f"❌ FAILED: Expected 400, got {resp.status_code}")
            return False
        
        log(f"✅ PASSED: Missing sourceUrl rejected with 400")
        
        return True
        
    except Exception as e:
        log(f"❌ EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return False

def check_server_logs():
    """Check server logs for fast-path confirmation"""
    log("\n" + "=" * 80)
    log("Checking server logs for fast-path evidence")
    log("=" * 80)
    
    try:
        # Check Next.js logs
        result = os.popen('tail -n 100 /var/log/supervisor/nextjs.*.log 2>/dev/null | grep -i "FAST PATH" | tail -5').read()
        
        if result.strip():
            log("✅ Found FAST PATH log entries:")
            for line in result.strip().split('\n'):
                log(f"   {line}")
            return True
        else:
            log("⚠️  No FAST PATH log entries found (may be expected if logs rotated)")
            return True
        
    except Exception as e:
        log(f"⚠️  Could not check logs: {e}")
        return True

def main():
    log("Starting Phase 4 Hotfix Issue 2 backend tests")
    log(f"Backend URL: {BASE_URL}")
    
    results = {
        'total': 0,
        'passed': 0,
        'failed': 0
    }
    
    # A. Resolver regression check
    results['total'] += 1
    direct_url = test_resolver_regression()
    if direct_url:
        results['passed'] += 1
    else:
        results['failed'] += 1
        log("\n❌ CRITICAL: Resolver test failed, cannot continue with fast-path tests")
        print_summary(results)
        sys.exit(1)
    
    # B. Fast-path verification
    results['total'] += 1
    stream_url = test_fast_path_basic(direct_url)
    if stream_url:
        results['passed'] += 1
    else:
        results['failed'] += 1
    
    results['total'] += 1
    if test_fast_path_audio_switch(direct_url):
        results['passed'] += 1
    else:
        results['failed'] += 1
    
    results['total'] += 1
    if test_fast_path_out_of_bounds(direct_url):
        results['passed'] += 1
    else:
        results['failed'] += 1
    
    results['total'] += 1
    if test_fast_path_negative(direct_url):
        results['passed'] += 1
    else:
        results['failed'] += 1
    
    # C. Playlist GET after fast-path POST
    if stream_url:
        results['total'] += 1
        if test_playlist_after_fast_path(stream_url):
            results['passed'] += 1
        else:
            results['failed'] += 1
    
    # E. Validation tests
    results['total'] += 1
    if test_validation_invalid_url():
        results['passed'] += 1
    else:
        results['failed'] += 1
    
    results['total'] += 1
    if test_validation_missing_url():
        results['passed'] += 1
    else:
        results['failed'] += 1
    
    # Check logs
    check_server_logs()
    
    print_summary(results)
    
    if results['failed'] > 0:
        sys.exit(1)
    else:
        sys.exit(0)

def print_summary(results):
    log("\n" + "=" * 80)
    log("TEST SUMMARY")
    log("=" * 80)
    log(f"Total tests: {results['total']}")
    log(f"Passed: {results['passed']}")
    log(f"Failed: {results['failed']}")
    
    if results['failed'] == 0:
        log("\n✅ ALL TESTS PASSED")
    else:
        log(f"\n❌ {results['failed']} TEST(S) FAILED")

if __name__ == '__main__':
    main()
