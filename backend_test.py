#!/usr/bin/env python3
"""
HLS Streaming Backend Tests
Tests the Real-Debrid HLS streaming flow:
  /api/realdebrid/resolve → /api/stream/hls/<sessionId>/<file>
"""

import requests
import time
import re
import sys

BASE_URL = "http://localhost:3000"
TIMEOUT_SHORT = 10
TIMEOUT_LONG = 60

def print_test(num, desc):
    print(f"\n{'='*70}")
    print(f"TEST #{num}: {desc}")
    print('='*70)

def print_pass(msg):
    print(f"✅ PASS: {msg}")

def print_fail(msg):
    print(f"❌ FAIL: {msg}")

def test_1_resolver_movie():
    """Test 1: Resolver shape (movie)"""
    print_test(1, "Resolver shape (movie) - Fight Club")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie&imdb=tt0137523"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        print(f"Response keys: {list(data.keys())}")
        
        # Check success
        if not data.get('success'):
            print_fail(f"success is not true: {data.get('success')}")
            return False
        print_pass("success === true")
        
        # Check streamType
        if data.get('streamType') != 'hls':
            print_fail(f"streamType is not 'hls': {data.get('streamType')}")
            return False
        print_pass("streamType === 'hls'")
        
        # Check streamUrl pattern
        stream_url = data.get('streamUrl', '')
        pattern = r'^/api/stream/hls/[a-f0-9]{16}/index\.m3u8$'
        if not re.match(pattern, stream_url):
            print_fail(f"streamUrl doesn't match pattern: {stream_url}")
            return False
        print_pass(f"streamUrl matches pattern: {stream_url}")
        
        # Check quality contains [RD⚡]
        quality = data.get('quality', '')
        if '[RD⚡]' not in quality:
            print_fail(f"quality doesn't contain '[RD⚡]': {quality}")
            return False
        print_pass(f"quality contains '[RD⚡]': {quality[:100]}")
        
        # Check filename ends with .mp4
        filename = data.get('filename', '')
        if not filename.endswith('.mp4'):
            print_fail(f"filename doesn't end with .mp4: {filename}")
            return False
        print_pass(f"filename ends with .mp4: {filename[:80]}")
        
        # Check alternates is an array
        alternates = data.get('alternates', [])
        if not isinstance(alternates, list):
            print_fail(f"alternates is not an array: {type(alternates)}")
            return False
        if len(alternates) > 5:
            print_fail(f"alternates has more than 5 items: {len(alternates)}")
            return False
        print_pass(f"alternates is array with {len(alternates)} items (0-5)")
        
        # Check each alternate has hls streamUrl
        for i, alt in enumerate(alternates):
            alt_url = alt.get('streamUrl', '')
            if not re.match(pattern, alt_url):
                print_fail(f"alternate[{i}] streamUrl doesn't match pattern: {alt_url}")
                return False
        print_pass(f"All alternates have valid HLS streamUrl")
        
        print_pass("TEST 1 PASSED - All checks successful")
        return True, stream_url
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_2_resolver_tv():
    """Test 2: Resolver shape (TV)"""
    print_test(2, "Resolver shape (TV) - Game of Thrones S01E01")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=tv&imdb=tt0944947&season=1&episode=1"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        data = resp.json()
        
        # Same checks as test 1
        checks = [
            (data.get('success') == True, "success === true"),
            (data.get('streamType') == 'hls', "streamType === 'hls'"),
            (re.match(r'^/api/stream/hls/[a-f0-9]{16}/index\.m3u8$', data.get('streamUrl', '')), "streamUrl matches pattern"),
            ('[RD⚡]' in data.get('quality', ''), "quality contains '[RD⚡]'"),
            (isinstance(data.get('alternates', []), list), "alternates is array"),
        ]
        
        for check, desc in checks:
            if not check:
                print_fail(desc)
                return False
            print_pass(desc)
        
        print_pass("TEST 2 PASSED - TV resolver working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_3_resolver_error():
    """Test 3: Resolver error handling"""
    print_test(3, "Resolver error - missing imdb parameter")
    
    try:
        url = f"{BASE_URL}/api/realdebrid/resolve?type=movie"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 400:
            print_fail(f"Expected 400, got {resp.status_code}")
            return False
        
        print_pass("TEST 3 PASSED - Returns 400 for missing parameters")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        return False

def test_4_hls_playlist_cold_start(stream_url):
    """Test 4: HLS playlist cold start"""
    print_test(4, "HLS playlist cold start - ffmpeg spawn")
    
    try:
        url = f"{BASE_URL}{stream_url}"
        print(f"GET {url}")
        print(f"Waiting up to 60s for ffmpeg cold start...")
        
        start_time = time.time()
        resp = requests.get(url, timeout=TIMEOUT_LONG)
        elapsed = time.time() - start_time
        
        print(f"Status: {resp.status_code}")
        print(f"Elapsed time: {elapsed:.2f}s")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        # Check Content-Type
        content_type = resp.headers.get('Content-Type', '')
        if 'application/vnd.apple.mpegurl' not in content_type:
            print_fail(f"Wrong Content-Type: {content_type}")
            return False
        print_pass(f"Content-Type: {content_type}")
        
        # Check body starts with #EXTM3U
        body = resp.text
        if not body.startswith('#EXTM3U'):
            print_fail(f"Body doesn't start with #EXTM3U: {body[:100]}")
            return False
        print_pass("Body starts with #EXTM3U")
        
        # Check for #EXT-X-PLAYLIST-TYPE:EVENT
        if '#EXT-X-PLAYLIST-TYPE:EVENT' not in body:
            print_fail("Missing #EXT-X-PLAYLIST-TYPE:EVENT")
            return False
        print_pass("Contains #EXT-X-PLAYLIST-TYPE:EVENT")
        
        # Check for at least one segment
        if 'seg_00000.ts' not in body:
            print_fail("Missing seg_00000.ts")
            return False
        print_pass("Contains seg_00000.ts")
        
        # Check for #EXTINF
        if '#EXTINF:' not in body:
            print_fail("Missing #EXTINF:")
            return False
        print_pass("Contains #EXTINF:")
        
        # Count segments
        seg_count = len(re.findall(r'seg_\d+\.ts', body))
        print_pass(f"Playlist contains {seg_count} segments")
        
        if elapsed > 20:
            print(f"⚠️  WARNING: Cold start took {elapsed:.2f}s (expected ~8-15s)")
        else:
            print_pass(f"Cold start completed in {elapsed:.2f}s")
        
        print_pass("TEST 4 PASSED - HLS playlist cold start working")
        
        # Extract session ID for next tests
        match = re.search(r'/api/stream/hls/([a-f0-9]{16})/index\.m3u8', stream_url)
        session_id = match.group(1) if match else None
        
        return True, session_id
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_5_hls_segment(session_id):
    """Test 5: HLS segment"""
    print_test(5, "HLS segment - seg_00000.ts")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/{session_id}/seg_00000.ts"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        # Check Content-Type
        content_type = resp.headers.get('Content-Type', '')
        if 'video/MP2T' not in content_type:
            print_fail(f"Wrong Content-Type: {content_type}")
            return False
        print_pass(f"Content-Type: {content_type}")
        
        # Check body size
        body = resp.content
        if len(body) < 100000:
            print_fail(f"Body too small: {len(body)} bytes (expected > 100,000)")
            return False
        print_pass(f"Body size: {len(body):,} bytes (> 100,000)")
        
        # Check first byte is 0x47 (MPEG-TS sync byte)
        if body[0] != 0x47:
            print_fail(f"First byte is not 0x47: {hex(body[0])}")
            return False
        print_pass(f"First byte is 0x47 (MPEG-TS sync byte)")
        
        print_pass("TEST 5 PASSED - HLS segment serving working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_6_hls_playlist_warm(stream_url):
    """Test 6: HLS playlist warm"""
    print_test(6, "HLS playlist warm - should be fast")
    
    try:
        print("Waiting 5 seconds for more segments to be generated...")
        time.sleep(5)
        
        url = f"{BASE_URL}{stream_url}"
        print(f"GET {url}")
        
        start_time = time.time()
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        elapsed = time.time() - start_time
        
        print(f"Status: {resp.status_code}")
        print(f"Elapsed time: {elapsed:.2f}s")
        
        if resp.status_code != 200:
            print_fail(f"Expected 200, got {resp.status_code}")
            return False
        
        if elapsed > 2:
            print_fail(f"Warm request took too long: {elapsed:.2f}s (expected < 2s)")
            return False
        print_pass(f"Warm request completed in {elapsed:.2f}s (< 2s)")
        
        # Count segments
        body = resp.text
        seg_count = len(re.findall(r'seg_\d+\.ts', body))
        print_pass(f"Playlist now contains {seg_count} segments")
        
        print_pass("TEST 6 PASSED - HLS playlist warm serving working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_7_bad_session_id():
    """Test 7: Bad session ID"""
    print_test(7, "Bad session ID - should return error")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/notavalidid/index.m3u8"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code >= 200 and resp.status_code < 300:
            print_fail(f"Expected non-2xx, got {resp.status_code}")
            return False
        
        print_pass(f"Returns non-2xx status: {resp.status_code}")
        print_pass("TEST 7 PASSED - Bad session ID rejected")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        return False

def test_8_bad_segment_name(session_id):
    """Test 8: Bad segment name (path traversal attempt)"""
    print_test(8, "Bad segment name - path traversal attempt")
    
    try:
        url = f"{BASE_URL}/api/stream/hls/{session_id}/etc%2Fpasswd"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code >= 200 and resp.status_code < 300:
            print_fail(f"Expected non-2xx, got {resp.status_code}")
            print(f"Response: {resp.text[:500]}")
            return False
        
        print_pass(f"Returns non-2xx status: {resp.status_code}")
        print_pass("TEST 8 PASSED - Path traversal blocked")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        return False

def test_9_legacy_proxy_regression():
    """Test 9: Legacy proxy regression"""
    print_test(9, "Legacy proxy regression - should return 403")
    
    try:
        url = f"{BASE_URL}/api/stream/proxy?url=https://example.com/foo.mp4"
        print(f"GET {url}")
        
        resp = requests.get(url, timeout=TIMEOUT_SHORT)
        print(f"Status: {resp.status_code}")
        
        if resp.status_code != 403:
            print_fail(f"Expected 403, got {resp.status_code}")
            return False
        
        print_pass("Returns 403 for non-whitelisted host")
        print_pass("TEST 9 PASSED - Legacy proxy security working")
        return True
        
    except Exception as e:
        print_fail(f"Exception: {e}")
        return False

def main():
    print("\n" + "="*70)
    print("HLS STREAMING BACKEND TESTS")
    print("="*70)
    
    results = {}
    
    # Test 1: Resolver movie
    result = test_1_resolver_movie()
    if isinstance(result, tuple):
        results[1] = result[0]
        stream_url = result[1]
    else:
        results[1] = result
        stream_url = None
    
    # Test 2: Resolver TV
    results[2] = test_2_resolver_tv()
    
    # Test 3: Resolver error
    results[3] = test_3_resolver_error()
    
    # Test 4: HLS playlist cold start (only if test 1 passed)
    session_id = None
    if results[1] and stream_url:
        result = test_4_hls_playlist_cold_start(stream_url)
        if isinstance(result, tuple):
            results[4] = result[0]
            session_id = result[1]
        else:
            results[4] = result
    else:
        print_test(4, "SKIPPED - Test 1 failed")
        results[4] = False
    
    # Test 5: HLS segment (only if test 4 passed)
    if results[4] and session_id:
        results[5] = test_5_hls_segment(session_id)
    else:
        print_test(5, "SKIPPED - Test 4 failed")
        results[5] = False
    
    # Test 6: HLS playlist warm (only if test 4 passed)
    if results[4] and stream_url:
        results[6] = test_6_hls_playlist_warm(stream_url)
    else:
        print_test(6, "SKIPPED - Test 4 failed")
        results[6] = False
    
    # Test 7: Bad session ID
    results[7] = test_7_bad_session_id()
    
    # Test 8: Bad segment name (only if we have a valid session_id)
    if session_id:
        results[8] = test_8_bad_segment_name(session_id)
    else:
        print_test(8, "SKIPPED - No valid session ID")
        results[8] = False
    
    # Test 9: Legacy proxy regression
    results[9] = test_9_legacy_proxy_regression()
    
    # Summary
    print("\n" + "="*70)
    print("TEST SUMMARY")
    print("="*70)
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for num in sorted(results.keys()):
        status = "✅ PASS" if results[num] else "❌ FAIL"
        print(f"Test {num}: {status}")
    
    print("="*70)
    print(f"TOTAL: {passed}/{total} tests passed")
    print("="*70)
    
    return 0 if passed == total else 1

if __name__ == '__main__':
    sys.exit(main())
